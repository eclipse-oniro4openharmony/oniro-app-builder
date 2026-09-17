/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/auth/login/browser.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import { spawn } from 'node:child_process';
import { OniroError } from '../../ports/errors.js';

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.hostname !== '' && !url.includes('"');
  } catch {
    return false;
  }
}

/** `start` on Windows goes through cmd, where these are shell metacharacters. */
function escapeForCmd(s: string): string {
  return s.replace(/[&|<>()^%!]/g, (c) => `^${c}`);
}

/**
 * Open `url` in the user's default browser. Resolves once the launcher exits
 * successfully.
 *
 * Some launchers (`xdg-open` without a desktop environment, `$BROWSER`) only exit
 * when the browser does, so callers should not wait on this before carrying on;
 * the launcher is detached so it neither keeps this process alive nor dies with it.
 * Headless environments (CI, a remote shell) have no browser to open; the caller
 * is expected to print the URL as well so the user can open it themselves.
 */
export function openBrowser(url: string): Promise<void> {
  if (!isSafeUrl(url)) {
    return Promise.reject(new OniroError(`Refusing to open unsafe URL: ${JSON.stringify(url)}`));
  }

  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', escapeForCmd(url)]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];

  const child = spawn(command as string, args as string[], {
    stdio: 'ignore',
    shell: false,
    detached: true,
    windowsHide: true,
  });
  child.unref();

  return new Promise<void>((resolve, reject) => {
    child.on('error', (err) => reject(new OniroError(`Failed to open a browser (${command}).`, err)));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new OniroError(`Browser launcher '${command}' exited with code ${code}.`)),
    );
  });
}
