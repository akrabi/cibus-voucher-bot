export class VoucherError extends Error {
  constructor(code) {
    super(code);
    this.name = "VoucherError";
    this.code = code;
  }
}

export function requireValue(condition, code) {
  if (!condition) throw new VoucherError(code);
}

export function safeCode(error) {
  return error instanceof VoucherError ? error.code : "UNEXPECTED_ERROR";
}
