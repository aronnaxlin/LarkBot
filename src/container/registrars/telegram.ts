import * as tdl from 'tdl';

import { requireTelegramConfig } from '../../config/config';
import { loadKnownChatIds } from '../../db';
import type { PlatformRuntime } from '../../startup/platform';
import { createTelegramClients, createTelegramManager } from '../../telegram';
import { resolveTdjson } from '../../telegram/tdjson';
import { resolveBotDataDir, resolveUserbotDataDir } from '../../telegram/tdlib-paths';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerTelegram = ({ get, register }: Registrar): void => {
  register(TOKENS.TELEGRAM_CLIENTS, () => {
    const config = get(TOKENS.CONFIG);
    const telegram = requireTelegramConfig(config);
    // Loading libtdjson is deferred to here so non-Telegram platforms never
    // require TDLib.
    tdl.configure({ tdjson: resolveTdjson() });
    return createTelegramClients({
      apiId: telegram.apiId,
      apiHash: telegram.apiHash,
      botToken: telegram.botToken,
      userbotEnabled: telegram.userbotEnabled,
      botDataDir: resolveBotDataDir(config),
      userbotDataDir: resolveUserbotDataDir(config),
    }, get(TOKENS.LOGGER));
  });

  register(TOKENS.TELEGRAM_MANAGER, () => {
    const db = get(TOKENS.DB);
    const media = get(TOKENS.MEDIA_RUNTIME);
    return createTelegramManager({
      initialChatIds: loadKnownChatIds(db),
      imageToTextResolvers: media.imageResolvers,
      animationToTextResolvers: media.animationResolvers,
      animationMaxFrames: media.animationMaxFrames,
      customEmojiToTextResolvers: media.customEmojiResolvers,
    }, get(TOKENS.TELEGRAM_CLIENTS), get(TOKENS.LOGGER));
  });

  register(TOKENS.TELEGRAM_RUNTIME, (): PlatformRuntime => {
    const manager = get(TOKENS.TELEGRAM_MANAGER);
    const liveHandlers = get(TOKENS.TELEGRAM_LIVE_HANDLERS);
    const postStartup = get(TOKENS.TELEGRAM_POST_STARTUP_TASKS);
    return {
      startIngress: () => liveHandlers.start(),
      start: () => manager.start(),
      stop: () => manager.stop(),
      runPostStartup: () => postStartup.run(),
    };
  });
};
