import { loadImageAltTextByHash, persistImageAltText } from '../../db';
import { createMediaRuntime } from '../../media/runtime';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerMedia = ({ get, register }: Registrar): void => {
  register(TOKENS.MEDIA_RUNTIME, () => {
    const db = get(TOKENS.DB);
    const config = get(TOKENS.CONFIG);
    // Custom emoji are a Telegram concept; Feishu content never contains them.
    const bot = config.platform === 'telegram' ? get(TOKENS.TELEGRAM_CLIENTS).bot : undefined;
    const getCustomEmojiInfo = bot
      ? (ids: string[]) => bot.getCustomEmojiInfo(ids)
      : async () => {
        throw new Error(`Custom emoji are not supported on platform ${config.platform}`);
      };
    return createMediaRuntime({
      config,
      logger: get(TOKENS.LOGGER),
      lookupAltText: hash => loadImageAltTextByHash(db, hash),
      persistAltText: record => persistImageAltText(db, record),
      getCustomEmojiInfo,
    });
  });
};
