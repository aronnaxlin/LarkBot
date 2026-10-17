import type { FeishuApi } from './api';

// Feishu reactions take an `emoji_type` enum, not Unicode. This table covers
// common reactions whose enum names appear in the official emoji list
// (https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce).
// Unmapped emoji fail loudly instead of being approximated.
const EMOJI_TYPES: ReadonlyMap<string, string> = new Map([
  ['👍', 'THUMBSUP'],
  ['👎', 'ThumbsDown'],
  ['👌', 'OK'],
  ['❤️', 'HEART'],
  ['❤', 'HEART'],
  ['👏', 'CLAP'],
  ['🔥', 'Fire'],
  ['🎉', 'PARTY'],
  ['🤔', 'THINKING'],
  ['😂', 'LOL'],
  ['😆', 'LAUGH'],
  ['😊', 'SMILE'],
  ['🙂', 'SMILE'],
  ['😢', 'CRY'],
  ['😭', 'SOB'],
  ['😮', 'WOW'],
  ['😱', 'SHOCKED'],
  ['💪', 'MUSCLE'],
  ['💯', 'Hundred'],
  ['🤗', 'HUG'],
  ['👋', 'WAVE'],
  ['🌹', 'ROSE'],
  ['🍺', 'BEER'],
  ['☕', 'Coffee'],
  ['✅', 'CheckMark'],
  ['❌', 'CrossMark'],
  ['🤦', 'FACEPALM'],
  ['🤷', 'Shrug'],
  ['💀', 'SKULL'],
  ['💩', 'POOP'],
  // Second batch: expressive reactions the first active run asked for (😏/😎)
  // plus other common ones. All emoji_type names come from the official list.
  ['😏', 'SMIRK'],
  ['😎', 'SMART'],
  ['😉', 'WINK'],
  ['😍', 'LOVE'],
  ['😜', 'TEASE'],
  ['😑', 'SPEECHLESS'],
  ['😁', 'BeamingFace'],
  ['🥳', 'Partying'],
  ['🥺', 'WHIMPER'],
  ['🤭', 'SHY'],
  ['😡', 'ANGRY'],
  ['😴', 'SLEEP'],
  ['🥱', 'YAWN'],
  ['😇', 'INNOCENTSMILE'],
  ['🤡', 'ClownFace'],
  ['😳', 'BLUSH'],
  ['😅', 'ColdSweat'],
  ['😲', 'SHOCKED'],
  ['😄', 'LAUGH'],
  ['✌️', 'YEAH'],
  ['✌', 'YEAH'],
  ['🙌', 'YEAH'],
  ['🫡', 'SALUTE'],
  ['💔', 'HEARTBROKEN'],
  ['💰', 'MONEY'],
  ['🎁', 'GIFT'],
  ['🎂', 'CAKE'],
  ['🏆', 'Trophy'],
  ['📌', 'Pin'],
  ['🎵', 'Music'],
  ['💣', 'BOMB'],
  ['🍋', 'Lemon'],
  ['🧋', 'BubbleTea'],
  ['📺', 'TV'],
  ['🎬', 'Movie'],
  ['🎃', 'Pumpkin'],
  ['🌝', 'FullMoonFace'],
]);

export const feishuEmojiType = (emoji: string): string | undefined => EMOJI_TYPES.get(emoji.trim());

// Mirrors the Driver's react semantics (one reaction per message, a new one
// replaces the old one). Feishu deletes reactions by reaction_id, which is only
// known from our own create calls, so it is tracked in memory: after a restart,
// earlier reactions can no longer be removed or replaced and calls say so.
export const createFeishuReactions = (api: Pick<FeishuApi, 'createReaction' | 'deleteReaction'>) => {
  const ownReactions = new Map<string, string>();

  const setReaction = async (messageId: string, emoji: string | undefined): Promise<void> => {
    const emojiType = emoji == null ? undefined : feishuEmojiType(emoji);
    if (emoji != null && !emojiType)
      throw new Error(`Emoji ${emoji} has no Feishu reaction mapping. Supported: ${[...new Set(EMOJI_TYPES.keys())].join(' ')}`);

    const previous = ownReactions.get(messageId);
    if (emojiType == null && previous == null)
      throw new Error('No reaction by this bot on that message is known since the last restart; Feishu needs its reaction_id to remove it.');

    if (previous != null) {
      await api.deleteReaction(messageId, previous);
      ownReactions.delete(messageId);
    }
    if (emojiType != null) {
      const { reactionId } = await api.createReaction(messageId, emojiType);
      ownReactions.set(messageId, reactionId);
    }
  };

  return { setReaction };
};
