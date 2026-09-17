/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`src/signature/signature-tool.ts`), Copyright (c) 2026 Huawei Device Co., Ltd.,
 * licensed under the MIT License. See packages/core/src/harmonyos/NOTICE.md.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { ConfigProvider } from '../../ports/config.js';
import { defaultPaths } from '../../ports/config.js';

/** The four files of a HarmonyOS signing setup. */
export interface SigningMaterialPaths {
  p12Path: string;
  csrPath: string;
  cerPath: string;
  profilePath: string;
}

/** @internal exposed for tests. */
export function sanitizeNamePart(raw?: string): string {
  const safe = (raw?.trim() ?? '').replace(/[\\/:*?"<>|=.-]+/g, '_');
  return safe.slice(0, 64) || 'default';
}

/**
 * Where the material for a (product, project) pair lives: `harmonyosSigningDir`
 * (default `~/.ohos/config`, as DevEco Studio uses), named after Studio's pattern.
 * Keyed by project *path*, so two checkouts of one app never share a keystore.
 */
export function resolveSigningMaterialPaths(
  config: ConfigProvider,
  productName: string | undefined,
  projectRoot: string,
): SigningMaterialPaths {
  const hash = crypto.createHash('sha256').update(projectRoot, 'utf8').digest('base64url').replaceAll(/[-_]/g, '');
  const base = path.join(
    config.get('harmonyosSigningDir', defaultPaths.harmonyosSigningDir()),
    `${sanitizeNamePart(productName)}_${path.basename(projectRoot)}_${hash}=`,
  );
  return { p12Path: `${base}.p12`, csrPath: `${base}.csr`, cerPath: `${base}.cer`, profilePath: `${base}.p7b` };
}
