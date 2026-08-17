export class OniroError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = 'OniroError';
  }
}

export class SdkNotInstalledError extends OniroError {
  constructor(public readonly api: string, public readonly expectedPath: string) {
    super(`SDK API ${api} is not installed at ${expectedPath}.`);
    this.name = 'SdkNotInstalledError';
  }
}

export class CmdToolsNotInstalledError extends OniroError {
  constructor(public readonly expectedPath: string) {
    super(`OpenHarmony command-line tools are not installed at ${expectedPath}.`);
    this.name = 'CmdToolsNotInstalledError';
  }
}

export class UnsupportedPlatformError extends OniroError {
  constructor(public readonly platform: string) {
    super(`Unsupported platform: ${platform}.`);
    this.name = 'UnsupportedPlatformError';
  }
}

export class ChecksumMismatchError extends OniroError {
  constructor(public readonly expected: string, public readonly actual: string) {
    super(`SHA256 mismatch: expected ${expected}, got ${actual}.`);
    this.name = 'ChecksumMismatchError';
  }
}

/**
 * A download/extract ran out of room on the filesystem holding its scratch
 * directory. The message is built by the caller (see `sdk/tmp.ts`) so it can name
 * the directory, whether it is RAM-backed, and how to point elsewhere.
 */
export class InsufficientSpaceError extends OniroError {
  constructor(message: string, public readonly dir: string, cause?: unknown) {
    super(message, cause);
    this.name = 'InsufficientSpaceError';
  }
}

export class CancelledError extends OniroError {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * A spawned command ran to completion but exited non-zero. Lets callers
 * distinguish "the tool ran and failed" from "the tool could not be spawned"
 * (a missing binary surfaces as an OniroError / CmdToolsNotInstalledError).
 */
export class CommandFailedError extends OniroError {
  constructor(
    public readonly command: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`Command failed (exit ${exitCode}): ${command}${stderr ? `\n${stderr}` : ''}`);
    this.name = 'CommandFailedError';
  }
}
