/**
 * deck's error vocabulary.
 *
 * Exit codes are a contract, because `deck` is driven from shell scripts and
 * from squad-style gates:
 *
 *   0  the process completed AND the verdict passed
 *   1  the process completed AND the verdict failed (lint violations, a
 *      digest mismatch, a schema violation) - this is a successful run with a
 *      failing answer
 *   2  usage error: a bad flag, a missing argument, an unknown subcommand
 *   3  environment error: no Chrome, no pdftoppm, no deck workspace
 *   4  the process itself FAILED: it crashed, could not read its inputs, or
 *      could not write its outputs, so it has no verdict to report at all
 *
 * The difference between 1 and 4 is the whole point. A lint run that completed
 * and found violations is a successful process with a failing verdict. A lint
 * run that died halfway has no verdict, and must never be reported as one.
 */
export const EXIT = {
  OK: 0,
  VERDICT_FAILED: 1,
  USAGE: 2,
  ENVIRONMENT: 3,
  PROCESS_FAILED: 4,
};

/** An error that carries the exit code deck should die with. */
export class DeckError extends Error {
  /**
   * @param {string} message
   * @param {number} [code]
   * @param {string[]} [details] extra lines printed under the message
   */
  constructor(message, code = EXIT.PROCESS_FAILED, details = []) {
    super(message);
    this.name = 'DeckError';
    this.code = code;
    this.details = details;
  }
}

/** @returns {never} */
export function usage(message, details = []) {
  throw new DeckError(message, EXIT.USAGE, details);
}

/** @returns {never} */
export function environment(message, details = []) {
  throw new DeckError(message, EXIT.ENVIRONMENT, details);
}

/** @returns {never} */
export function processFailed(message, details = []) {
  throw new DeckError(message, EXIT.PROCESS_FAILED, details);
}
