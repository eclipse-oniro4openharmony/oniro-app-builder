import * as fs from 'node:fs';
import * as path from 'node:path';
import { OniroError } from '../ports/errors.js';

/**
 * A project's `local.properties`, which DevEco Studio writes and hvigor and
 * codelinter read: `sdk.dir` names the OpenHarmony SDK home (the directory
 * holding API folders, not an API folder itself).
 */

const SDK_DIR_LINE = /^[ \t]*sdk\.dir[ \t]*[=:].*$/m;

/** A path as a `.properties` value: backslashes doubled on Windows. */
export function toJavaPropertiesPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '\\\\') : p;
}

/**
 * The `sdk.dir` a project's `local.properties` names (a base SDK home holding API
 * folders, as `createScaffold` writes it), unescaped, or undefined.
 */
export function localPropertiesSdkDir(projectRoot: string): string | undefined {
  try {
    const content = fs.readFileSync(path.join(projectRoot, 'local.properties'), 'utf-8');
    const m = /^\s*sdk\.dir\s*[=:]\s*(.+?)\s*$/m.exec(content);
    return m ? m[1]!.replace(/\\(.)/g, '$1') : undefined;
  } catch {
    return undefined;
  }
}

/** `content` with every `sdk.dir` line set to `sdkDir`, or one appended when it has none. */
export function withSdkDirLine(content: string, sdkDir: string): string {
  const line = `sdk.dir=${toJavaPropertiesPath(sdkDir)}`;
  if (SDK_DIR_LINE.test(content)) return content.replace(new RegExp(SDK_DIR_LINE.source, 'gm'), () => line);
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}${line}\n`;
}

/**
 * Run `fn` with the project's `local.properties` naming `sdkDir` as `sdk.dir`, then
 * put the file back as it was: its original bytes, or no file when there was none.
 * Other keys are kept. A process killed mid-run leaves the edited file behind; it
 * names an installed SDK, so hvigor still builds with it.
 */
export async function withLocalPropertiesSdkDir<T>(projectDir: string, sdkDir: string, fn: () => Promise<T>): Promise<T> {
  const file = path.join(projectDir, 'local.properties');
  const original = fs.existsSync(file) ? fs.readFileSync(file) : undefined;
  try {
    fs.writeFileSync(file, withSdkDirLine(original?.toString('utf8') ?? '', sdkDir), 'utf8');
  } catch (err) {
    throw new OniroError(
      `Cannot write ${file} (${err instanceof Error ? err.message : String(err)}). codelinter reads the OpenHarmony ` +
        `SDK only from its sdk.dir: make it writable, or add sdk.dir=${toJavaPropertiesPath(sdkDir)} yourself.`,
      err,
    );
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, original);
  }
}
