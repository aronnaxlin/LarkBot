import type { FeishuApi } from './api';

// The bot's open_id is what mentions of the bot carry, and is the sender id of
// synthetic self-events. It is only available from the API, so it is loaded
// once before cold replay.
export const createFeishuBotIdentity = (api: Pick<FeishuApi, 'getBotInfo'>) => {
  let info: { openId: string; name: string } | undefined;
  const requireInfo = () => {
    if (!info) throw new Error('Feishu bot identity is not loaded yet');
    return info;
  };
  return {
    prepare: async (): Promise<void> => {
      info = await api.getBotInfo();
    },
    botUserId: (): string => requireInfo().openId,
    info: requireInfo,
  };
};

export type FeishuBotIdentity = ReturnType<typeof createFeishuBotIdentity>;
