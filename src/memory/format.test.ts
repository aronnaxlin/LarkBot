import { describe, expect, it } from 'vitest';

import {
  bodyChars,
  defaultHeader,
  findEntryByText,
  hearsayStats,
  isDuplicateText,
  localDate,
  nameFromHeader,
  parseFile,
  refreshHeader,
  sanitizeName,
  serializeFile,
} from './format';
import { HEARSAY_PREFIX } from './types';
import type { MemoryEntry, MemoryFileContent } from './types';

const entry = (text: string, date = '2026-10-19', evidence: string[] = ['m69j4htciy']): MemoryEntry => ({ date, evidence, text });

const card: MemoryFileContent = {
  header: '# 阿龙 (ou_9f1c)',
  entries: [
    entry('潮汕人，在深圳做嵌入式。'),
    entry('群里叫他"阿龙"、"龙哥"。', '2026-10-20', ['m69j4htciy', 'm7aa2bb3xq']),
    entry(`${HEARSAY_PREFIX}他最近在相亲。`, '2026-10-21', ['m0k3x9p2aa']),
  ],
};

describe('memory file format', () => {
  it('round-trips the canonical form byte for byte', () => {
    const bytes = serializeFile(card);
    expect(bytes).toBe([
      '# 阿龙 (ou_9f1c)',
      '',
      '- [2026-10-19] [m69j4htciy] 潮汕人，在深圳做嵌入式。',
      '§',
      '- [2026-10-20] [m69j4htciy, m7aa2bb3xq] 群里叫他"阿龙"、"龙哥"。',
      '§',
      `- [2026-10-21] [m0k3x9p2aa] ${HEARSAY_PREFIX}他最近在相亲。`,
      '',
    ].join('\n'));
    const parsed = parseFile(bytes);
    expect(parsed).toEqual({ ok: true, file: card });
    expect(serializeFile((parsed as { file: MemoryFileContent }).file)).toBe(bytes);
  });

  it('serializes an empty card as just its header', () => {
    expect(serializeFile({ header: '# SELF', entries: [] })).toBe('# SELF\n');
    expect(parseFile('# SELF\n')).toEqual({ ok: true, file: { header: '# SELF', entries: [] } });
  });

  it('tolerates a hand edit but then no longer round-trips', () => {
    const edited = '# 阿龙 (ou_9f1c)\n\n\n  - [2026-10-19] [m69j4htciy] 一\n\n§\n§\n- [2026-10-20] 手写，没有证据\n\n';
    const parsed = parseFile(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.file.entries).toEqual([
      entry('一'),
      { date: '2026-10-20', evidence: [], text: '手写，没有证据' },
    ]);
    expect(serializeFile(parsed.file)).not.toBe(edited);
  });

  it('refuses files it cannot read instead of guessing', () => {
    expect(parseFile('')).toMatchObject({ ok: false });
    expect(parseFile('no header\n\n- [2026-10-19] x')).toMatchObject({ ok: false });
    expect(parseFile('# h\n\njust prose')).toMatchObject({ ok: false });
    expect(parseFile('# h\n\n- [2026-10-19] first\ncontinuation line')).toMatchObject({ ok: false });
  });

  it('treats a bracket that is not an alias list as text', () => {
    const parsed = parseFile('# h\n\n- [2026-10-19] [不是证据] 正文');
    expect(parsed).toEqual({ ok: true, file: { header: '# h', entries: [{ date: '2026-10-19', evidence: [], text: '[不是证据] 正文' }] } });
  });

  it('counts the budget over entries only, header excluded', () => {
    const body = bodyChars(card.entries);
    const bytes = serializeFile(card);
    expect(body).toBe(bytes.length - '# 阿龙 (ou_9f1c)\n\n'.length - 1);
    expect(bodyChars([])).toBe(0);
  });

  it('measures hearsay by prefix', () => {
    expect(hearsayStats(card.entries)).toEqual({ count: 1, chars: card.entries[2]!.text.length });
  });

  it('computes the local date with the message offset', () => {
    // 2026-10-20T23:30:00Z is already the 21st at UTC+8 and still the 20th at UTC-5.
    const ts = Date.UTC(2026, 9, 20, 23, 30) / 1000;
    expect(localDate(ts, 0)).toBe('2026-10-20');
    expect(localDate(ts, 480)).toBe('2026-10-21');
    expect(localDate(ts, -300)).toBe('2026-10-20');
  });

  it('finds exactly one entry by quoted text', () => {
    expect(findEntryByText(card.entries, '做嵌入式')).toEqual({ kind: 'found', index: 0 });
    expect(findEntryByText(card.entries, '不存在的东西')).toEqual({ kind: 'not_found' });
    expect(findEntryByText(card.entries, '他')).toEqual({ kind: 'ambiguous' });
  });

  it('detects duplicates inside one source class only', () => {
    const entries = [entry('住在深圳南山'), entry(`${HEARSAY_PREFIX}在相亲`)];
    expect(isDuplicateText(entries, '住在深圳')).toBe(true);
    expect(isDuplicateText(entries, '  住在深圳南山 ')).toBe(true);
    // a plain fact matching only a hearsay entry is the upgrade case, not a duplicate
    expect(isDuplicateText(entries, '在相亲')).toBe(false);
    expect(isDuplicateText(entries, `${HEARSAY_PREFIX}在相亲`)).toBe(true);
    // the entry a replace rewrites is excluded from the comparison
    expect(isDuplicateText(entries, '住在深圳', 0)).toBe(false);
  });

  it('keeps machine headers current and hand-reworded ones verbatim', () => {
    expect(defaultHeader('people/ou_1.md', '阿龙')).toBe('# 阿龙 (ou_1)');
    expect(defaultHeader('people/ou_1.md')).toBe('# ou_1');
    expect(defaultHeader('SELF.md')).toBe('# SELF');
    expect(nameFromHeader('# 阿龙 (ou_1)', 'ou_1')).toBe('阿龙');
    expect(refreshHeader('# 阿龙 (ou_1)', 'people/ou_1.md', '龙哥')).toBe('# 龙哥 (ou_1)');
    expect(refreshHeader('# ou_1', 'people/ou_1.md', '龙哥')).toBe('# 龙哥 (ou_1)');
    expect(refreshHeader('# 手写的标题', 'people/ou_1.md', '龙哥')).toBe('# 手写的标题');
    expect(refreshHeader('# SELF', 'SELF.md', '龙哥')).toBe('# SELF');
  });

  it('sanitizes names that reach a header or an attribute', () => {
    expect(sanitizeName('a"<b>&`c`\n{d}§')).toBe('a b c d');
    expect([...sanitizeName('x'.repeat(100))]).toHaveLength(40);
  });
});
