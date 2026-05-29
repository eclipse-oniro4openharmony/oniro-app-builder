export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export const consoleLogger: Logger = {
  debug: (m) => console.debug(m),
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/**
 * Wrap a Logger so every message is prefixed with `[<scope>] `. Standardizes the
 * ad-hoc `[hdc]` / `[build]` / `[sign]` / `[hilog]` / `[emulator]` prefixes that
 * were previously hand-written at each call site.
 */
export function scopedLogger(logger: Logger, scope: string): Logger {
  const prefix = `[${scope}] `;
  return {
    debug: (m) => logger.debug(prefix + m),
    info: (m) => logger.info(prefix + m),
    warn: (m) => logger.warn(prefix + m),
    error: (m) => logger.error(prefix + m),
  };
}
