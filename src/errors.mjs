export class CliError extends Error {
  constructor(code, message, details = null, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function requireValue(value, code, message) {
  if (value === undefined || value === null || value === "") {
    throw new CliError(code, message);
  }
  return value;
}
