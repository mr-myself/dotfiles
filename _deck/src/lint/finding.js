/**
 * @typedef {object} Box
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {string} label
 * @property {'offender' | 'reference' | 'context'} kind
 */

/**
 * @typedef {object} Finding
 * @property {string} rule
 * @property {'fail' | 'suggestion' | 'unsupported'} severity
 * @property {string} slide
 * @property {string | null} element
 * @property {'x' | 'y' | null} axis
 * @property {string | null} reference
 * @property {string} message
 * @property {any} expected
 * @property {any} measured
 * @property {Box[]} boxes
 */

/**
 * @param {Partial<Finding> & {rule: string, slide: string, message: string}} f
 * @returns {Finding}
 */
export function finding(f) {
  return {
    rule: f.rule,
    // `unsupported` is a FAILING severity, not a third pass-ish state.
    // Geometry deck cannot measure, or evidence it cannot read, is a reported
    // failure - never a silent pass.
    severity: f.severity || 'fail',
    slide: f.slide,
    element: f.element ?? null,
    axis: f.axis ?? null,
    reference: f.reference ?? null,
    message: f.message,
    expected: f.expected ?? null,
    measured: f.measured ?? null,
    boxes: f.boxes || [],
  };
}

/** @param {Finding} f @returns {boolean} */
export function isBlocking(f) {
  return f.severity === 'fail' || f.severity === 'unsupported';
}

/** @param {any} r @param {string} label @param {Box['kind']} kind @returns {Box | null} */
export function box(r, label, kind = 'offender') {
  if (!r) return null;
  return { x: r.x, y: r.y, w: r.w, h: r.h, label, kind };
}
