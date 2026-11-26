import * as path from 'node:path';
import type { ConfigProvider } from '../ports/config.js';
import { getCmdToolsPath, getHvigorwPath } from '../sdk/paths.js';
import { compareDottedVersions, DOTTED_API_MIN_HVIGOR, usesDottedVersion } from '../sdk/apiVersion.js';
import { describeCmdTools, readCmdToolsInfo } from './install.js';

/** The command-line tools' hvigor is too old for a project's API level. */
export interface HvigorTooOld {
  api: number;
  /** The hvigor those tools ship, e.g. `6.24.2`. */
  hvigor: string;
  /** The command-line tools install. */
  toolsPath: string;
  /** e.g. `API 26 needs hvigor 6.26.0 or later; the command-line tools at … are 6.1.1.280 (…, hvigor 6.24.2).` */
  message: string;
  /** What to do about it. */
  fix: string;
}

/**
 * Whether the command-line tools' hvigor is too old to build an API `api` project,
 * or null when it is new enough or that cannot be told. From API 26 an SDK is named
 * by its dotted release (`26.0.0`), which only hvigor 6.26 and later read: older
 * ones reject the string version and do not find the SDK. With `projectDir`, a
 * project whose own hvigorw wrapper a build would run (it pins its own hvigor) is
 * not judged.
 */
export function findHvigorTooOld(config: ConfigProvider, api: number, projectDir?: string): HvigorTooOld | null {
  if (!usesDottedVersion(api)) return null;
  const toolsPath = getCmdToolsPath(config);
  if (projectDir !== undefined) {
    const hvigorw = path.resolve(getHvigorwPath(config, projectDir));
    if (!hvigorw.startsWith(path.resolve(toolsPath) + path.sep)) return null;
  }
  const info = readCmdToolsInfo(toolsPath);
  const hvigor = info.tools.hvigor;
  if (!hvigor || compareDottedVersions(hvigor, DOTTED_API_MIN_HVIGOR) >= 0) return null;
  return {
    api,
    hvigor,
    toolsPath,
    message:
      `API ${api} needs hvigor ${DOTTED_API_MIN_HVIGOR} or later, from the 26.0.0 or newer command-line tools; ` +
      `the command-line tools at ${toolsPath} are ${describeCmdTools(info)}.`,
    fix:
      'Download the newer command-line tools from the Huawei developer portal and install them with ' +
      '`oniro-app cmdtools install --from-zip <zip> --force`, or point ONIRO_CMD_TOOLS_PATH at an install of them.',
  };
}
