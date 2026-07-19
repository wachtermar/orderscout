import { CliError } from "./lib.js";

const EXIT_CODES = {
  USAGE_ERROR: 2,
  AUTH_REQUIRED: 3,
  AUTH_EXPIRED: 3,
  INVALID_AUTH: 3,
  INVALID_TOKEN: 3,
  AUTH_TTY_REQUIRED: 3,
  AUTH_INTERACTIVE_REQUIRED: 3,
  HTTP_ERROR: 4,
  NETWORK_ERROR: 5,
  RATE_LIMITED: 6,
  ORDER_STATUS_UNKNOWN: 7,
};

function selectPath(value, path) {
  return path.split(".").filter(Boolean).reduce((current, key) => {
    if (Array.isArray(current)) return current.map((entry) => entry?.[key]);
    return current?.[key];
  }, value);
}

export function selectOutput(value, selector) {
  if (!selector) return value;
  const paths = String(selector).split(",").map((path) => path.trim()).filter(Boolean);
  if (paths.length === 1) return selectPath(value, paths[0]);
  return Object.fromEntries(paths.map((path) => [path, selectPath(value, path)]));
}

export function writeOutput(value, flags = {}, stream = process.stdout) {
  if (flags.quiet) return;
  const selected = selectOutput(value, flags.select);
  const compact = flags.compact || flags.agent;
  stream.write(`${JSON.stringify(selected, null, compact ? 0 : 2)}\n`);
}

export function errorEnvelope(error) {
  const known = error instanceof CliError;
  return {
    error: {
      code: known ? error.code : "UNEXPECTED_ERROR",
      message: error?.message ?? String(error),
      ...(known && error.details ? { details: error.details } : {}),
    },
  };
}

export function exitCodeFor(error) {
  if (!(error instanceof CliError)) return 1;
  if (error.code === "HTTP_ERROR" && error.details?.status === 429) return EXIT_CODES.RATE_LIMITED;
  return EXIT_CODES[error.code] ?? 1;
}
