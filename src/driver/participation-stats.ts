// Pure participation-signal helper for the probe/primary prompts.
//
// The driver owns the rendered context (RC); these signals are derived from it
// at wake-up time so the probe can weigh recent self-volume and bot-to-bot
// chatter before deciding whether to wake primary.
//
// Input is structural (not `RenderedContext`) so callers can pass RC directly
// without pulling provider content into this module: `RenderedContextSegment`
// is assignable to `ParticipationSegment`.

export interface ParticipationSegment {
  receivedAtMs: number;
  senderId?: string;
  // Sender is this bot account (see RenderedContextSegment.isMyself) — includes
  // messages another program sent through the same account. Volume the group
  // sees is account-level, so this is the right flag here, not `isSelfSent`.
  isMyself?: boolean;
  // Sender is a bot account other than this one (rendered `bot="true"`); used
  // to tell a bot-to-bot exchange from the bot talking to itself.
  isBot?: boolean;
}

export interface ParticipationStats {
  // Bot messages received in the last `windowMs` (default 10 minutes).
  recentSelfMessages10m: number;
  // Whole seconds since the bot's latest message; absent when it never spoke.
  secondsSinceLastSelfMessage?: number;
  // Consecutive messages authored by bots since the last non-bot message. Zero
  // unless at least one of them came from another bot: the bot's own run of
  // messages is not an exchange. N bot↔bot rounds are roughly 2N
  // consecutive messages (one per side per round); senderless system/runtime
  // segments are skipped, not treated as humans.
  consecutiveBotExchanges: number;
}

export const SELF_VOLUME_WINDOW_MS = 10 * 60 * 1000;

export const computeParticipationStats = (params: {
  segments: readonly ParticipationSegment[];
  nowMs: number;
  windowMs?: number;
}): ParticipationStats => {
  const windowMs = params.windowMs ?? SELF_VOLUME_WINDOW_MS;
  const windowStartMs = params.nowMs - windowMs;

  let recentSelfMessages10m = 0;
  let lastSelfMs: number | undefined;
  for (const segment of params.segments) {
    if (!segment.isMyself) continue;
    if (lastSelfMs == null || segment.receivedAtMs > lastSelfMs) lastSelfMs = segment.receivedAtMs;
    if (segment.receivedAtMs >= windowStartMs) recentSelfMessages10m++;
  }

  let streak = 0;
  let hasOtherBot = false;
  for (let i = params.segments.length - 1; i >= 0; i--) {
    const segment = params.segments[i]!;
    if (segment.senderId == null) continue;
    const isSelf = segment.isMyself === true;
    if (!isSelf && segment.isBot !== true) break;
    streak++;
    if (!isSelf) hasOtherBot = true;
  }
  const consecutiveBotExchanges = hasOtherBot ? streak : 0;

  return {
    recentSelfMessages10m,
    ...(lastSelfMs != null
      ? { secondsSinceLastSelfMessage: Math.round((params.nowMs - lastSelfMs) / 1000) }
      : {}),
    consecutiveBotExchanges,
  };
};
