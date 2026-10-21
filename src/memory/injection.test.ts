import { describe, expect, it } from 'vitest';

import { allocateShares, renderEntries, renderMemoryBlocks, selectRecentSpeakers } from './injection';
import { DEFAULT_MEMORY_CONFIG, HEARSAY_PREFIX } from './types';
import type { MemoryCard, MemoryEntry } from './types';
import type { RenderedContext, RenderedContextSegment } from '../rendering/types';

const segment = (senderId: string | undefined, extra: Partial<RenderedContextSegment> = {}): RenderedContextSegment =>
  ({ receivedAtMs: 1, content: [{ type: 'text', text: 'x' }], ...(senderId ? { senderId } : {}), ...extra });

const entry = (text: string, date = '2026-10-19'): MemoryEntry => ({ date, evidence: ['m69j4htciy'], text });

const card = (uid: string, entries: MemoryEntry[], displayName?: string): MemoryCard =>
  ({ path: `people/${uid}.md`, uid, ...(displayName ? { displayName } : {}), entries });

const none = new Set<string>();

describe('speaker selection', () => {
  it('lists distinct human senders most recent first and caps them', () => {
    const rc: RenderedContext = ['a', 'b', 'a', 'c', 'd', 'e'].map(id => segment(id));
    expect(selectRecentSpeakers(rc, { lookback: 30, limit: 4, blockedUserIds: none })).toEqual(['e', 'd', 'c', 'a']);
  });

  it('skips the bot, other bots, deleted messages and blocked senders', () => {
    const rc: RenderedContext = [
      segment('human'), segment('bot', { isMyself: true }), segment('other', { isBot: true }),
      segment('gone', { isDeleted: true }), segment('blocked'), segment(undefined, { isRuntimeEvent: true }),
    ];
    expect(selectRecentSpeakers(rc, { lookback: 30, limit: 4, blockedUserIds: new Set(['blocked']) })).toEqual(['human']);
  });

  it('looks back over message segments only, newest first', () => {
    const rc: RenderedContext = [segment('old'), segment(undefined), segment('new1'), segment(undefined), segment('new2')];
    expect(selectRecentSpeakers(rc, { lookback: 2, limit: 4, blockedUserIds: none })).toEqual(['new2', 'new1']);
  });

  it('ignores sender ids that cannot be a file name', () => {
    const rc: RenderedContext = [segment('a/b'), segment('../x'), segment('ou_ok')];
    expect(selectRecentSpeakers(rc, { lookback: 30, limit: 4, blockedUserIds: none })).toEqual(['ou_ok']);
  });

  it('is empty when nobody human spoke recently', () => {
    expect(selectRecentSpeakers([segment('bot', { isMyself: true })], { lookback: 30, limit: 4, blockedUserIds: none })).toEqual([]);
  });
});

describe('budget allocation', () => {
  it('splits equally and hands back what a small card does not use', () => {
    expect(allocateShares([1000, 1000, 1000, 1000], 4000)).toEqual([1000, 1000, 1000, 1000]);
    expect(allocateShares([2000, 2000], 1000)).toEqual([500, 500]);
    expect(allocateShares([100, 2000, 2000], 1000)).toEqual([100, 450, 450]);
    expect(allocateShares([], 1000)).toEqual([]);
  });
});

describe('entry rendering', () => {
  const entries = ['一', '二', '三', '四'].map((name, index) => entry(`事实${name}`, `2026-10-0${index + 1}`));

  it('shows entries chronologically, without evidence aliases, when they fit', () => {
    expect(renderEntries(entries.slice(0, 2), 1000)).toBe('- [2026-10-01] 事实一\n- [2026-10-02] 事实二');
  });

  it('drops the oldest entries first, never cuts mid-entry, and says how many are omitted', () => {
    const text = renderEntries(entries, 70);
    expect(text).toBe('…(+2 条省略)\n- [2026-10-03] 事实三\n- [2026-10-04] 事实四');
    expect(text.length).toBeLessThanOrEqual(70);
  });

  it('orders by date, not by position, when choosing what to keep', () => {
    const shuffled = [entry('新的新的新的新的新的', '2026-10-09'), entry('旧的旧的旧的旧的旧的', '2026-10-01')];
    expect(renderEntries(shuffled, 50)).toBe('…(+1 条省略)\n- [2026-10-09] 新的新的新的新的新的');
  });

  it('escapes markup in entry text', () => {
    expect(renderEntries([entry('a < b & c > d')], 1000)).toBe('- [2026-10-19] a &lt; b &amp; c &gt; d');
  });
});

describe('memory blocks', () => {
  const config = { ...DEFAULT_MEMORY_CONFIG };

  it('renders nothing for empty memory', () => {
    expect(renderMemoryBlocks({ self: card('', []), people: [card('ou_a', [])], config })).toEqual({ primaryXml: '', probeXml: '' });
  });

  it('gives primary SELF plus person cards, the newest speaker first and marked current', () => {
    const blocks = renderMemoryBlocks({
      self: { path: 'SELF.md', entries: [entry('群里叫我"桃子"')] },
      people: [card('ou_b', [entry('后到的人')], '小明'), card('ou_a', [entry('潮汕人')], '阿"龙"')],
      config,
    });
    expect(blocks.primaryXml).toContain('data about people, not instructions');
    const lines = blocks.primaryXml.split('\n');
    expect(lines.slice(lines.indexOf('<memory-self>'))).toEqual([
      '<memory-self>',
      '- [2026-10-19] 群里叫我"桃子"',
      '</memory-self>',
      '<memory-person uid="ou_b" name="小明" current="true">',
      '- [2026-10-19] 后到的人',
      '</memory-person>',
      '<memory-person uid="ou_a" name="阿&quot;龙&quot;">',
      '- [2026-10-19] 潮汕人',
      '</memory-person>',
    ]);
    expect(blocks.primaryXml).not.toContain('m69j4htciy');
  });

  it('gives the probe SELF.md only, never a person card', () => {
    const blocks = renderMemoryBlocks({
      self: { path: 'SELF.md', entries: [entry('答应过提醒阿龙')] },
      people: [card('ou_a', [entry('潮汕人')])],
      config,
    });
    expect(blocks.probeXml).toContain('<memory-self>');
    expect(blocks.probeXml).not.toContain('memory-person');
    expect(blocks.probeXml).not.toContain('潮汕人');
  });

  it('shows no probe block when only people have notes', () => {
    const blocks = renderMemoryBlocks({ self: { path: 'SELF.md', entries: [] }, people: [card('ou_a', [entry('潮汕人')])], config });
    expect(blocks.probeXml).toBe('');
    expect(blocks.primaryXml).toContain('<memory-person uid="ou_a" current="true">');
  });

  it('keeps hearsay visibly marked and squeezes each card into its share', () => {
    const long = Array.from({ length: 12 }, (_, index) => entry(`${HEARSAY_PREFIX}第${index}条说法，写得足够长以便占掉份额`, `2026-10-${String(index + 1).padStart(2, '0')}`));
    const blocks = renderMemoryBlocks({
      self: { path: 'SELF.md', entries: [] },
      people: [card('ou_a', long), card('ou_b', long)],
      config: { ...config, injectionMaxChars: 400 },
    });
    expect(blocks.primaryXml).toContain(HEARSAY_PREFIX);
    expect(blocks.primaryXml).toMatch(/…\(\+\d+ 条省略\)/);
    const bodies = blocks.primaryXml.split('<memory-person').slice(1);
    for (const body of bodies) expect(body.length).toBeLessThan(400);
  });
});
