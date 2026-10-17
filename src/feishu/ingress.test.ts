import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeishuDriverPlatform } from './driver-platform';
import { createFeishuIngress } from './ingress';
import { createFeishuUserNames } from './user-names';
import type { CanonicalIMEvent } from '../adaptation/types';
import { createDatabase, runMigrations } from '../db/client';
import type { DB } from '../db/client';
import { canonicalMessageExists, hasEventDedupKey, loadEvents, persistDedupedEvent } from '../db/persistence';
import { createEventSink } from '../event-sink';
import { createPipeline } from '../pipeline';
import type { RenderedContext } from '../rendering/types';

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('feishu-ingress-test');

// Synthetic identifiers only; no real chat content.
const CHAT = 'oc_synthetic_group';
const BOT = 'ou_synthetic_bot';
const ALICE = 'ou_synthetic_alice';

const opened: DB[] = [];
afterEach(() => opened.splice(0).forEach(db => db.$client.close()));

const receiveEvent = (overrides: {
  messageId?: string;
  chatId?: string;
  chatType?: string;
  text?: string;
  mentions?: unknown[];
  parentId?: string;
} = {}) => ({
  schema: '2.0',
  event_id: `ev_${Math.random()}`,
  event_type: 'im.message.receive_v1',
  sender: { sender_id: { open_id: ALICE, union_id: 'on_synthetic' }, sender_type: 'user' },
  message: {
    message_id: overrides.messageId ?? 'om_1',
    ...overrides.parentId ? { parent_id: overrides.parentId, root_id: overrides.parentId } : {},
    create_time: '1760000000000',
    chat_id: overrides.chatId ?? CHAT,
    chat_type: overrides.chatType ?? 'group',
    message_type: 'text',
    content: JSON.stringify({ text: overrides.text ?? 'hello' }),
    ...overrides.mentions ? { mentions: overrides.mentions } : {},
  },
});

const createFixture = (options: { db?: DB; failPublish?: () => boolean } = {}) => {
  let db = options.db;
  if (!db) {
    db = createDatabase(':memory:', logger);
    runMigrations(db, logger);
    opened.push(db);
  }
  const database = db;
  const pipeline = createPipeline({ botUserId: BOT });
  const driverEvents: Array<{ chatId: string; context: RenderedContext }> = [];
  const pushPipelineEvent = vi.fn((chatId: string, event: CanonicalIMEvent) => {
    if (options.failPublish?.()) throw new Error('synthetic publish failure');
    return pipeline.pushEvent(chatId, event);
  });
  const sink = createEventSink({
    configuredChatIds: new Set([CHAT]),
    persistEvent: () => {
      throw new Error('Feishu ingress must persist through the dedup store');
    },
    hydrateAltText: () => {},
    pushPipelineEvent,
    handleDriverEvent: (chatId, context) => driverEvents.push({ chatId, context }),
  });
  const fetchName = vi.fn(async (openId: string) => openId === ALICE ? 'Alice' : undefined);
  const ingress = createFeishuIngress({
    configuredChatIds: new Set([CHAT]),
    userNames: createFeishuUserNames({ fetchName, logger }),
    store: {
      hasDedupKey: (chatId, key) => hasEventDedupKey(database, chatId, key),
      persist: (event, key) => persistDedupedEvent(database, event, key),
    },
    sink,
    logger,
    now: () => 5000,
  });
  return { db: database, pipeline, ingress, driverEvents, pushPipelineEvent, fetchName };
};

describe('Feishu ingress', () => {
  it('stores string ids, a stable open_id sender, and mention identity', async () => {
    const f = createFixture();
    await f.ingress.handleMessageReceive(receiveEvent({
      text: '@_user_1 hi',
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'LarkBot' }],
    }));

    const [event] = loadEvents(f.db, CHAT);
    expect(event).toMatchObject({
      type: 'message',
      chatId: CHAT,
      messageId: 'om_1',
      sender: { id: ALICE, displayName: 'Alice', isBot: false },
      receivedAtMs: 5000,
      timestampSec: 1760000000,
      content: [
        { type: 'mention', userId: BOT, children: [{ type: 'text', text: '@LarkBot' }] },
        { type: 'text', text: ' hi' },
      ],
    });
    expect(f.driverEvents).toHaveLength(1);
    const [segment] = f.driverEvents[0]!.context;
    expect(segment).toMatchObject({ senderId: ALICE, mentionsMe: true });
    expect(segment!.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<mention uid="ou_synthetic_bot">@LarkBot</mention>') });
  });

  it('maps quoted replies to the parent message and detects replies to the bot', async () => {
    const f = createFixture();
    persistDedupedEvent(f.db, {
      type: 'message', chatId: CHAT, messageId: 'om_bot', sender: { id: BOT, displayName: 'LarkBot', isBot: true },
      receivedAtMs: 1000, timestampSec: 1, utcOffsetMin: 0, content: [{ type: 'text', text: 'earlier' }], attachments: [], isSelfSent: true,
    }, 'message:om_bot');
    f.pipeline.replayChat(CHAT, loadEvents(f.db, CHAT));

    await f.ingress.handleMessageReceive(receiveEvent({ messageId: 'om_2', parentId: 'om_bot' }));
    const [, reply] = loadEvents(f.db, CHAT);
    expect(reply).toMatchObject({ messageId: 'om_2', replyToMessageId: 'om_bot' });
    const segment = f.driverEvents[0]!.context.at(-1)!;
    expect(segment.repliesToMe).toBe(true);
    expect(segment.content[0]).toMatchObject({ text: expect.stringContaining('<in-reply-to id="om_bot" sender="LarkBot">earlier</in-reply-to>') });
  });

  it('drops direct messages and unconfigured groups without archiving them', async () => {
    const f = createFixture();
    await f.ingress.handleMessageReceive(receiveEvent({ chatType: 'p2p' }));
    await f.ingress.handleMessageReceive(receiveEvent({ chatId: 'oc_other' }));
    expect(loadEvents(f.db, CHAT)).toEqual([]);
    expect(loadEvents(f.db, 'oc_other')).toEqual([]);
    expect(f.fetchName).not.toHaveBeenCalled();
  });

  it('acknowledges malformed payloads without persisting them', async () => {
    const f = createFixture();
    await expect(f.ingress.handleMessageReceive({ message: { message_id: 'om_1' } })).resolves.toBeUndefined();
    expect(loadEvents(f.db, CHAT)).toEqual([]);
  });

  it('deduplicates sequential and concurrent redeliveries of the same message', async () => {
    const f = createFixture();
    await Promise.all([
      f.ingress.handleMessageReceive(receiveEvent()),
      f.ingress.handleMessageReceive(receiveEvent()),
    ]);
    await f.ingress.handleMessageReceive(receiveEvent());
    expect(loadEvents(f.db, CHAT)).toHaveLength(1);
    expect(f.pushPipelineEvent).toHaveBeenCalledTimes(1);
  });

  it('retries an unpublished message before publishing a later recall', async () => {
    let fail = true;
    const f = createFixture({ failPublish: () => fail });
    await expect(f.ingress.handleMessageReceive(receiveEvent())).rejects.toThrow('synthetic publish failure');
    fail = false;
    await f.ingress.handleMessageRecalled({
      message_id: 'om_1', chat_id: CHAT, recall_time: '1760000005000', recall_type: 'message_owner',
    });
    const published = f.pushPipelineEvent.mock.calls.slice(1).map(([, event]) => event.type);
    expect(published).toEqual(['message', 'delete']);
    expect(loadEvents(f.db, CHAT)).toHaveLength(2);
  });

  it('keeps a recall distinct from the message it targets, and deduplicates the recall', async () => {
    const f = createFixture();
    const recall = { message_id: 'om_1', chat_id: CHAT, recall_time: '1760000005000', recall_type: 'message_owner' };
    await f.ingress.handleMessageReceive(receiveEvent());
    await f.ingress.handleMessageRecalled(recall);
    await f.ingress.handleMessageRecalled(recall);
    await f.ingress.handleMessageReceive(receiveEvent());

    expect(loadEvents(f.db, CHAT).map(event => event.type)).toEqual(['message', 'delete']);
    expect(loadEvents(f.db, CHAT)[1]).toMatchObject({ messageIds: ['om_1'], timestampSec: 1760000005 });
    const segment = f.driverEvents.at(-1)!.context[0]!;
    expect(segment.content[0]).toMatchObject({ text: expect.stringContaining('deleted="true"') });
  });

  it('survives a crash between persistence and publication: restart skips the redelivery and replay restores it', async () => {
    let fail = true;
    const first = createFixture({ failPublish: () => fail });
    await expect(first.ingress.handleMessageReceive(receiveEvent())).rejects.toThrow('synthetic publish failure');
    expect(loadEvents(first.db, CHAT)).toHaveLength(1);

    // Simulated restart: fresh in-memory state over the same database.
    fail = false;
    const restarted = createFixture({ db: first.db });
    restarted.pipeline.replayChat(CHAT, loadEvents(first.db, CHAT));
    await restarted.ingress.handleMessageReceive(receiveEvent());
    expect(loadEvents(first.db, CHAT)).toHaveLength(1);
    expect(restarted.pushPipelineEvent).not.toHaveBeenCalled();
    expect(restarted.pipeline.getIC(CHAT)!.nodes).toHaveLength(1);
  });

  it('publishes a persisted-but-unpublished event when Feishu re-delivers it in the same process', async () => {
    let fail = true;
    const f = createFixture({ failPublish: () => fail });
    await expect(f.ingress.handleMessageReceive(receiveEvent())).rejects.toThrow();
    fail = false;
    await f.ingress.handleMessageReceive(receiveEvent());
    expect(loadEvents(f.db, CHAT)).toHaveLength(1);
    expect(f.pipeline.getIC(CHAT)!.nodes).toHaveLength(1);
    expect(f.driverEvents).toHaveLength(1);
  });
});

describe('Feishu send and synthetic self-events', () => {
  const sendFixture = (
    sendPost: Parameters<typeof createFeishuDriverPlatform>[0]['api']['sendPost'],
    isKnownParticipant: (chatId: string, openId: string) => boolean = () => true,
  ) => {
    const f = createFixture();
    let uuid = 0;
    const platform = createFeishuDriverPlatform({
      api: { sendPost, createReaction: vi.fn(), deleteReaction: vi.fn() },
      botInfo: () => ({ openId: BOT, name: 'LarkBot' }),
      acceptSelfSent: f.ingress.acceptSelfSent,
      messageExists: (chatId, messageId) => canonicalMessageExists(f.db, chatId, messageId),
      isKnownParticipant,
      logger,
      retryDelaysMs: [0, 0],
      newUuid: () => `uuid-${++uuid}`,
      now: () => 9000,
    });
    return { ...f, platform };
  };

  it('persists an isSelfSent event with the server message id without waking the Driver', async () => {
    const sendPost = vi.fn(async () => ({ messageId: 'om_sent', createTimeMs: 1760000010000 }));
    const f = sendFixture(sendPost);
    await f.ingress.handleMessageReceive(receiveEvent());
    const driverWakeups = f.driverEvents.length;

    await expect(f.platform.sendMessage(CHAT, 'hi **there**', 'om_1')).resolves.toEqual({ messageId: 'om_sent' });
    expect(sendPost).toHaveBeenCalledWith({
      chatId: CHAT,
      replyToMessageId: 'om_1',
      content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: 'hi **there**' }]] } }),
      uuid: 'uuid-1',
    });
    const self = loadEvents(f.db, CHAT).at(-1);
    expect(self).toMatchObject({
      type: 'message',
      messageId: 'om_sent',
      sender: { id: BOT, isBot: true },
      isSelfSent: true,
      replyToMessageId: 'om_1',
      timestampSec: 1760000010,
    });
    expect(f.driverEvents).toHaveLength(driverWakeups);
    expect(f.pipeline.getIC(CHAT)!.nodes.at(-1)).toMatchObject({ messageId: 'om_sent', isSelfSent: true });
    expect(f.platform.messageExists(CHAT, 'om_sent')).toBe(true);
    expect(f.platform.messageExists(CHAT, 'om_missing')).toBe(false);
  });

  it('sends an outgoing mention and renders the self-event with the mentioned identity', async () => {
    const sendPost = vi.fn(async () => ({ messageId: 'om_sent', createTimeMs: 1760000010000 }));
    const f = sendFixture(sendPost);
    await f.ingress.handleMessageReceive(receiveEvent());

    await f.platform.sendMessage(CHAT, `<at user_id="${ALICE}">Alice</at> 在呢`);
    expect(sendPost).toHaveBeenCalledWith(expect.objectContaining({
      content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: `<at user_id="${ALICE}">Alice</at> 在呢` }]] } }),
    }));
    expect(loadEvents(f.db, CHAT).at(-1)).toMatchObject({
      isSelfSent: true,
      content: [
        { type: 'mention', userId: ALICE, children: [{ type: 'text', text: '@Alice' }] },
        { type: 'text', text: ' 在呢' },
      ],
    });
    const rendered = new Map(f.pipeline.getRenderedChats()).get(CHAT)!;
    const self = rendered.at(-1)!;
    expect(self.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining(`<mention uid="${ALICE}">@Alice</mention> 在呢`),
    });
  });

  it('rejects a mention of an unknown participant before calling Feishu', async () => {
    const sendPost = vi.fn(async () => ({ messageId: 'om_sent', createTimeMs: 1 }));
    const f = sendFixture(sendPost, (_chatId, openId) => openId === ALICE);
    await expect(f.platform.sendMessage(CHAT, '<at user_id="ou_stranger">X</at> hi'))
      .rejects.toThrow('Unknown participant ou_stranger');
    expect(sendPost).not.toHaveBeenCalled();
    expect(loadEvents(f.db, CHAT).filter(event => event.type === 'message' && event.isSelfSent)).toHaveLength(0);
  });

  it('reuses the uuid across bounded retries of one send and uses a new one for the next message', async () => {
    const { FeishuApiError } = await import('./api');
    const sendPost = vi.fn()
      .mockRejectedValueOnce(new FeishuApiError('message.create', { httpStatus: 503 }))
      .mockRejectedValueOnce(new FeishuApiError('message.create', {}))
      .mockResolvedValueOnce({ messageId: 'om_a', createTimeMs: 1 })
      .mockResolvedValueOnce({ messageId: 'om_b', createTimeMs: 2 });
    const f = sendFixture(sendPost);
    await f.platform.sendMessage(CHAT, 'first');
    await f.platform.sendMessage(CHAT, 'second');
    expect(sendPost.mock.calls.map(([params]) => params.uuid)).toEqual(['uuid-1', 'uuid-1', 'uuid-1', 'uuid-2']);
  });

  it('stops after the retry budget and does not retry non-retryable errors', async () => {
    const { FeishuApiError } = await import('./api');
    const rateLimited = vi.fn(async () => {
      throw new FeishuApiError('message.create', { code: 99991400, msg: 'rate limited' });
    });
    await expect(sendFixture(rateLimited).platform.sendMessage(CHAT, 'x')).rejects.toThrow('code=99991400');
    expect(rateLimited).toHaveBeenCalledTimes(3);

    const forbidden = vi.fn(async () => {
      throw new FeishuApiError('message.create', { code: 230002, msg: 'bot not in chat', httpStatus: 400 });
    });
    const f = sendFixture(forbidden);
    await expect(f.platform.sendMessage(CHAT, 'x')).rejects.toThrow('code=230002');
    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(loadEvents(f.db, CHAT)).toEqual([]);
  });

  it('rejects attachments, empty text, and oversized messages before calling the API', async () => {
    const sendPost = vi.fn();
    const f = sendFixture(sendPost);
    await expect(f.platform.sendMessage(CHAT, 'x', undefined, [{ type: 'photo', path: 'x.png' }])).rejects.toThrow('attachments');
    await expect(f.platform.sendMessage(CHAT, '  ')).rejects.toThrow('empty');
    await expect(f.platform.sendMessage(CHAT, '字'.repeat(20_000))).rejects.toThrow('too long');
    expect(sendPost).not.toHaveBeenCalled();
    expect(f.platform.loadMessageAttachments).toBeUndefined();
    expect(f.platform.banSpammer).toBeUndefined();
  });
});
