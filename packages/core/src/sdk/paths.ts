import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigProvider, defaultPaths } from '../ports/config.js';
import { getOsFolder } from './platform.js';

export function getSdkRootDir(config: ConfigProvider): string {
  return config.get('sdkRootDir', defaultPaths.sdkRootDir());
}

/**
 * Base SDK home for the current OS: `<sdkRootDir>/<linux|darwin|windows>`.
 * SDK API folders (e.g. `12`, `18`, `20`) live inside this directory.
 */
export function getOhosBaseSdkHome(config: ConfigProvider): string {
  return path.join(getSdkRootDir(config), getOsFolder());
}

export function getCmdToolsPath(config: ConfigProvider): string {
  return config.get('cmdToolsPath', defaultPaths.cmdToolsPath());
}

export function getEmulatorDir(config: ConfigProvider): string {
  return config.get('emulatorDir', defaultPaths.emulatorDir());
}

function pickExisting(candidates: string[]): string {
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]!;
}

/**
 * Resolve the OHPM binary path inside the command-line tools install.
 * On Windows tries common executable suffixes (.exe, .cmd, .bat) before the POSIX name.
 */
export function getCmdToolsBin(config: ConfigProvider): string {
  const binDir = path.join(getCmdToolsPath(config), 'bin');
  if (os.platform() === 'win32') {
    return pickExisting([
      path.join(binDir, 'ohpm.exe'),
      path.join(binDir, 'ohpm.cmd'),
      path.join(binDir, 'ohpm.bat'),
      path.join(binDir, 'ohpm'),
    ]);
  }
  return path.join(binDir, 'ohpm');
}

/**
 * Resolve the hdc binary path inside the SDK toolchains tree.
 */
export function getHdcPath(config: ConfigProvider): string {
  const base = path.join(getCmdToolsPath(config), 'sdk', 'default', 'openharmony', 'toolchains');
  if (os.platform() === 'win32') {
    return pickExisting([
      path.join(base, 'hdc.exe'),
      path.join(base, 'hdc.bat'),
      path.join(base, 'hdc.cmd'),
      path.join(base, 'hdc'),
    ]);
  }
  return path.join(base, 'hdc');
}

/**
 * Resolve the hvigorw wrapper for a project, preferring the project-local copy
 * (which carries the project's pinned hvigor version) and falling back to the
 * one shipped with the command-line tools.
 */
export function getHvigorwPath(config: ConfigProvider, projectDir: string): string {
  const cmdToolsBin = path.join(getCmdToolsPath(config), 'bin');
  return pickExisting([
    path.join(projectDir, 'hvigorw'),
    path.join(projectDir, 'hvigorw.bat'),
    path.join(projectDir, 'hvigorw.cmd'),
    path.join(cmdToolsBin, 'hvigorw'),
    path.join(cmdToolsBin, 'hvigorw.bat'),
    path.join(cmdToolsBin, 'hvigorw.cmd'),
  ]);
}
