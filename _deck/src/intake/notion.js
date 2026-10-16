/**
 * READING THE SAVED NOTION RESPONSE, rather than the agent's account of it.
 *
 * The source gate used to check `pagination.has_more` and `block_count` -
 * both of which the agent writes itself - and, for the raw response, only
 * whether the `raw_file` field was a non-empty string. So an entry with
 * `complete: true`, `pagination: null` and a path to a file that does not
 * exist passed cleanly, and `record-source` emitted exactly that shape. The
 * gate was reading a declaration and calling it evidence.
 *
 * This module derives the same facts FROM THE BYTES: how many requests the
 * chain holds, whether any of them left a cursor unfollowed, how many blocks
 * arrived, and whether every block that says it has children has those
 * children present. The gate compares the derived answer with the declared
 * one and reports a disagreement.
 *
 * THE SHAPES THE NOTION MCP ACTUALLY RETURNS, all of which are accepted:
 *
 *   PAGE OBJECT     what `notion-fetch` returns: {metadata, title, url, text,
 *                   ...}, where `text` is the whole page already flattened to
 *                   markdown. There is no `results` array anywhere in it.
 *   BLOCK LIST      the REST shape: {object: "list", results: [...],
 *                   has_more, next_cursor}, one per request.
 *   AN ARRAY of either, for a multi-call retrieval.
 *
 * This gate demanded the LIST shape and nothing else, so a correctly saved
 * `notion-fetch` response was reported as "no Notion list response at all" and
 * the deck was blocked on evidence that was perfectly good. A gate that
 * refuses the thing the tool actually produces is not a gate, it is an
 * outage.
 *
 * WHAT THIS CANNOT DO: it cannot tell whether the TEXT file faithfully
 * flattens these blocks. The verbatim gates cover the text; this covers
 * whether the retrieval finished.
 */

/**
 * @typedef {object} RawSummary
 * @property {number} requests        list responses in the chain
 * @property {number} blocks          block objects found
 * @property {string[]} pageIds
 * @property {string[]} blockIds
 * @property {boolean} unfinished     a cursor was left unfollowed
 * @property {string[]} problems      what is wrong with the evidence itself
 * @property {number} tables
 * @property {number} unresolvedChildren
 */

/**
 * @param {any} json the parsed raw_file
 * @returns {RawSummary}
 */
export function summariseRaw(json) {
  /** @type {string[]} */
  const problems = [];
  const responses = Array.isArray(json) ? json : [json];
  if (responses.length === 0) {
    problems.push('the saved response is an empty array, so nothing was retrieved');
  }

  /** @type {Set<string>} */
  const pageIds = new Set();
  /** @type {Set<string>} */
  const blockIds = new Set();
  /** @type {{id: string, type: string}[]} */
  const needChildren = [];
  let blocks = 0;
  let tables = 0;
  let requests = 0;
  let pages = 0;
  let unfinished = false;

  /** @param {any} node */
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    // A FETCHED PAGE counts as a retrieval in its own right. `notion-fetch`
    // returns the page already flattened, so there is no block list to count
    // and no cursor to follow: one call got everything it was going to get.
    if (isFetchedPage(node)) {
      requests += 1;
      pages += 1;
      if (typeof node.url === 'string') pageIds.add(node.url);
      if (node.metadata && typeof node.metadata.id === 'string') pageIds.add(node.metadata.id);
      return;
    }
    if (node.object === 'list' || Array.isArray(node.results)) {
      requests += 1;
      // A cursor left unfollowed is a partial fetch whatever the manifest
      // says, and it comes straight from the API rather than from the agent.
      if (node.has_more === true) {
        // Followed only if a LATER response in the chain reports the cursor it
        // handed out. The agent is expected to save the whole chain.
        const cursor = node.next_cursor;
        const followed = responses.some((r) => r && r.start_cursor === cursor && cursor != null);
        if (!followed) unfinished = true;
      }
    }
    if (node.object === 'page' && typeof node.id === 'string') pageIds.add(node.id);
    if (node.object === 'block') {
      blocks += 1;
      if (typeof node.id === 'string') blockIds.add(node.id);
      if (node.type === 'table') tables += 1;
      // has_children is Notion telling us there is another level. A toggle, a
      // column, a synced block and a child page all hide content one level
      // down, and that is the most common way a fetch quietly loses half the
      // minutes.
      if (node.has_children === true) needChildren.push({ id: node.id, type: node.type });
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(responses);

  // A child is "resolved" when some response was a children listing whose
  // parent is that block, or when the block carries its children inline.
  const listedParents = new Set();
  /** @param {any} node */
  const collectParents = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) collectParents(item);
      return;
    }
    if (typeof node.block_id === 'string') listedParents.add(node.block_id);
    if (typeof node.parent_block_id === 'string') listedParents.add(node.parent_block_id);
    if (node.parent && typeof node.parent.block_id === 'string') listedParents.add(node.parent.block_id);
    for (const value of Object.values(node)) collectParents(value);
  };
  collectParents(responses);

  const unresolved = needChildren.filter((b) => !listedParents.has(b.id)
    && !hasInlineChildren(responses, b.id));

  return {
    requests,
    blocks,
    pages,
    tables,
    pageIds: [...pageIds],
    blockIds: [...blockIds],
    unfinished,
    unresolvedChildren: unresolved.length,
    problems: [
      ...problems,
      ...unresolved.map((b) => `block ${b.id} (${b.type}) reports has_children, and the saved response holds no listing of its children - a toggle, column, synced block or child page whose contents were never read`),
    ],
  };
}

/**
 * A page returned by `notion-fetch`: metadata and a flattened `text` body.
 *
 * Identified by shape rather than by a version field, because the MCP does not
 * send one. A page with text is self-evidently a retrieval; requiring it to
 * look like a REST list response was the whole defect.
 *
 * @param {any} node
 */
function isFetchedPage(node) {
  if (!node || typeof node !== 'object') return false;
  if (typeof node.text !== 'string' || node.text.trim() === '') return false;
  return Boolean(node.metadata || node.url || node.page_last_edited_at || node.title);
}

/**
 * Does some saved node carry this block's children inline, under `children`?
 * @param {any} responses
 * @param {string} id
 */
function hasInlineChildren(responses, id) {
  let found = false;
  /** @param {any} node */
  const walk = (node) => {
    if (found || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.object === 'block' && node.id === id && Array.isArray(node.children) && node.children.length > 0) {
      found = true;
      return;
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(responses);
  return found;
}

/**
 * The flattened plain text a saved response implies, for comparison with the
 * text file the agent wrote.
 *
 * Deliberately crude: every `plain_text` in document order. It is not asked to
 * reproduce the agent's formatting, only to answer "is the text file about
 * the blocks that were actually fetched?"
 *
 * @param {any} json
 * @returns {string[]}
 */
export function plainTexts(json) {
  /** @type {string[]} */
  const out = [];
  /** @param {any} node */
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.plain_text === 'string' && node.plain_text.trim()) out.push(node.plain_text);
    // A fetched page carries its whole body in `text`. Split into lines so a
    // partial flattening is still comparable line by line.
    if (isFetchedPage(node)) {
      for (const line of node.text.split('\n')) if (line.trim()) out.push(line.trim());
    }
    for (const value of Object.values(node)) walk(value);
  };
  walk(json);
  return out;
}
