import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

// Selects the configured platform's implementation for the platform-neutral
// tokens. Factories are lazy, so the other platform is never constructed.
export const registerPlatform = ({ get, register }: Registrar): void => {
  const isFeishu = () => get(TOKENS.CONFIG).platform === 'feishu';

  register(TOKENS.PLATFORM_IDENTITY, () => {
    if (isFeishu()) return get(TOKENS.FEISHU_BOT_IDENTITY);
    const bot = get(TOKENS.TELEGRAM_CLIENTS).bot;
    return { prepare: async () => {}, botUserId: () => bot.botUserId() };
  });

  register(TOKENS.DRIVER_PLATFORM, () =>
    get(isFeishu() ? TOKENS.FEISHU_DRIVER_PLATFORM : TOKENS.TELEGRAM_DRIVER_PLATFORM));

  register(TOKENS.PLATFORM_RUNTIME, () =>
    get(isFeishu() ? TOKENS.FEISHU_RUNTIME : TOKENS.TELEGRAM_RUNTIME));
};
