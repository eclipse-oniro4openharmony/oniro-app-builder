import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { Logger } from '../../ports/logger.js';
import { noopLogger } from '../../ports/logger.js';
import { listModules } from '../../project/listModules.js';
import { ACL_PERMISSIONS } from './aclPermissionList.js';

/** Read `requestPermissions[].name` out of one module config, if present. */
function readRequestedPermissions(moduleConfigPath: string): string[] {
  if (!fs.existsSync(moduleConfigPath)) return [];
  try {
    const parsed = JSON5.parse(fs.readFileSync(moduleConfigPath, 'utf-8')) as {
      module?: { requestPermissions?: Array<{ name?: unknown }> };
    };
    return (parsed.module?.requestPermissions ?? [])
      .map((p) => p?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
  } catch {
    return [];
  }
}

/**
 * Collect the ACL-gated permissions the project requests.
 *
 * These must be named in the provisioning profile or the HAP is refused at install
 * time. Both `src/main` and `src/ohosTest` are scanned, since a test module's
 * permissions are equally gated.
 */
export function collectAclPermissions(
  projectDir: string,
  logger: Logger = noopLogger,
): string[] {
  const requested = new Set<string>();

  for (const module of listModules({ projectDir })) {
    const moduleRoot = path.resolve(projectDir, module.srcPath);
    for (const sourceSet of ['main', 'ohosTest']) {
      for (const name of readRequestedPermissions(
        path.join(moduleRoot, 'src', sourceSet, 'module.json5'),
      )) {
        requested.add(name);
      }
    }
  }

  const acls = [...requested].filter((p) => ACL_PERMISSIONS.has(p)).sort();
  if (acls.length > 0) {
    logger.info(`[harmonyos] Project requests ${acls.length} ACL permission(s): ${acls.join(', ')}`);
  }
  return acls;
}
