import { requireTelegramConfig } from '../config/config';
import type { Config } from '../config/config';

const DEFAULT_BOT_DIR = 'data/tdlib-bot';
const DEFAULT_USERBOT_DIR = 'data/tdlib-userbot';

export const resolveBotDataDir = (config: Config): string =>
  requireTelegramConfig(config).botDataDir ?? DEFAULT_BOT_DIR;

export const resolveUserbotDataDir = (config: Config): string =>
  requireTelegramConfig(config).userbotDataDir ?? DEFAULT_USERBOT_DIR;
