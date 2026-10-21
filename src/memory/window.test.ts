import { describe, expect, it } from 'vitest';

import { alias, BOT, CHAT, del, makeWindow, msg, user } from './test-support';
import { buildMemoryWindow } from './window';
import type { CanonicalEditEvent } from '../adaptation/types';

const A = user('ou_a', '阿龙');
const B = user('ou_b', '小明');
const T = Date.UTC(2026, 9, 20, 12);

describe('memory window', () => {
  const window = makeWindow([
    msg({ id: 'om_1', sender: A, at: T + 1, text: '你好' }),
    msg({ id: 'om_2', sender: A, at: T + 2 }),
    msg({ id: 'om_3', sender: B, at: T + 3 }),
    msg({ id: 'om_4', sender: user(BOT, '莱克', true), at: T + 4, selfSent: true }),
    msg({ id: 'om_5', sender: user('ou_bot2', 'other', true), at: T + 5 }),
    msg({ id: 'om_6', sender: user('ou_blocked', '屏蔽'), at: T + 6 }),
    msg({ id: 'om_7', sender: user('ou_gone', '删光了'), at: T + 7 }),
    del(['om_7'], T + 8),
  ], { blocked: ['ou_blocked'] });

  it('indexes every message under its alias and its canonical id', () => {
    expect(window.messages.get(alias('om_1'))).toBe(window.messages.get('om_1'));
    expect(window.messages.get(alias('om_1'))).toMatchObject({ canonicalId: 'om_1', displayId: alias('om_1'), senderId: 'ou_a', kind: 'human', deleted: false, blocked: false });
  });

  it('classifies senders and flags deleted and blocked messages', () => {
    const kind = (id: string) => window.messages.get(id)?.kind;
    expect([kind('om_1'), kind('om_4'), kind('om_5')]).toEqual(['human', 'self', 'bot']);
    expect(window.messages.get('om_6')?.blocked).toBe(true);
    expect(window.messages.get('om_7')?.deleted).toBe(true);
  });

  it('lists only live, unblocked human speakers, most active first', () => {
    expect(window.speakers).toEqual([
      { uid: 'ou_a', displayName: '阿龙', messageCount: 2 },
      { uid: 'ou_b', displayName: '小明', messageCount: 1 },
    ]);
    expect(window.humanMessageCount).toBe(3);
  });

  it('ends at the newest event it holds and renders like the live chatlog', () => {
    expect(window.endMs).toBe(T + 8);
    expect(window.xml).toContain(`<message id="${alias('om_1')}"`);
    expect(window.xml).toContain('你好');
    expect(window.xml).toContain('blocked="true"');
    expect(window.xml).toContain('deleted="true"');
  });

  it('keeps an edited message under its original alias with the edited text', () => {
    const edit: CanonicalEditEvent = {
      type: 'edit', chatId: CHAT, messageId: 'om_1', sender: A, receivedAtMs: T + 9, timestampSec: Math.floor((T + 9) / 1000),
      utcOffsetMin: 0, content: [{ type: 'text', text: '改过了' }], attachments: [],
    };
    const edited = makeWindow([msg({ id: 'om_1', sender: A, at: T + 1, text: '你好' }), edit]);
    expect(edited.xml).toContain(`id="${alias('om_1')}"`);
    expect(edited.xml).toContain('改过了');
    expect(edited.xml).not.toContain('你好');
  });

  it('uses canonical ids where the platform renders them', () => {
    const plain = makeWindow([msg({ id: '4242', sender: A, at: T + 1 })], { aliasMessageIds: false });
    expect(plain.messages.get('4242')?.displayId).toBe('4242');
    expect(plain.xml).toContain('<message id="4242"');
  });

  it('never applies the compaction cursor to its own render', () => {
    const cursored = buildMemoryWindow({
      chatId: CHAT,
      events: [msg({ id: 'om_1', sender: A, at: T + 1 })],
      fromMs: 0,
      renderParams: { botUserId: BOT, aliasMessageIds: true, compactCursorMs: T + 1_000_000 },
      blockedUserIds: new Set(),
    });
    expect(cursored.xml).toContain(alias('om_1'));
  });

  it('prefers contact names for speakers and keeps the cursor as the end of an empty window', () => {
    const named = buildMemoryWindow({
      chatId: CHAT,
      events: [msg({ id: 'om_1', sender: A, at: T + 1 })],
      fromMs: 0,
      renderParams: { botUserId: BOT, contactNames: new Map([['ou_a', '龙哥']]) },
      blockedUserIds: new Set(),
    });
    expect(named.speakers[0]?.displayName).toBe('龙哥');
    expect(makeWindow([], { fromMs: 55 }).endMs).toBe(55);
  });
});
