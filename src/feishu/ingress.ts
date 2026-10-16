import type { Logger } from '@guiiai/logg';

import {
  adaptFeishuMessage,
  adaptFeishuRecall,
  feishuSenderOpenId,
  messageDedupKey,
  recallDedupKey,
} from './adaptation';
import type { FeishuIngressMeta } from './adaptation';
import { parseMessageRecalledEvent, parseMessageReceiveEvent } from './events';
import type { FeishuUserNames } from './user-names';
import type { CanonicalIMEvent, CanonicalMessageEvent } from '../adaptation/types';
import type { EventSink } from '../event-sink';

export interface FeishuEventStore {
  hasDedupKey(chatId: string, dedupKey: string): boolean;
  // Atomic insert-if-absent on (chatId, dedupKey); false means duplicate.
  persist(event: CanonicalIMEvent, dedupKey: string): boolean;
}

// Feishu event ingress: validation → chat filter → dedup → adaptation →
// persistence → Pipeline publication.
//
// Delivery contract: the SDK acknowledges an event only after its handler
// resolves, and Feishu re-delivers unacknowledged events (3-second deadline).
// Handlers therefore resolve only after the canonical event is persisted, so
// an acknowledged event is never lost. Recovery cases:
// - duplicate delivery after persistence → the dedup key skips it;
// - concurrent duplicate while the first is still processing → it awaits and
//   reports the first attempt's outcome;
// - crash between persistence and publication → cold replay rebuilds the chat
//   from the events table on the next start;
// - publication failure in-process → the persisted event is kept in memory
//   and published by the next delivery of the same event (the handler failure
//   makes Feishu re-deliver it).
//
// Only configured group chats are accepted. Direct messages and unconfigured
// groups are dropped without being archived.
export const createFeishuIngress = (deps: {
  configuredChatIds: ReadonlySet<string>;
  userNames: FeishuUserNames;
  store: FeishuEventStore;
  sink: Pick<EventSink, 'publish'>;
  logger: Logger;
  now?: () => number;
}) => {
  const log = deps.logger.withContext('feishu:ingress');
  const now = deps.now ?? Date.now;
  const chatTails = new Map<string, Promise<void>>();
  const inFlight = new Map<string, Promise<void>>();
  const unpublished = new Map<string, CanonicalIMEvent>();

  const captureMeta = (): FeishuIngressMeta => {
    const receivedAtMs = now();
    return { receivedAtMs, utcOffsetMin: -new Date(receivedAtMs).getTimezoneOffset() };
  };

  // Serialize per chat so Pipeline publication follows arrival order even when
  // name lookups take different amounts of time.
  const enqueue = (chatId: string, task: () => Promise<void>): Promise<void> => {
    const run = (chatTails.get(chatId) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    chatTails.set(chatId, tail);
    void tail.then(() => {
      if (chatTails.get(chatId) === tail) chatTails.delete(chatId);
    });
    return run;
  };

  const publish = (id: string, event: CanonicalIMEvent): void => {
    unpublished.set(id, event);
    deps.sink.publish(event, event.type === 'delete'
      ? { hydrateAltText: false }
      : event.type === 'message' && event.isSelfSent ? { notifyDriver: false } : undefined);
    unpublished.delete(id);
  };

  const ingest = (
    chatId: string,
    dedupKey: string,
    build: () => Promise<CanonicalIMEvent>,
  ): Promise<void> => {
    const id = `${chatId}\n${dedupKey}`;
    const existing = inFlight.get(id);
    if (existing) return existing;

    const task = enqueue(chatId, async () => {
      // Do not publish later events ahead of a durable event whose publication
      // failed. Reusing the same object also preserves EventSink idempotency.
      for (const [pendingId, pendingEvent] of unpublished) {
        if (pendingEvent.chatId === chatId) publish(pendingId, pendingEvent);
      }
      const pending = unpublished.get(id);
      if (pending) {
        publish(id, pending);
        return;
      }
      if (deps.store.hasDedupKey(chatId, dedupKey)) {
        log.withFields({ chatId, dedupKey }).debug('Duplicate delivery skipped');
        return;
      }
      const event = await build();
      if (!deps.store.persist(event, dedupKey)) {
        log.withFields({ chatId, dedupKey }).debug('Duplicate delivery skipped at insert');
        return;
      }
      publish(id, event);
    }).finally(() => {
      inFlight.delete(id);
    });
    inFlight.set(id, task);
    return task;
  };

  // Malformed payloads cannot succeed on redelivery, so they are logged and
  // acknowledged rather than rejected.
  const parseOrLog = <T>(kind: string, parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (error) {
      log.withFields({ kind, error: error instanceof Error ? error.message : String(error) })
        .error('Malformed Feishu event dropped');
      return undefined;
    }
  };

  const handleMessageReceive = async (data: unknown): Promise<void> => {
    const meta = captureMeta();
    const event = parseOrLog('im.message.receive_v1', () => parseMessageReceiveEvent(data));
    if (!event) return;
    const { chat_id: chatId, chat_type: chatType, message_id: messageId } = event.message;
    if (chatType !== 'group' || !deps.configuredChatIds.has(chatId)) {
      // Log level, not debug: a mis-scoped chat filter is otherwise invisible
      // in production and looks exactly like events never arriving.
      log.withFields({ chatId, chatType }).log('Message outside configured group chats ignored');
      return;
    }

    await ingest(chatId, messageDedupKey(messageId), async () => {
      for (const mention of event.message.mentions ?? []) {
        const openId = mention.id?.open_id;
        if (openId) deps.userNames.remember(openId, mention.name);
      }
      const openId = feishuSenderOpenId(event);
      const sender = {
        id: openId,
        displayName: await deps.userNames.resolve(chatId, openId),
        isBot: event.sender.sender_type !== 'user',
      };
      const canonical = adaptFeishuMessage(event, sender, meta);
      log.withFields({
        chatId,
        messageId,
        senderId: openId,
        messageType: event.message.message_type,
      }).log('Message received');
      return canonical;
    });
  };

  const handleMessageRecalled = async (data: unknown): Promise<void> => {
    const meta = captureMeta();
    const event = parseOrLog('im.message.recalled_v1', () => parseMessageRecalledEvent(data));
    if (!event) return;
    if (!deps.configuredChatIds.has(event.chat_id)) {
      log.withFields({ chatId: event.chat_id }).log('Recall outside configured group chats ignored');
      return;
    }
    await ingest(event.chat_id, recallDedupKey(event.message_id), async () => {
      log.withFields({ chatId: event.chat_id, messageId: event.message_id }).log('Message recalled');
      return adaptFeishuRecall(event, meta);
    });
  };

  // Synthetic self-event for a message this bot sent. Feishu never delivers a
  // bot's own messages back to it, so this is the only way they enter context.
  const acceptSelfSent = (event: CanonicalMessageEvent): void => {
    if (!deps.store.persist(event, messageDedupKey(event.messageId))) return;
    const id = `${event.chatId}\n${messageDedupKey(event.messageId)}`;
    unpublished.set(id, event);
    deps.sink.publish(event, { notifyDriver: false });
    unpublished.delete(id);
  };

  return { handleMessageReceive, handleMessageRecalled, acceptSelfSent };
};

export type FeishuIngress = ReturnType<typeof createFeishuIngress>;
