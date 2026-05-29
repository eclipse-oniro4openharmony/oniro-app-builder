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
 * Resolve a binary inside the command-line tools `bin/` directory by name
 * (e.g. `'ohpm'`, `'hvigorw'`, `'codelinter'`). On Windows tries common
 * executable suffixes (.exe, .cmd, .bat) before the POSIX name.
 */
export function getCmdToolsBin(config: ConfigProvider, name = 'ohpm'): string {
  const binDir = path.join(getCmdToolsPath(config), 'bin');
  if (os.platform() === 'win32') {
    return pickExisting([
      path.join(binDir, `${name}.exe`),
      path.join(binDir, `${name}.cmd`),
      path.join(binDir, `${name}.bat`),
      path.join(binDir, name),
    ]);
  }
  return path.join(binDir, name);
}

/** Resolve the OHPM binary path inside the command-line tools install. */
export function getOhpmPath(config: ConfigProvider): string {
  return getCmdToolsBin(config, 'ohpm');
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
 * Resolve the hvigorw wrapper for a project. Prefers the project-local copy
 * (which carries the project's pinned hvigor version) — but ONLY when that
 * wrapper is structurally complete. HMOS-vendored projects (systemui, launcher)
 * ship a project-local `hvigorw` whose `hvigor/` install is absent, so the
 * wrapper crashes on startup; in that case we fall back to the hvigorw bundled
 * with the command-line tools, which is always installed.
 */
export function getHvigorwPath(config: ConfigProvider, projectDir: string): string {
  const local = pickExisting([
    path.join(projectDir, 'hvigorw'),
    path.join(projectDir, 'hvigorw.bat'),
    path.join(projectDir, 'hvigorw.cmd'),
  ]);
  if (fs.existsSync(local) && isProjectLocalHvigorwWorking(projectDir)) {
    return local;
  }
  return getCmdToolsBin(config, 'hvigorw');
}

/**
 * A project-local hvigorw wrapper only works when the project also has a
 * populated `hvigor/` install. The structural check (wrapper script + its
 * node_modules) is fast and avoids spawning `hvigorw --version` for the common,
 * working case.
 */
function isProjectLocalHvigorwWorking(projectDir: string): boolean {
  const wrapper = path.join(projectDir, 'hvigor', 'hvigor-wrapper.js');
  const nodeModules = path.join(projectDir, 'hvigor', 'node_modules');
  return fs.existsSync(wrapper) && fs.existsSync(nodeModules);
}
