import * as fs from 'node:fs';
import * as path from 'node:path';
import { getBundleName, type CrashVerdict } from '@oniroproject/core';

/**
 * `--since` for `logs crash`: a number of seconds before the device's clock
 * now, or an ISO 8601 instant. Undefined when not given.
 */
export function parseCrashSince(value: string | undefined): number | Date | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) return date;
  }
  throw new Error(`--since takes a number of seconds or an ISO 8601 time (2026-11-05T12:30:00+01:00), not "${value}".`);
}

/** The bundle of the project in `dir`, or undefined when `dir` is not a project. */
export function projectBundle(dir: string): string | undefined {
  if (!fs.existsSync(path.join(dir, 'AppScope', 'app.json5'))) return undefined;
  try {
    return getBundleName(dir);
  } catch {
    return undefined;
  }
}

/** A few lines a person reads: kind, process, reason, the JS error, where it happened, and the log. */
export function formatCrashVerdict(v: CrashVerdict): string {
  const lines: string[] = [];
  const kind = v.subtype ? `${v.kind} (${v.subtype})` : v.kind;
  const who = [v.bundle ?? v.process, v.pid !== null ? `pid ${v.pid}` : null].filter(Boolean).join(' ');
  lines.push(`${v.crashed ? 'CRASH' : 'NO CRASH'} ${kind}, ${v.confidence} confidence${who ? `: ${who}` : ''}${v.time ? ` at ${v.time}` : ''}`);
  if (v.jsError) lines.push(`${v.jsError.name}: ${v.jsError.message}`);
  else if (v.reason) lines.push(`Reason: ${v.reason}`);
  if (v.lastFatalMessage) lines.push(`Last fatal message: ${v.lastFatalMessage}`);
  if (v.file) lines.push(`At ${v.file}:${v.line}:${v.column}`);
  if (v.topFrame) lines.push(`Top frame: ${v.topFrame}`);
  if (v.projectFrame && v.projectFrame !== v.topFrame) lines.push(`Project frame: ${v.projectFrame}`);
  const shown = v.stack.slice(0, 12);
  if (shown.length > 0) lines.push('Stack:', ...shown.map((f) => `  ${f}`));
  if (v.stack.length > shown.length) lines.push(`  … ${v.stack.length - shown.length} more`);
  for (const edge of v.binderChain) {
    lines.push(`Binder: ${edge.from} -> ${edge.to} waits ${edge.waitSeconds.toFixed(2)} s${edge.frzState ? ` frz_state:${edge.frzState}` : ''}`);
  }
  for (const cycle of v.deadlocks) lines.push(`Binder deadlock: ${cycle}`);
  for (const note of v.notes) lines.push(`Note: ${note}`);
  if (v.path) lines.push(`Faultlog: ${v.path}`);
  if (v.rawPath && v.rawPath !== v.path) lines.push(`Saved to: ${v.rawPath}`);
  return `${lines.join('\n')}\n`;
}
