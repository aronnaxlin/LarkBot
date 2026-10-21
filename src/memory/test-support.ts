import { buildMemoryWindow } from './window';
import type { MemoryWindow } from './window';
import type { CanonicalDeleteEvent, CanonicalMessageEvent, CanonicalUser } from '../adaptation/types';
import { messageAlias } from '../rendering';

// Shared fixtures for the memory tests: realistic events rendered through the
// real window builder, so aliases, deletion and sender kinds behave as in production.

export const CHAT = 'oc_chat';
export const BOT = 'ou_bot';

export const user = (id: string, displayName = id, isBot = false): CanonicalUser => ({ id, displayName, isBot });

export const alias = (messageId: string): string => messageAlias(CHAT, messageId);

// 2026-10-21T00:00:00Z
export const T0_SEC = 1792540800;

export const msg = (params: {
  id: string;
  sender: CanonicalUser;
  text?: string;
  at: number;
  timestampSec?: number;
  offset?: number;
  selfSent?: boolean;
}): CanonicalMessageEvent => ({
  type: 'message',
  chatId: CHAT,
  messageId: params.id,
  sender: params.sender,
  receivedAtMs: params.at,
  timestampSec: params.timestampSec ?? Math.floor(params.at / 1000),
  utcOffsetMin: params.offset ?? 0,
  content: [{ type: 'text', text: params.text ?? `text of ${params.id}` }],
  attachments: [],
  ...(params.selfSent ? { isSelfSent: true } : {}),
});

export const del = (ids: string[], at: number): CanonicalDeleteEvent => ({
  type: 'delete',
  chatId: CHAT,
  messageIds: ids,
  receivedAtMs: at,
  timestampSec: Math.floor(at / 1000),
  utcOffsetMin: 0,
});

export const makeWindow = (
  events: Parameters<typeof buildMemoryWindow>[0]['events'],
  options: { fromMs?: number; blocked?: string[]; aliasMessageIds?: boolean } = {},
): MemoryWindow => buildMemoryWindow({
  chatId: CHAT,
  events,
  fromMs: options.fromMs ?? 0,
  renderParams: { botUserId: BOT, senderUid: true, aliasMessageIds: options.aliasMessageIds ?? true },
  blockedUserIds: new Set(options.blocked ?? []),
});
