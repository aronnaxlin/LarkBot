import { HEARSAY_PREFIX, MEMORY_ID_PATTERN, SELF_PATH } from './types';
import type { MemoryEntry, MemoryFileContent, MemoryPath } from './types';

// Separator line between entries, and the length it adds to the body.
export const ENTRY_SEPARATOR = '§';
const SEPARATOR_CHARS = `\n${ENTRY_SEPARATOR}\n`.length;

// Entries a model writes are bounded; hand-written ones are not re-checked.
export const MAX_EVIDENCE_PER_ENTRY = 6;

// `- [YYYY-MM-DD] [alias, alias] text`. The alias group is optional so a
// maintainer's hand-written entry without evidence still parses; a bracket that
// does not look like aliases is part of the text.
const ENTRY_LINE = /^- \[(\d{4}-\d{2}-\d{2})\] (?:\[([A-Za-z0-9_-]+(?:, [A-Za-z0-9_-]+)*)\] )?(\S.*)$/;

export const serializeEntry = (entry: MemoryEntry): string =>
  entry.evidence.length > 0
    ? `- [${entry.date}] [${entry.evidence.join(', ')}] ${entry.text}`
    : `- [${entry.date}] ${entry.text}`;

export const serializeFile = (file: MemoryFileContent): string =>
  file.entries.length === 0
    ? `${file.header}\n`
    : `${file.header}\n\n${file.entries.map(serializeEntry).join(`\n${ENTRY_SEPARATOR}\n`)}\n`;

export type ParseResult =
  | { ok: true; file: MemoryFileContent }
  | { ok: false; error: string };

// Tolerant about blank lines, indentation and missing/duplicated separators (a
// hand edit); strict about the header and about every other line being an entry.
// Anything else is refused rather than guessed at.
export const parseFile = (content: string): ParseResult => {
  const lines = content.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim());
  const nonBlank = lines.map((line, index) => ({ line, number: index + 1 })).filter(item => item.line !== '');
  const first = nonBlank[0];
  if (!first?.line.startsWith('# ')) return { ok: false, error: 'missing "# " header line' };
  const entries: MemoryEntry[] = [];
  for (const { line, number } of nonBlank.slice(1)) {
    if (line === ENTRY_SEPARATOR) continue;
    const match = ENTRY_LINE.exec(line);
    if (!match) return { ok: false, error: `line ${number} is not an entry ("- [YYYY-MM-DD] [ids] text")` };
    entries.push({
      date: match[1]!,
      evidence: match[2] ? match[2].split(', ') : [],
      text: match[3]!,
    });
  }
  return { ok: true, file: { header: first.line, entries } };
};

/** Characters of the serialized entries, header excluded; what the budgets count. */
export const bodyChars = (entries: readonly MemoryEntry[]): number =>
  entries.reduce((sum, entry) => sum + serializeEntry(entry).length, 0)
  + Math.max(0, entries.length - 1) * SEPARATOR_CHARS;

/** Serialized size of one entry including the separator that precedes it. */
export const entryChars = (entry: MemoryEntry): number => serializeEntry(entry).length + SEPARATOR_CHARS;

export const normalizeText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

export const isHearsayText = (text: string): boolean => text.startsWith(HEARSAY_PREFIX);

export const isHearsay = (entry: MemoryEntry): boolean => isHearsayText(entry.text);

export const hearsayStats = (entries: readonly MemoryEntry[]): { count: number; chars: number } => {
  let count = 0;
  let chars = 0;
  for (const entry of entries) {
    if (!isHearsay(entry)) continue;
    count++;
    chars += entry.text.length;
  }
  return { count, chars };
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Local date of a message: platform time shifted by that message's own offset. */
export const localDate = (timestampSec: number, utcOffsetMin: number): string => {
  const date = new Date((timestampSec + utcOffsetMin * 60) * 1000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

export type EntryMatch =
  | { kind: 'found'; index: number }
  | { kind: 'not_found' }
  | { kind: 'ambiguous' };

/** The single entry whose text contains `oldText`; zero or several is an error. */
export const findEntryByText = (entries: readonly MemoryEntry[], oldText: string): EntryMatch => {
  const needle = normalizeText(oldText);
  const hits: number[] = [];
  entries.forEach((entry, index) => {
    if (normalizeText(entry.text).includes(needle)) hits.push(index);
  });
  if (hits.length === 0) return { kind: 'not_found' };
  if (hits.length > 1) return { kind: 'ambiguous' };
  return { kind: 'found', index: hits[0]! };
};

/** Normalized text without the hearsay prefix, for class-independent comparison. */
export const withoutPrefix = (text: string): string => normalizeText(isHearsayText(text) ? text.slice(HEARSAY_PREFIX.length) : text);

/**
 * Whether `text` equals, or is contained in, a surviving entry of the same
 * source class. `excludeIndex` is the entry a replace is rewriting, so a
 * shortened rewrite cannot collide with the text it replaces.
 */
export const isDuplicateText = (entries: readonly MemoryEntry[], text: string, excludeIndex?: number): boolean => {
  const hearsay = isHearsayText(text);
  const needle = withoutPrefix(text);
  return entries.some((entry, index) =>
    index !== excludeIndex && isHearsay(entry) === hearsay && withoutPrefix(entry.text).includes(needle));
};

// Names reach a header and, later, a prompt attribute: keep them short and
// free of anything that could break the line or the markup.
export const sanitizeName = (name: string): string =>
  [...name.replace(/[<>"&`{}§\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('');

export const defaultHeader = (path: MemoryPath, name?: string): string => {
  if (path === SELF_PATH) return '# SELF';
  const uid = path.slice('people/'.length, -'.md'.length);
  const label = sanitizeName(name ?? '');
  return label ? `# ${label} (${uid})` : `# ${uid}`;
};

/** Name part of a machine-written `# <name> (<uid>)` header; undefined otherwise. */
export const nameFromHeader = (header: string, uid: string): string | undefined => {
  const suffix = ` (${uid})`;
  if (!header.startsWith('# ') || !header.endsWith(suffix)) return undefined;
  const name = sanitizeName(header.slice(2, header.length - suffix.length));
  return name === '' ? undefined : name;
};

/**
 * Refresh the name in a machine-written header after a rename. A header a
 * maintainer reworded no longer has the machine shape and is kept verbatim.
 */
export const refreshHeader = (header: string, path: MemoryPath, name: string | undefined): string => {
  if (path === SELF_PATH || !name) return header;
  const uid = path.slice('people/'.length, -'.md'.length);
  if (header === `# ${uid}` || nameFromHeader(header, uid) !== undefined) return defaultHeader(path, name);
  return header;
};

export const isValidMemoryId = (id: string): boolean => MEMORY_ID_PATTERN.test(id);
