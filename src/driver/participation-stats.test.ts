import { describe, expect, it } from 'vitest';

import { computeParticipationStats, SELF_VOLUME_WINDOW_MS } from './participation-stats';
import type { ParticipationSegment } from './participation-stats';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const seg = (receivedAtMs: number, senderId?: string, flags?: { isMyself?: boolean; isBot?: boolean }): ParticipationSegment => ({
  receivedAtMs,
  ...(senderId != null ? { senderId } : {}),
  ...(flags?.isMyself != null ? { isMyself: flags.isMyself } : {}),
  ...(flags?.isBot != null ? { isBot: flags.isBot } : {}),
});

describe('computeParticipationStats', () => {
  it('counts self messages inside the 10-minute window and ignores older ones', () => {
    const stats = computeParticipationStats({
      segments: [
        seg(NOW - 11 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 9 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 1 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 30_000, 'ou_human'),
      ],
      nowMs: NOW,
    });
    expect(stats.recentSelfMessages10m).toBe(2);
  });

  it('reports seconds since the latest self message even when it is outside the window', () => {
    const stats = computeParticipationStats({
      segments: [seg(NOW - 30 * MINUTE, 'ou_self', { isMyself: true }), seg(NOW - MINUTE, 'ou_human')],
      nowMs: NOW,
    });
    expect(stats.recentSelfMessages10m).toBe(0);
    expect(stats.secondsSinceLastSelfMessage).toBe(30 * 60);
  });

  it('omits secondsSinceLastSelfMessage when the bot never spoke', () => {
    const stats = computeParticipationStats({ segments: [seg(NOW - MINUTE, 'ou_human')], nowMs: NOW });
    expect(stats.recentSelfMessages10m).toBe(0);
    expect(stats.secondsSinceLastSelfMessage).toBeUndefined();
  });

  it('counts consecutive bot messages since the last human, including another bot', () => {
    const stats = computeParticipationStats({
      segments: [
        seg(NOW - 5 * MINUTE, 'ou_human'),
        seg(NOW - 4 * MINUTE, 'ou_otherbot', { isBot: true }),
        seg(NOW - 3 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 2 * MINUTE, 'ou_otherbot', { isBot: true }),
        seg(NOW - 1 * MINUTE, 'ou_self', { isMyself: true }),
      ],
      nowMs: NOW,
    });
    expect(stats.consecutiveBotExchanges).toBe(4);
  });

  it('returns zero when the streak is only the bot talking to itself', () => {
    const stats = computeParticipationStats({
      segments: [
        seg(NOW - 3 * MINUTE, 'ou_human'),
        seg(NOW - 2 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 1 * MINUTE, 'ou_self', { isMyself: true }),
      ],
      nowMs: NOW,
    });
    expect(stats.consecutiveBotExchanges).toBe(0);
  });

  it('breaks the streak at a non-bot sender', () => {
    const stats = computeParticipationStats({
      segments: [
        seg(NOW - 4 * MINUTE, 'ou_otherbot', { isBot: true }),
        seg(NOW - 3 * MINUTE, 'ou_unknown'),
        seg(NOW - 2 * MINUTE, 'ou_otherbot', { isBot: true }),
      ],
      nowMs: NOW,
    });
    expect(stats.consecutiveBotExchanges).toBe(1);
  });

  it('skips senderless system/runtime segments without breaking the bot streak', () => {
    const stats = computeParticipationStats({
      segments: [
        seg(NOW - 4 * MINUTE, 'ou_self', { isMyself: true }),
        seg(NOW - 3 * MINUTE),
        seg(NOW - 2 * MINUTE, 'ou_otherbot', { isBot: true }),
      ],
      nowMs: NOW,
    });
    expect(stats.consecutiveBotExchanges).toBe(2);
  });

  it('counts zero exchanges when the latest message is human', () => {
    const stats = computeParticipationStats({
      segments: [seg(NOW - 2 * MINUTE, 'ou_self', { isMyself: true }), seg(NOW - MINUTE, 'ou_human')],
      nowMs: NOW,
    });
    expect(stats.consecutiveBotExchanges).toBe(0);
  });

  it('honours a custom window', () => {
    const stats = computeParticipationStats({
      segments: [seg(NOW - 2 * MINUTE, 'ou_self', { isMyself: true }), seg(NOW - MINUTE, 'ou_self', { isMyself: true })],
      nowMs: NOW,
      windowMs: MINUTE,
    });
    expect(stats.recentSelfMessages10m).toBe(1);
    expect(SELF_VOLUME_WINDOW_MS).toBe(10 * MINUTE);
  });
});
