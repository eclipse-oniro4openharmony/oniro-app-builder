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

export class CancelledError extends OniroError {
  constructor(message = 'Operation cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}
