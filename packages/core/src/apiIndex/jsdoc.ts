/**
 * The doc-comment tags the index records, read from the `/** ... *\/` blocks before a
 * declaration. OpenHarmony stacks one block per API level that changed a symbol's
 * documentation (the `@since 10` block, then the `@since 11` block that adds
 * `@atomicservice`, ...), so a symbol's facts come from all of its blocks.
 */

export interface DocTags {
  /** The lowest numeric `@since`. */
  since?: number;
  /** The `@since` values with a qualifier (`12 dynamic`), joined with `, `. */
  sinceText?: string;
  deprecated?: string;
  deprecatedSince?: number;
  useInstead?: string;
  syscap?: string;
  systemApi?: boolean;
  /** `@kit` (on a file's `@file` block): `ArkUI`. */
  kit?: string;
  /** The block is a file header (`@file`, `@addtogroup`), not a declaration's doc. */
  fileHeader?: boolean;
  doc?: string;
}

/** The lines of one doc block without the `/**`, `*\/` and leading `*`. */
function blockLines(block: string): string[] {
  return block
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*?\s?/, '').trimEnd());
}

const MAX_DOC = 200;

function cleanDoc(line: string): string {
  const s = line
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\{@link\s+([^}]*?)\s*\}/g, '$1')
    .replace(/\\n/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_DOC ? `${s.slice(0, MAX_DOC - 1)}…` : s;
}

/** The tags of one block. */
export function parseDocBlock(block: string): DocTags {
  const tags: DocTags = {};
  const lines = blockLines(block);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('@')) {
      if (!tags.doc && line && !/^[-=*_]+$/.test(line)) tags.doc = cleanDoc(line);
      continue;
    }
    const m = /^@(\w+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    switch (tag) {
      case 'since': {
        const n = /^(\d+)/.exec(value);
        if (n) {
          const v = Number(n[1]);
          if (tags.since === undefined || v < tags.since) tags.since = v;
          if (value !== n[1]) {
            const text = value.replace(/\s+/g, ' ');
            tags.sinceText = tags.sinceText ? `${tags.sinceText}, ${text}` : text;
          }
        }
        break;
      }
      case 'deprecated': {
        tags.deprecated = value.replace(/\s+/g, ' ');
        const n = /since\s+(\d+)/i.exec(value);
        if (n) tags.deprecatedSince = Number(n[1]);
        break;
      }
      case 'useinstead':
        if (value) tags.useInstead = value.split(/\s+/)[0];
        break;
      case 'syscap':
        if (value) tags.syscap = value.split(/\s+/)[0];
        break;
      case 'systemapi':
        tags.systemApi = true;
        break;
      case 'kit':
        if (value) tags.kit = value.split(/\s+/)[0];
        break;
      case 'file':
      case 'addtogroup':
        tags.fileHeader = true;
        break;
      case 'brief':
        if (!tags.doc && value) tags.doc = cleanDoc(value);
        break;
    }
  }
  return tags;
}

/**
 * The tags of a declaration from all its doc blocks, oldest first: the lowest
 * `@since` (of the public blocks, when the newest block is public), a deprecation
 * from any block, and the syscap, system-API flag and doc line of the newest block.
 * File-header blocks are skipped.
 */
export function mergeDocBlocks(blocks: readonly string[]): DocTags {
  const parsed = blocks.map(parseDocBlock).filter((t) => !t.fileHeader);
  const out: DocTags = {};
  const sinceTexts: string[] = [];
  for (const t of parsed) {
    if (t.since !== undefined && (out.since === undefined || t.since < out.since)) out.since = t.since;
    if (t.sinceText && !sinceTexts.includes(t.sinceText)) sinceTexts.push(t.sinceText);
    if (t.deprecated !== undefined) {
      out.deprecated = t.deprecated;
      if (t.deprecatedSince !== undefined) out.deprecatedSince = t.deprecatedSince;
    }
    if (t.useInstead) out.useInstead = t.useInstead;
  }
  if (sinceTexts.length) out.sinceText = sinceTexts.join(', ');
  const last = parsed[parsed.length - 1];
  // A system API made public later (`@systemapi @since 12`, then `@since 23`) is
  // available to apps since the first public block.
  if (last && !last.systemApi) {
    const publicSince = parsed
      .filter((t) => !t.systemApi && t.since !== undefined)
      .reduce<number | undefined>((min, t) => (min === undefined || t.since! < min ? t.since : min), undefined);
    if (publicSince !== undefined) out.since = publicSince;
  }
  if (last) {
    if (last.syscap) out.syscap = last.syscap;
    if (last.systemApi) out.systemApi = true;
    const doc = [...parsed].reverse().find((t) => t.doc)?.doc;
    if (doc) out.doc = doc;
  }
  return out;
}

/** The tags of a file's `@file` header block (`@kit`, and in C headers `@syscap` and `@since`). */
export function fileHeaderTags(text: string): DocTags {
  const head = text.slice(0, 4000);
  const re = /\/\*\*[\s\S]*?\*\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    if (/@file\b/.test(m[0])) return parseDocBlock(m[0]);
  }
  return {};
}
