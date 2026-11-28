// Stable private-history errors. P8 maps `status` to the HTTP response and sends only {code, message}:
// no paths, offsets or provider text ever appear in a message.

const MESSAGES = {
  bad_request: [400, 'This history request is not valid.'],
  invalid_cursor: [400, 'This history cursor is not valid for this conversation.'],
  stale_cursor: [409, 'This conversation changed. Load the latest messages.'],
  unavailable: [404, 'This conversation is unavailable.'],
};

export class HistoryError extends Error {
  /** @param {keyof typeof MESSAGES} code  @param {string} [reason] internal detail for tests and logs, never sent */
  constructor(code, reason) {
    const [status, message] = MESSAGES[code] ?? MESSAGES.bad_request;
    super(message);
    this.name = 'HistoryError';
    this.code = MESSAGES[code] ? code : 'bad_request';
    this.status = status;
    this.reason = reason ?? null;
  }
  toJSON() { return { code: this.code, message: this.message }; }
}
