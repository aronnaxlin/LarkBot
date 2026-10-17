import { describe, expect, it, vi } from 'vitest';

import { createFeishuReactions, feishuEmojiType } from './reactions';

const fixture = () => {
  let next = 0;
  const api = {
    createReaction: vi.fn(async () => ({ reactionId: `r${++next}` })),
    deleteReaction: vi.fn(async () => {}),
  };
  return { api, reactions: createFeishuReactions(api) };
};

describe('Feishu reactions', () => {
  it('maps Unicode emoji to Feishu emoji_type values', () => {
    expect(feishuEmojiType('👍')).toBe('THUMBSUP');
    expect(feishuEmojiType('❤️')).toBe('HEART');
    expect(feishuEmojiType('😏')).toBe('SMIRK');
    expect(feishuEmojiType('😎')).toBe('SMART');
    expect(feishuEmojiType('🥳')).toBe('Partying');
    expect(feishuEmojiType('🤡')).toBe('ClownFace');
    expect(feishuEmojiType('🦄')).toBeUndefined();
  });

  it('adds, replaces, and removes its own reaction by reaction_id', async () => {
    const { api, reactions } = fixture();
    await reactions.setReaction('om_1', '👍');
    expect(api.createReaction).toHaveBeenLastCalledWith('om_1', 'THUMBSUP');

    await reactions.setReaction('om_1', '🎉');
    expect(api.deleteReaction).toHaveBeenLastCalledWith('om_1', 'r1');
    expect(api.createReaction).toHaveBeenLastCalledWith('om_1', 'PARTY');

    await reactions.setReaction('om_1', undefined);
    expect(api.deleteReaction).toHaveBeenLastCalledWith('om_1', 'r2');
    expect(api.createReaction).toHaveBeenCalledTimes(2);
  });

  it('fails loudly instead of claiming success', async () => {
    const { api, reactions } = fixture();
    await expect(reactions.setReaction('om_1', '🦄')).rejects.toThrow('no Feishu reaction mapping');
    await expect(reactions.setReaction('om_2', undefined)).rejects.toThrow('reaction_id');
    expect(api.createReaction).not.toHaveBeenCalled();
    expect(api.deleteReaction).not.toHaveBeenCalled();
  });
});
