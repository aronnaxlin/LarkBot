import { requireFeishuConfig } from '../../config/config';
import { canonicalMessageExists, hasEventDedupKey, loadEventsByMessageIds, persistDedupedEvent } from '../../db';
import {
  createFeishuBotIdentity,
  createFeishuDriverPlatform,
  createFeishuIngress,
  createFeishuSdk,
  createFeishuUserNames,
} from '../../feishu';
import type { PlatformRuntime } from '../../startup/platform';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

// Feishu services are resolved only when `platform: feishu`; nothing here
// touches TDLib.
export const registerFeishu = ({ get, register }: Registrar): void => {
  register(TOKENS.FEISHU_SDK, () =>
    createFeishuSdk(requireFeishuConfig(get(TOKENS.CONFIG)), get(TOKENS.LOGGER)));

  register(TOKENS.FEISHU_BOT_IDENTITY, () => createFeishuBotIdentity(get(TOKENS.FEISHU_SDK).api));

  // Shared by ingress (remember/resolve) and the driver platform (mention
  // validation), so participants seen only as mentions stay mentionable.
  register(TOKENS.FEISHU_USER_NAMES, () => {
    const pipeline = get(TOKENS.PIPELINE);
    return createFeishuUserNames({
      fetchName: get(TOKENS.FEISHU_SDK).api.getUserName,
      fallbackName: (chatId, openId) => pipeline.getIC(chatId)?.users.get(openId)?.user.displayName,
      logger: get(TOKENS.LOGGER),
    });
  });

  register(TOKENS.FEISHU_INGRESS, () => {
    const db = get(TOKENS.DB);
    const logger = get(TOKENS.LOGGER);
    return createFeishuIngress({
      configuredChatIds: get(TOKENS.CONFIGURED_CHAT_IDS),
      userNames: get(TOKENS.FEISHU_USER_NAMES),
      store: {
        hasDedupKey: (chatId, dedupKey) => hasEventDedupKey(db, chatId, dedupKey),
        persist: (event, dedupKey) => persistDedupedEvent(db, event, dedupKey),
      },
      sink: get(TOKENS.EVENT_SINK),
      logger,
    });
  });

  register(TOKENS.FEISHU_DRIVER_PLATFORM, () => {
    const db = get(TOKENS.DB);
    const sdk = get(TOKENS.FEISHU_SDK);
    return createFeishuDriverPlatform({
      api: sdk.api,
      botInfo: get(TOKENS.FEISHU_BOT_IDENTITY).info,
      acceptSelfSent: get(TOKENS.FEISHU_INGRESS).acceptSelfSent,
      messageExists: (chatId, messageId) => canonicalMessageExists(db, chatId, messageId),
      isKnownParticipant: (chatId, openId) => get(TOKENS.FEISHU_USER_NAMES).isKnown(chatId, openId),
      // read_image(file_id)/download_file: the stable image_key was persisted
      // on the canonical attachment when the message was archived.
      loadMessageAttachments: (chatId, messageId) => {
        const event = loadEventsByMessageIds(db, chatId, [messageId]).find(candidate => candidate.type === 'message');
        return event?.type === 'message' ? event.attachments : undefined;
      },
      getMessageResource: sdk.api.getMessageResource,
      logger: get(TOKENS.LOGGER),
    });
  });

  register(TOKENS.FEISHU_RUNTIME, (): PlatformRuntime => {
    const sdk = get(TOKENS.FEISHU_SDK);
    const ingress = get(TOKENS.FEISHU_INGRESS);
    return {
      // Handlers are bound to the long connection when it starts.
      startIngress: () => {},
      start: () => sdk.start({
        onMessageReceive: ingress.handleMessageReceive,
        onMessageRecalled: ingress.handleMessageRecalled,
      }),
      stop: async () => sdk.stop(),
      runPostStartup: async () => {},
    };
  });
};
