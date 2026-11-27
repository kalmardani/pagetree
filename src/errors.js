// One error type with a stable code, so the CLI can map it to an exit code and the MCP server
// can return a structured error without leaking a stack trace.

export const EXIT = {
  usage: 2,
  input: 3,
  stale: 4,
  model_output: 5,
  provider: 6,
  budget: 7,
  auth: 8,
  internal: 1,
};

export class PagetreeError extends Error {
  /**
   * @param {keyof typeof EXIT} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'PagetreeError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new PagetreeError(code, message, details);
}

export function exitCodeFor(err) {
  if (err instanceof PagetreeError && EXIT[err.code]) return EXIT[err.code];
  return EXIT.internal;
}
