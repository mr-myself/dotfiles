import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { DECK_BIN, DECK_HOME, rm, tempDir, gateArgs } from '../helpers.js';

process.env.DECK_HOME = DECK_HOME;

/**
 * ADVERSARIAL RENDERING.
 *
 * The shell suite's curl/wget stubs prove deck's own process makes no network
 * call; they say nothing about what CHROME does, and Chrome is the part that
 * processes untrusted content. These drive the real pipeline with hostile
 * deck.yaml overrides and watch what the browser actually does.
 */

/** A deck workspace with deck.yaml overrides appended. */
function workspace(overridesYaml = '') {
  const root = tempDir('deck-adv');
  const state = tempDir('deck-adv-state');
  const dir = path.join(root, 'deck');
  const run = (args, cwd = dir) => {
    try {
      return { code: 0, stdout: execFileSync(DECK_BIN, gateArgs(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_STATE_ROOT: state } }), stderr: '' };
    } catch (err) {
      return { code: err.status ?? -1, stdout: err.stdout || '', stderr: err.stderr || '' };
    }
  };
  const init = run(['init', dir], root);
  assert.equal(init.code, 0, init.stderr);
  if (overridesYaml) {
    fs.appendFileSync(path.join(dir, 'deck.yaml'), `\n${overridesYaml}\n`);
  }
  return { root, dir, state, run, cleanup: () => { rm(root); rm(state); } };
}

test('A STYLE-ELEMENT BREAKOUT IN A FONT NAME IS NEUTRALISED', () => {
  // Reproduced by review: a fonts.stack entry containing
  // `</style><script>...</script><style>` survived schema validation and font
  // verification and reached the document.
  const w = workspace([
    'theme_overrides:',
    '  fonts:',
    '    stack:',
    '      - \'Evil</style><script>document.title="PWNED"</script><style>\'',
    '      - sans-serif',
  ].join('\n'));
  try {
    const r = w.run(['render', '--html-only']);
    assert.equal(r.code, 0, r.stderr);
    const html = fs.readFileSync(path.join(w.dir, 'out', 'html', '_deck.html'), 'utf8');
    assert.ok(!html.includes('</style><script>'), 'the stylesheet must not be terminable');
    assert.ok(!html.includes('document.title="PWNED"'), 'the payload must not appear as markup');
    // `<` is emitted as the CSS hex escape `\3c ` (space-terminated).
    assert.match(html, /\\3c /, 'the dangerous characters must be CSS hex escapes');
    assert.match(html, /--deck-font-stack: "Evil/, 'the family name is still quoted and present');
  } finally {
    w.cleanup();
  }
});

test('AN ATTRIBUTE BREAKOUT IN SLOT GEOMETRY IS REFUSED', () => {
  // Reproduced by review: a slot geometry `left` of
  // `0px"><img src=x onerror=...><div z="` escaped the style attribute.
  const w = workspace([
    'theme_overrides:',
    '  page_types:',
    '    cover:',
    '      composition: x',
    '      slots:',
    '        cover-art:',
    '          left: \'0px"><img src=x onerror=alert(1)><div z="\'',
    '          top: 0',
  ].join('\n'));
  try {
    const r = w.run(['render', '--html-only']);
    assert.equal(r.code, 1, 'a non-numeric length must be a refusal, not a render');
    assert.match(r.stderr, /must be a plain number/);
    assert.ok(!fs.existsSync(path.join(w.dir, 'out', 'html', '_deck.html')),
      'nothing may be published from a refused render');
  } finally {
    w.cleanup();
  }
});

test('A COLOUR TOKEN CANNOT CARRY A DECLARATION', () => {
  const w = workspace([
    'theme_overrides:',
    '  colors:',
    '    page_bg: { hex: "#fff;}</style><script>x</script><style>a{", use: "evil" }',
  ].join('\n'));
  try {
    const r = w.run(['render', '--html-only']);
    assert.equal(r.code, 1);
    assert.ok(/#rrggbb colour|theme schema/.test(r.stderr), r.stderr);
  } finally {
    w.cleanup();
  }
});

test('PAGE-AUTHORED JAVASCRIPT DOES NOT RUN', async () => {
  // deck renders with --allow-file-access-from-files, which a script could
  // use to read local files into the PDF. The capability is removed rather
  // than out-escaped: javaScriptEnabled is false.
  const pw = (await import('playwright-core')).default;
  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');

  const dir = tempDir('deck-js');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET-SENTINEL');
  const htmlFile = path.join(dir, 'page.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><head><style>
    .c { width:${theme.canvas.width}px; height:${theme.canvas.height}px }
  </style></head><body>
    <div class="c" data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement">
      <div data-deck-id="probe">before</div>
    </div>
    <script>
      document.querySelector('[data-deck-id=probe]').textContent = 'SCRIPT RAN';
      fetch('file://${secret}').then(r => r.text()).then(t => {
        document.querySelector('[data-deck-id=probe]').textContent = t;
      });
    </script>
  </body></html>`);

  try {
    const { geometry, warnings } = await renderAndMeasure({
      url: `file://${htmlFile}`,
      pdfPath: path.join(dir, 'out.pdf'),
      theme,
      allowedUrls: [`file://${htmlFile}`],
    });
    const probe = geometry.slides[0].elements.find((e) => e.id === 'probe');
    assert.equal(probe.text, 'before', 'the page script must not have run');
    assert.ok(!JSON.stringify(geometry).includes('SECRET-SENTINEL'),
      'no local file content may reach the geometry');
    const pdf = fs.readFileSync(path.join(dir, 'out.pdf'), 'latin1');
    assert.ok(!pdf.includes('SECRET-SENTINEL'), 'no local file content may reach the PDF');
    assert.ok(!pdf.includes('SCRIPT RAN'));
    void warnings;
    void pw;
  } finally {
    rm(dir);
  }
});

test('AN UNDECLARED LOCAL FILE IS BLOCKED AND REPORTED', async () => {
  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');

  const dir = tempDir('deck-allow');
  const other = path.join(dir, 'not-declared.png');
  // A 1x1 PNG, so the only reason it fails to load is the allowlist.
  fs.writeFileSync(other, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ));
  const htmlFile = path.join(dir, 'page.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><body>
    <div data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement" style="width:${theme.canvas.width}px;height:${theme.canvas.height}px">
      <img src="file://${other}" data-deck-id="sneaky">
    </div></body></html>`);

  try {
    const { warnings } = await renderAndMeasure({
      url: `file://${htmlFile}`,
      pdfPath: path.join(dir, 'out.pdf'),
      theme,
      allowedUrls: [`file://${htmlFile}`],
    });
    assert.ok(warnings.some((w) => /BLOCKED a resource this render did not declare/.test(w)),
      `expected a block warning, got: ${JSON.stringify(warnings)}`);
    assert.ok(warnings.some((w) => /not-declared\.png/.test(w)));
  } finally {
    rm(dir);
  }
});

test('AN OUTBOUND HTTP REQUEST NEVER REACHES A LISTENING SERVER', async () => {
  // A real local server, so this tests Chrome's behaviour rather than DNS
  // failing. Nothing deck renders may call out: a render whose output
  // depends on a server is not reproducible.
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/css' });
    res.end('body{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');
  const dir = tempDir('deck-net');
  const htmlFile = path.join(dir, 'page.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><head>
    <link rel="stylesheet" href="http://127.0.0.1:${port}/evil.css">
    <style>@import url("http://127.0.0.1:${port}/imported.css");</style>
  </head><body>
    <div data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement" style="width:${theme.canvas.width}px;height:${theme.canvas.height}px">
      <img src="http://127.0.0.1:${port}/evil.png" data-deck-id="remote">
    </div></body></html>`);

  try {
    const { warnings } = await renderAndMeasure({
      url: `file://${htmlFile}`,
      pdfPath: path.join(dir, 'out.pdf'),
      theme,
      allowedUrls: [`file://${htmlFile}`],
    });
    assert.deepEqual(hits, [], `the server was contacted: ${JSON.stringify(hits)}`);
    assert.ok(warnings.some((w) => /BLOCKED/.test(w)), JSON.stringify(warnings));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rm(dir);
  }
});

test('A WEBSOCKET ATTEMPT NEVER REACHES A LISTENING SERVER', async () => {
  // context.route does not see WebSockets at all, so the route handler is not
  // a network boundary on its own. With page JS disabled there is no way to
  // open one; this asserts that end to end rather than by reasoning.
  /** @type {number} */
  let upgrades = 0;
  const server = http.createServer((_req, res) => { res.end('ok'); });
  server.on('upgrade', () => { upgrades += 1; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');
  const dir = tempDir('deck-ws');
  const htmlFile = path.join(dir, 'page.html');
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><body>
    <div data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement" style="width:${theme.canvas.width}px;height:${theme.canvas.height}px">x</div>
    <script>new WebSocket('ws://127.0.0.1:${port}/exfil');</script>
  </body></html>`);

  try {
    await renderAndMeasure({
      url: `file://${htmlFile}`,
      pdfPath: path.join(dir, 'out.pdf'),
      theme,
      allowedUrls: [`file://${htmlFile}`],
    });
    assert.equal(upgrades, 0, 'a WebSocket upgrade reached the server');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rm(dir);
  }
});


test('RAW THEME CSS CANNOT BREAK OUT OF THE PUBLISHED HTML', () => {
  // The sanitisers covered the GENERATED parts of the stylesheet. The
  // theme's own deck.css went in raw, and a `</style>` in it escaped into
  // out/html/<slide>.html - a file deck hands over and a person opens.
  // Disabling JavaScript protects the automated render, not that reader.
  const root = tempDir('rawcss');
  const state = tempDir('rawcss-state');
  const dir = path.join(root, 'deck');
  const themeDir = path.join(root, 'eviltheme');
  try {
    fs.cpSync(path.join(DECK_HOME, 'themes', 'watercolor'), themeDir, { recursive: true });
    fs.appendFileSync(path.join(themeDir, 'deck.css'),
      '\n/* */</style><script>window.__PWNED=1</script><style>\n');

    const run = (args, cwd = dir) => {
      try {
        return { code: 0, stdout: execFileSync(DECK_BIN, gateArgs(args), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_STATE_ROOT: state } }), stderr: '' };
      } catch (err) { return { code: err.status ?? -1, stdout: err.stdout || '', stderr: err.stderr || '' }; }
    };
    assert.equal(run(['init', dir], root).code, 0);
    fs.appendFileSync(path.join(dir, 'deck.yaml'), `\ntheme_overrides: {}\n`);
    const deckYaml = path.join(dir, 'deck.yaml');
    fs.writeFileSync(deckYaml, fs.readFileSync(deckYaml, 'utf8').replace('theme: watercolor', `theme: ${themeDir}`));

    const r = run(['render', '--html-only']);
    assert.notEqual(r.code, 0, 'a stylesheet that can terminate its own element must be refused');
    assert.match(r.stderr, /could terminate the stylesheet or start markup/);

    // And nothing was published.
    const htmlDir = path.join(dir, 'out', 'html');
    if (fs.existsSync(htmlDir)) {
      for (const f of fs.readdirSync(htmlDir)) {
        const text = fs.readFileSync(path.join(htmlDir, f), 'utf8');
        assert.ok(!text.includes('__PWNED'), `${f} carries the payload`);
      }
    }
  } finally {
    rm(root); rm(state);
  }
});

test('SVG, IFRAME, OBJECT, EMBED, META REFRESH AND PREFETCH REACH NOTHING', async () => {
  // context.route sees ordinary subresources. These are the routes that
  // historically bypass such a check, so they are driven against a real
  // listening server rather than reasoned about.
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('x');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');
  const dir = tempDir('iso');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'LOCAL SECRET');
  const htmlFile = path.join(dir, 'page.html');
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><head>
    <meta http-equiv="refresh" content="0; url=${base}/refresh">
    <link rel="prefetch" href="${base}/prefetch">
    <link rel="preload" as="image" href="${base}/preload">
    <link rel="dns-prefetch" href="${base}">
  </head><body>
    <div data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement"
         style="width:${theme.canvas.width}px;height:${theme.canvas.height}px">
      <div data-deck-id="probe">visible</div>
      <iframe src="${base}/iframe"></iframe>
      <iframe src="file://${secret}"></iframe>
      <object data="${base}/object"></object>
      <embed src="${base}/embed">
      <svg><image href="${base}/svg-image"></image>
        <use href="${base}/svg-use"></use></svg>
      <div style="background-image:url('${base}/css-bg')">x</div>
      <div style="background-image:url('file://${secret}')">y</div>
    </div></body></html>`);

  try {
    // A meta refresh navigates even with JavaScript disabled - it is the
    // browser, not a script - so this page replaces itself and the render is
    // REFUSED. What matters is that it is refused clearly and that nothing
    // reached the network on the way.
    let threw = null;
    try {
      await renderAndMeasure({
        url: `file://${htmlFile}`,
        pdfPath: path.join(dir, 'out.pdf'),
        theme,
        allowedUrls: [`file://${htmlFile}`],
      });
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, 'a page that navigates away from itself must be refused');
    assert.match(threw.message, /navigated away from itself/);

    assert.deepEqual(hits, [], `the server was contacted: ${JSON.stringify(hits)}`);
    if (fs.existsSync(path.join(dir, 'out.pdf'))) {
      const pdf = fs.readFileSync(path.join(dir, 'out.pdf'), 'latin1');
      assert.ok(!pdf.includes('LOCAL SECRET'), 'local file content reached the PDF');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rm(dir);
  }
});


test('WITHOUT a meta refresh, the same hostile subresources still reach nothing', async () => {
  /** @type {string[]} */
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(req.url); res.end('x'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const { renderAndMeasure } = await import('../../src/render/browser.js');
  const { loadTheme } = await import('../../src/theme/load.js');
  const theme = loadTheme('watercolor');
  const dir = tempDir('iso2');
  const secret = path.join(dir, 'secret.txt');
  fs.writeFileSync(secret, 'LOCAL SECRET');
  const htmlFile = path.join(dir, 'page.html');
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(htmlFile, `<!DOCTYPE html><html><head>
    <link rel="prefetch" href="${base}/prefetch">
    <link rel="preload" as="image" href="${base}/preload">
  </head><body>
    <div data-deck-canvas data-deck-canvas-width="${theme.canvas.width}"
         data-deck-canvas-height="${theme.canvas.height}" data-deck-slide-id="s"
         data-deck-page-type="statement"
         style="width:${theme.canvas.width}px;height:${theme.canvas.height}px">
      <div data-deck-id="probe">visible</div>
      <iframe src="${base}/iframe"></iframe>
      <iframe src="file://${secret}"></iframe>
      <object data="${base}/object"></object>
      <embed src="${base}/embed">
      <svg><image href="${base}/svg-image"></image><use href="${base}/svg-use"></use></svg>
      <div style="background-image:url('${base}/css-bg')">x</div>
      <div style="background-image:url('file://${secret}')">y</div>
    </div></body></html>`);

  try {
    const { geometry, warnings } = await renderAndMeasure({
      url: `file://${htmlFile}`,
      pdfPath: path.join(dir, 'out.pdf'),
      theme,
      allowedUrls: [`file://${htmlFile}`],
    });
    assert.deepEqual(hits, [], `the server was contacted: ${JSON.stringify(hits)}`);
    assert.equal(geometry.slides.length, 1);
    assert.ok(geometry.slides[0].elements.some((e) => e.id === 'probe'), 'the page still rendered');
    assert.ok(warnings.some((w) => /BLOCKED/.test(w)), 'and the blocks were reported');

    const pdf = fs.readFileSync(path.join(dir, 'out.pdf'), 'latin1');
    assert.ok(!pdf.includes('LOCAL SECRET'), 'local file content reached the PDF');
    assert.ok(!JSON.stringify(geometry).includes('LOCAL SECRET'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rm(dir);
  }
});
