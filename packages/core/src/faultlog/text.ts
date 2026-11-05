/*
 * Portions of this file are adapted from openharmony-sig/deveco-cli
 * (`packages/cli/src/faultlog/crash/log-text.ts`, `crash/hilog-section.ts`),
 * Copyright (c) 2026 Huawei Device Co., Ltd., licensed under the MIT License.
 * See packages/core/src/faultlog/NOTICE.md.
 */

/** Normalise line endings, drop a BOM and split into lines (no terminators). */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  return (normalized.startsWith('﻿') ? normalized.slice(1) : normalized).split('\n');
}

/** The last `/`-separated segment (`/system/bin/render_service` → `render_service`). */
export function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}

/**
 * First non-empty capture group 1 of each pattern, scanning lines in order.
 * Returns `{ key: value }` for the keys that matched.
 */
export function searchFields<K extends string>(lines: readonly string[], patterns: Record<K, RegExp>): Partial<Record<K, string>> {
  const remaining = new Map<K, RegExp>(Object.entries(patterns) as Array<[K, RegExp]>);
  const out: Partial<Record<K, string>> = {};
  for (const line of lines) {
    if (remaining.size === 0) break;
    for (const [key, pattern] of remaining) {
      const value = pattern.exec(line)?.[1]?.trim();
      if (value) {
        out[key] = value;
        remaining.delete(key);
      }
    }
  }
  return out;
}

/**
 * The lines from the first one matching `start` up to (not including) the next
 * one matching `end`, or to the end. `[[], -1]` when `start` never matches.
 */
export function findSection(lines: readonly string[], start: RegExp, end: RegExp, includeStart = true): [string[], number] {
  const startIndex = lines.findIndex((line) => start.test(line));
  if (startIndex < 0) return [[], -1];
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (end.test(lines[i]!)) {
      endIndex = i;
      break;
    }
  }
  return [lines.slice(includeStart ? startIndex : startIndex + 1, endIndex), startIndex];
}

/**
 * Cut a log at marker lines that appear in this order. Key `''` holds the lines
 * before the first marker; a marker that never appears maps to `[]`.
 */
export function splitByMarkers(lines: readonly string[], markers: readonly string[]): Map<string, string[]> {
  const sections = new Map<string, string[]>([['', []]]);
  for (const marker of markers) sections.set(marker, []);
  let current = '';
  let remaining = [...markers];
  for (const line of lines) {
    const trimmed = line.trimStart();
    const at = remaining.findIndex((marker) => trimmed.startsWith(marker));
    if (at >= 0) {
      current = remaining[at]!;
      remaining = remaining.slice(at + 1);
    }
    sections.get(current)!.push(line);
  }
  return sections;
}

/** The trailing `HiLog:` section of a faultlog (from that line on), or `''`. */
export function hilogSection(lines: readonly string[]): string {
  const at = lines.findIndex((line) => line.trimStart().startsWith('HiLog:'));
  return at < 0 ? '' : lines.slice(at).join('\n');
}
