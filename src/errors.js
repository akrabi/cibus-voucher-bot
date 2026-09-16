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

export function safeErrorDetails(error) {
  const types = ["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError", "Exception"];
  const type = types.includes(error?.name) ? error.name : "Error";
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const locations = stack.split("\n").slice(1)
    .flatMap(line => [...line.matchAll(/\b(bundle|entrypoints)(?:\.gs|\.js)?:(\d{1,6})(?::(\d{1,6}))?\)?\s*$/g)])
    .slice(0, 4).map(match => `${match[1]}:${match[2]}${match[3] ? `:${match[3]}` : ""}`);
  return { type, locations };
}
