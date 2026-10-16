import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import pw from 'playwright-core';
import { environment } from '../util/fail.js';
import { collectGeometry } from './collect.js';

/**
 * Chrome, driven through playwright-core.
 *
 * `channel: 'chrome'` uses the Google Chrome ALREADY INSTALLED on the machine.
 * Nothing downloads a browser: playwright-core ships no binaries, and a tool
 * that pulled 150 MB on first run would be a tool the PO stops using.
 *
 * The media discipline is the load-bearing part. Chrome's PDF path renders
 * under PRINT media, so `emulateMedia({ media: 'print' })` is applied before
 * anything is measured. Without it the numbers in geometry.json describe a
 * screen layout and the PDF ships a different one - and every lint result
 * would be about a page that does not exist.
 *
 * @param {object} opts
 * @param {string} opts.url            file:// URL of the combined document
 * @param {string} opts.pdfPath
 * @param {any} opts.theme
 * @param {string[]} opts.allowedUrls  the EXACT file:// URLs this render may
 *   load: the document, the theme's fonts, and the imported assets. Anything
 *   else is refused and reported.
 * @returns {Promise<{geometry: any, warnings: string[]}>}
 */
export async function renderAndMeasure({ url, pdfPath, theme, allowedUrls = [] }) {
  /** @type {string[]} */
  const warnings = [];
  let browser;
  try {
    browser = await pw.chromium.launch({
      channel: 'chrome',
      // THE OS SANDBOX STAYS ON. playwright-core's default for a launched
      // Chrome is --no-sandbox, which removes the last barrier between a
      // renderer processing untrusted content and the rest of the machine.
      // deck renders content assembled from YAML the user may not have
      // written, so it opts back in explicitly.
      chromiumSandbox: true,
      args: [
        // No remote anything. A render must not depend on the network.
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--no-first-run',
        // WHY THIS FLAG IS NECESSARY, and it is not a convenience.
        //
        // The document is a file:// page under <deck>/out/html and the theme's
        // pinned font lives in the theme directory, which is not an ancestor
        // of it. Chrome refuses that cross-directory file:// subresource by
        // default - and it refuses SILENTLY: @font-face fails, the stack falls
        // through to the next family, document.fonts.ready resolves happily,
        // and the deck renders in whatever Japanese font the machine happens
        // to have. Measured here before the flag was added: text laid out in
        // Hiragino, whose em box is 1.44em against Noto Sans JP's 1.15em, so
        // every line box was 25% taller than the theme was calibrated for and
        // the first line pushed through the top margin.
        //
        // That is the precise failure the task warned about - Hiragino is on
        // this Mac and that is not a portable strategy - arriving through the
        // back door. The flag fixes the load; assertPinnedFontsLoaded below
        // makes certain that a future silent fallback is a loud failure rather
        // than a 25%-wrong layout.
        '--allow-file-access-from-files',
      ],
    });
  } catch (err) {
    environment('could not launch Google Chrome', [
      String(err && err.message ? err.message : err),
      'deck uses the installed Google Chrome via playwright-core\'s `channel: "chrome"`, and downloads no browser.',
      'Run `deck doctor` to see what it found.',
    ]);
  }

  try {
    const context = await browser.newContext({
      viewport: { width: theme.canvas.width, height: theme.canvas.height },
      deviceScaleFactor: 1,
      // NO PAGE-AUTHORED JAVASCRIPT.
      //
      // deck renders --allow-file-access-from-files, which it needs so a
      // file:// document can load the theme's font. The cost of that flag is
      // that any script which does reach the page can read local files and
      // put their contents into the exported PDF or into geometry.json.
      // Removing script execution removes the capability rather than trying
      // to out-escape it. Measured: page.evaluate still works (it runs
      // through the debugger, not the page's script context), so geometry
      // collection, document.fonts.ready and image decoding are unaffected.
      javaScriptEnabled: false,
      // Animations are already disabled in CSS; this closes the same door at
      // the browser level so a theme that forgets cannot reintroduce it.
      reducedMotion: 'reduce',
      offline: true,
    });

    // AN EXACT ALLOWLIST, not a scheme check.
    //
    // Permitting every file:// URL meant the only thing standing between a
    // crafted document and the local filesystem was the absence of a way to
    // request one. The render knows precisely which files it needs - the
    // document, the pinned fonts, the imported assets - so anything else is
    // refused and reported rather than reasoned about.
    const allowed = new Set(allowedUrls.map(normaliseUrl));
    /** @type {Set<string>} */
    const refused = new Set();
    await context.route('**/*', (route) => {
      const u = route.request().url();
      const key = normaliseUrl(u);
      if (u.startsWith('about:') || u === 'about:blank') return route.continue();
      if (allowed.has(key)) return route.continue();
      if (!refused.has(key)) {
        refused.add(key);
        warnings.push(`BLOCKED a resource this render did not declare: ${u}`);
      }
      return route.abort();
    });

    // WebSockets do not go through context.route at all, so the route handler
    // above is not a network boundary on its own. These close the remaining
    // outbound channels.
    context.on('weberror', (e) => warnings.push(`page error: ${e.error().message}`));
    await context.addInitScript(() => {
      // Belt and braces: with javaScriptEnabled:false nothing here can even be
      // reached from the page, but a future change that re-enables scripting
      // should not silently reopen the socket.
      const block = (name) => {
        Object.defineProperty(window, name, {
          configurable: false,
          get() { throw new Error(`${name} is not available in a deck render`); },
        });
      };
      for (const n of ['WebSocket', 'EventSource', 'RTCPeerConnection']) {
        try { block(n); } catch { /* already defined non-configurable */ }
      }
    }).catch(() => { /* init scripts are a no-op with JS disabled */ });

    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') warnings.push(`console error: ${msg.text()}`);
    });
    page.on('pageerror', (err) => warnings.push(`page error: ${err.message}`));
    page.on('requestfailed', (req) => {
      const u = req.url();
      if (!allowed.has(normaliseUrl(u)) && !u.startsWith('about:')) {
        warnings.push(`a blocked resource was requested and failed: ${u}`);
      }
    });

    // PRINT media first, then navigate, so the first layout is already the one
    // that will be exported.
    await page.emulateMedia({ media: 'print' });
    const response = await page.goto(url, { waitUntil: 'load' });

    // NAVIGATION AWAY FROM THE DOCUMENT IS A FAILURE.
    //
    // `<meta http-equiv="refresh">` navigates with JavaScript disabled - it
    // is the browser, not a script. The resource allowlist blocks the
    // request so nothing leaves the machine, but the page still tears itself
    // down, and the measurement then died with Chrome's own "Execution
    // context was destroyed", which says nothing useful about why.
    //
    // The navigation is recorded here and reported as what it is: the
    // document asked to become a different document, and deck will not
    // measure or publish whatever that turns out to be.
    /** @type {string[]} */
    const navigations = [];
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      const to = frame.url();
      // The handler is installed AFTER the initial load resolves, so any
      // event from here is a navigation away. `about:blank` is not exempt -
      // it is the commonest meta-refresh target and replacing the document
      // with a blank one is exactly the failure this catches.
      if (to === url) return;
      navigations.push(to);
    });

    /**
     * Run an in-page step, turning a navigation tear-down into a clear
     * refusal.
     *
     * Wraps EVERY step after the initial load, not just the measurement: the
     * font and image waits run first, so a meta refresh destroyed the context
     * there and produced Chrome's own opaque message before the measurement
     * was even reached.
     */
    const guarded = async (what, fn) => {
      try {
        return await fn();
      } catch (err) {
        const message = String(err && err.message ? err.message : err);
        if (navigations.length > 0 || /Execution context was destroyed|frame was detached|Target closed/i.test(message)) {
          environment('the document navigated away from itself during the render', [
            navigations.length > 0
              ? `it tried to become: ${navigations.join(', ')}`
              : 'the page replaced itself before it could be measured',
            'A meta refresh moves the page even with JavaScript disabled: it is the browser, not a script.',
            'Nothing was published, and the resource allowlist meant nothing was fetched.',
            '',
            `This happened while ${what}. Chrome reported: ${message}`,
          ]);
        }
        throw err;
      }
    };
    if (response && !response.ok() && response.status() !== 0) {
      warnings.push(`the document loaded with status ${response.status()}`);
    }

    // Fonts, then images. A measurement taken before document.fonts.ready
    // describes fallback metrics, and a measurement taken before images decode
    // describes a zero-height img.
    await guarded('waiting for fonts', () => page.evaluate(() => document.fonts.ready));
    const fontReport = await guarded('checking the pinned fonts', () => page.evaluate((families) => {
      const faces = [...document.fonts].map((f) => ({ family: f.family, status: f.status, weight: f.weight }));
      return {
        faces,
        checks: families.map((family) => ({
          family,
          // `check` answers "is a face for this family loaded and usable",
          // which is the question that matters. A declared-but-failed face is
          // present in document.fonts with status "error" or "unloaded".
          available: document.fonts.check(`700 25px "${family}"`),
        })),
      };
    }, theme.fonts.pinned.map((f) => f.family)));

    const unavailable = fontReport.checks.filter((c) => !c.available).map((c) => c.family);
    const notLoaded = fontReport.faces.filter((f) => f.status !== 'loaded');
    if (unavailable.length > 0 || notLoaded.length > 0) {
      // A FAILED FONT IS A FAILED RENDER, not a warning.
      //
      // Falling back is worse than stopping: the deck still looks plausible,
      // the PDF still has the right words in it, and every measured line box
      // is wrong by whatever the fallback font's metrics happen to be - on a
      // machine whose fonts the next person does not have.
      environment('the theme\'s pinned font did not load, so the deck would have been laid out in a fallback font', [
        ...(unavailable.length ? [`unavailable families: ${unavailable.join(', ')}`] : []),
        ...notLoaded.map((f) => `@font-face "${f.family}" weight ${f.weight} is "${f.status}", not "loaded"`),
        '',
        'deck refuses to render in a font the theme was not calibrated against: every size band and every',
        'measured gap in the theme describes the pinned font, and a fallback would be silently wrong.',
      ]);
    }
    const imageProblems = await guarded('waiting for images to decode', () => page.evaluate(async () => {
      const imgs = Array.from(document.images);
      await Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((res) => {
        img.addEventListener('load', res, { once: true });
        img.addEventListener('error', res, { once: true });
      }))));
      return imgs
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute('src'));
    }));
    for (const src of imageProblems) {
      warnings.push(`an image failed to decode and will render as empty space: ${src}`);
    }

    const geometry = await guarded('measuring the page', () => page.evaluate(collectGeometry));
    if (navigations.length > 0) {
      environment('the document navigated away from itself during the render', [
        `it tried to become: ${navigations.join(', ')}`,
        'deck will not measure or publish a page that replaces itself mid-render.',
      ]);
    }
    geometry.fonts = fontReport;

    if (pdfPath) {
      // THE PDF STEP IS GUARDED TOO, AND CHECKED AFTERWARDS.
      //
      // `page.pdf` used to sit outside the guard with the navigation check
      // BEFORE it, so a delayed refresh firing during PDF generation escaped
      // entirely: no diagnostic, and the printed document is not the one
      // that was measured - which would make every measurement in the run
      // describe a page that is not the page delivered.
      await guarded('generating the PDF', () => page.pdf({
        path: pdfPath,
        width: `${theme.canvas.width}px`,
        height: `${theme.canvas.height}px`,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
        printBackground: true,
        preferCSSPageSize: true,
        scale: 1,
      }));

      // A POSITIVE CHECK, not just the absence of an error. A navigation that
      // completed cleanly between the measurement and the print would leave
      // page.pdf working perfectly on the WRONG document. Re-reading the
      // document's identity is the only way to know the thing printed is the
      // thing measured.
      const after = await guarded('confirming the document after printing', () => page.evaluate(() => ({
        href: location.href,
        canvases: document.querySelectorAll('[data-deck-canvas]').length,
        slideIds: Array.from(document.querySelectorAll('[data-deck-canvas]'))
          .map((c) => c.getAttribute('data-deck-slide-id')),
      })));

      const measuredIds = geometry.slides.map((s) => s.slide_id);
      if (after.canvases !== measuredIds.length
          || after.slideIds.join('\u0000') !== measuredIds.join('\u0000')) {
        environment('the document changed between being measured and being printed', [
          `measured: ${measuredIds.length} slide(s) - ${measuredIds.join(', ')}`,
          `after printing: ${after.canvases} canvas(es) - ${after.slideIds.join(', ') || '(none)'}`,
          `the page is now at: ${after.href}`,
          'The PDF was printed from a different document than the one deck measured, so the geometry describes a page that was not delivered. Nothing was published.',
        ]);
      }
    }

    if (navigations.length > 0) {
      environment('the document navigated away from itself during the render', [
        `it tried to become: ${navigations.join(', ')}`,
        'deck will not publish a PDF printed from a page that replaced itself.',
      ]);
    }

    await context.close();
    return { geometry, warnings };
  } finally {
    await browser.close();
  }
}

/**
 * Compare URLs by their decoded path, so two spellings of the same file do
 * not slip past the allowlist or trip it unnecessarily.
 * @param {string} u
 */
function normaliseUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'file:') return parsed.href;
    return `file://${decodeURIComponent(parsed.pathname)}`;
  } catch {
    return u;
  }
}

/**
 * Candidate locations of a real, user-installed Chrome, by platform. Reported
 * by `deck doctor` so the PO can see WHICH Chrome deck is driving.
 */
const INSTALLED_CHROME = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    `${process.env.HOME || ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

/**
 * What `deck doctor` needs to know about Chrome, without rendering anything.
 *
 * DELIBERATELY NOT `chromium.executablePath({ channel: 'chrome' })`. Measured
 * on playwright-core 1.64.0: that call ignores the channel and returns the
 * path of a BUNDLED "Google Chrome for Testing" build - a path that need not
 * even exist on disk. Reporting it would tell the PO deck is driving a
 * downloaded browser when it is not. The channel is resolved by Chrome's own
 * installation lookup at launch time, so what is reported here is the launched
 * VERSION plus the installed binary found on disk, and whether the two agree.
 *
 * @returns {Promise<{ok: boolean, version: string | null, problem: string | null, installed_path: string | null, installed_version: string | null, matches_installed: boolean | null}>}
 */
export async function probeChrome() {
  const installedPath = (INSTALLED_CHROME[process.platform] || []).find((f) => f && fs.existsSync(f)) || null;
  let installedVersion = null;
  if (installedPath) {
    try {
      const out = execFileSync(installedPath, ['--version'], { encoding: 'utf8' });
      installedVersion = out.replace(/^Google Chrome\s*/i, '').trim();
    } catch {
      // A Chrome that will not answer --version can still launch; this is
      // informational only.
    }
  }

  let browser;
  try {
    browser = await pw.chromium.launch({ channel: 'chrome', chromiumSandbox: true });
    const version = browser.version();
    return {
      ok: true,
      version,
      problem: null,
      installed_path: installedPath,
      installed_version: installedVersion,
      matches_installed: installedVersion === null ? null : installedVersion === version,
    };
  } catch (err) {
    return {
      ok: false,
      version: null,
      problem: String(err && err.message ? err.message : err),
      installed_path: installedPath,
      installed_version: installedVersion,
      matches_installed: null,
    };
  } finally {
    if (browser) await browser.close();
  }
}
