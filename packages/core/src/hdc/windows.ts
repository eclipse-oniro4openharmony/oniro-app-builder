/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/ui/window/fetcher.ts`), Copyright (c) 2026 Huawei Device
 * Co., Ltd., licensed under the MIT License. See the repository-root NOTICE.
 *
 * Changed: upstream stops at the first dashed separator and so lists only the
 * windows above it; this parser reads every section of the table and keeps the
 * z-order and rectangle, and it filters nothing by type.
 */
import type { ConfigProvider } from '../ports/config.js';
import type { Logger } from '../ports/logger.js';
import { shell, ensureOk } from './exec.js';

/** A row of the `hidumper -s WindowManagerService -a -a` window table. */
export interface WindowInfo {
  /** `WinId`: what `--window` takes, and the `windowId` in `dump layout`. */
  id: number;
  /** `WindowName`, which hidumper cuts to 20 characters. */
  name: string;
  displayId: number;
  pid: number;
  /** Window type: 1 is an app's main window; 2000 and up are system windows. */
  type: number;
  /** Stacking order; -1 for a window that is not shown. */
  zOrder: number;
  /** [x, y, width, height] in device pixels. */
  rect?: [number, number, number, number];
  /** It is the `Focus window`. */
  focused: boolean;
}

/** Parse the window table of `hidumper -s WindowManagerService -a -a`. Pure. */
export function parseWindowList(raw: string): WindowInfo[] {
  const lines = raw.split(/\r?\n/);
  const header = lines.findIndex((l) => l.trimStart().startsWith('WindowName'));
  if (header < 0) return [];
  const windows: WindowInfo[] = [];
  for (const line of lines.slice(header + 1)) {
    const t = line.trim();
    if (/^-+$/.test(t)) continue; // between the shown and the hidden windows
    if (t === '' || /^(Focus window|All Focus window|Total window|total window)/.test(t)) break;
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+\s+\d+\s+(-?\d+)\s+\S+\s+\[\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(t);
    const loose = m ?? /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(t);
    if (!loose) continue;
    windows.push({
      id: Number(loose[4]),
      name: loose[1]!,
      displayId: Number(loose[2]),
      pid: Number(loose[3]),
      type: Number(loose[5]),
      zOrder: m ? Number(m[6]) : -1,
      ...(m ? { rect: [Number(m[7]), Number(m[8]), Number(m[9]), Number(m[10])] as [number, number, number, number] } : {}),
      focused: false,
    });
  }
  const focus = /^\s*Focus window:\s*(\d+)/m.exec(raw);
  if (focus) {
    const id = Number(focus[1]);
    for (const w of windows) w.focused = w.id === id;
  }
  return windows;
}

export interface ListWindowsOptions {
  config: ConfigProvider;
  deviceSerial?: string;
  logger?: Logger;
}

/** List the device's windows (shown ones first, in the order hidumper prints them). */
export async function listWindows(opts: ListWindowsOptions): Promise<WindowInfo[]> {
  const res = await shell({
    config: opts.config,
    command: "hidumper -s WindowManagerService -a '-a'",
    deviceSerial: opts.deviceSerial,
    timeoutMs: 15_000,
    logger: opts.logger,
  });
  ensureOk(res, 'hidumper -s WindowManagerService -a -a');
  return parseWindowList(res.stdout);
}
