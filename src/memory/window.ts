import { createEmptyIC, reduce } from '../projection';
import type { PipelineEvent } from '../projection';
import { rcToXml, render } from '../rendering';
import type { RenderParams } from '../rendering';
import { buildMessageAliases } from '../rendering/aliases';

export interface WindowMessage {
  canonicalId: string;
  // The id the chatlog shows: an alias, or the canonical id when aliasing is off
  // or lost a hash collision.
  displayId: string;
  senderId?: string;
  // `bot` is another bot, `unknown` has no sender; neither may be cited.
  kind: 'human' | 'self' | 'bot' | 'unknown';
  blocked: boolean;
  deleted: boolean;
  receivedAtMs: number;
  timestampSec: number;
  utcOffsetMin: number;
}

export interface MemorySpeaker {
  uid: string;
  displayName: string;
  messageCount: number;
}

export interface MemoryWindow {
  // Chatlog XML, rendered exactly like the live context (same aliases, same blocking).
  xml: string;
  // Keyed by displayId AND canonicalId: canonical ids stay valid evidence.
  messages: Map<string, WindowMessage>;
  // Distinct human senders (non-self, non-bot, non-blocked), most active first.
  speakers: MemorySpeaker[];
  humanMessageCount: number;
  // Newest event the window holds; the cursor moves here after a successful run.
  endMs: number;
  // The archive held more human messages than maxWindowMessages.
  truncated: boolean;
}

/**
 * Build the consolidator's input from persisted events. The IC is throwaway: it
 * never enters the Pipeline, and it starts at the memory cursor, never at the
 * compaction cursor (the compaction cursor is ahead of what memory has seen).
 */
export const buildMemoryWindow = (params: {
  chatId: string;
  events: PipelineEvent[];
  fromMs: number;
  renderParams: RenderParams;
  blockedUserIds: ReadonlySet<string>;
  truncated?: boolean;
}): MemoryWindow => {
  let ic = createEmptyIC(params.chatId);
  for (const event of params.events) ic = reduce(ic, event);
  const renderParams: RenderParams = {
    ...params.renderParams,
    ...(params.blockedUserIds.size > 0 ? { blockedUserIds: params.blockedUserIds } : {}),
  };
  delete renderParams.compactCursorMs;
  const rendered = render(ic, renderParams);
  const aliases = params.renderParams.aliasMessageIds === true ? buildMessageAliases(ic) : null;
  const botUserId = params.renderParams.botUserId;

  const messages = new Map<string, WindowMessage>();
  const counts = new Map<string, MemorySpeaker>();
  let humanMessageCount = 0;
  for (const node of ic.nodes) {
    if (node.type !== 'message') continue;
    const sender = node.sender;
    const isSelf = node.isSelfSent === true || (botUserId !== undefined && sender?.id === botUserId);
    const kind: WindowMessage['kind'] = isSelf
      ? 'self'
      : !sender ? 'unknown' : sender.isBot ? 'bot' : 'human';
    const blocked = sender !== undefined && params.blockedUserIds.has(sender.id);
    const message: WindowMessage = {
      canonicalId: node.messageId,
      displayId: aliases?.get(node.messageId) ?? node.messageId,
      ...(sender ? { senderId: sender.id } : {}),
      kind,
      blocked,
      deleted: node.deleted === true,
      receivedAtMs: node.receivedAtMs,
      timestampSec: node.timestampSec,
      utcOffsetMin: node.utcOffsetMin,
    };
    messages.set(message.displayId, message);
    messages.set(message.canonicalId, message);
    if (kind !== 'human' || blocked || message.deleted || !sender) continue;
    humanMessageCount++;
    const existing = counts.get(sender.id);
    if (existing) existing.messageCount++;
    else {
      const user = ic.users.get(sender.id)?.user ?? sender;
      const name = params.renderParams.contactNames?.get(sender.id)
        ?? (user.displayName !== '' ? user.displayName : (user.username ?? sender.id));
      counts.set(sender.id, { uid: sender.id, displayName: name, messageCount: 1 });
    }
  }

  const endMs = params.events.reduce((newest, event) => Math.max(newest, event.receivedAtMs), params.fromMs);
  return {
    xml: rcToXml(rendered),
    messages,
    speakers: [...counts.values()].sort((a, b) => b.messageCount - a.messageCount),
    humanMessageCount,
    endMs,
    truncated: params.truncated ?? false,
  };
};
