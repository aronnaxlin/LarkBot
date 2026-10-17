import { resolveChatConfig } from '../../config/config';
import { loadContacts } from '../../contacts';
import { createPipeline } from '../../pipeline';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerPipeline = ({ get, register }: Registrar): void => {
  register(TOKENS.PIPELINE, () => {
    const config = get(TOKENS.CONFIG);
    const chatIds = get(TOKENS.CHAT_IDS);
    const blockedUsers = new Map(
      chatIds.map(id => [id, new Set(resolveChatConfig(config, id).blockedUserIds)] as const),
    );
    return createPipeline({
      botUserId: get(TOKENS.PLATFORM_IDENTITY).botUserId(),
      contactNames: loadContacts(get(TOKENS.LOGGER)),
      // Feishu mentions address participants by open_id, which the model reads
      // off the chatlog. Telegram keeps its original chatlog shape.
      senderUid: config.platform === 'feishu',
      maintainers: get(TOKENS.MAINTAINERS),
    }, chatId => blockedUsers.get(chatId));
  });
};
