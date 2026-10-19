// Opt-in hard limits on unaddressed speech (`chats.<id>.participation`).
//
// The limits only ever restrict the chatbot speaking up on its own. A human
// @-mention or quote-reply since the bot last acted, or a runtime event (a
// background task finished), bypasses them deterministically. A name-call
// cannot be detected without string matching, so while limited the probe still
// runs and is told that only a direct address may wake the bot; the driver then
// refuses `react_only`, which is never a reply to a direct address.

import type { ParticipationConfig } from '../config/config';
import type { RenderedContextSegment } from '../rendering/types';

export type ParticipationLimitReason = 'cooldown' | 'hourly';

export interface ParticipationLimitDecision {
  // A configured limit is currently reached.
  limited: boolean;
  reason?: ParticipationLimitReason;
  // A deterministic bypass exists since the bot last acted.
  bypassed: boolean;
}

const HOUR_MS = 60 * 60 * 1000;

export const evaluateParticipationLimit = (params: {
  segments: readonly RenderedContextSegment[];
  lastActedMs: number;
  nowMs: number;
  config: ParticipationConfig;
}): ParticipationLimitDecision => {
  const { segments, lastActedMs, nowMs, config } = params;

  let lastSelfMs: number | undefined;
  let selfLastHour = 0;
  let bypassed = false;
  for (const segment of segments) {
    if (segment.isMyself) {
      if (lastSelfMs == null || segment.receivedAtMs > lastSelfMs) lastSelfMs = segment.receivedAtMs;
      if (segment.receivedAtMs >= nowMs - HOUR_MS) selfLastHour++;
      continue;
    }
    if (segment.receivedAtMs <= lastActedMs) continue;
    if (segment.isRuntimeEvent || segment.mentionsMe || segment.repliesToMe) bypassed = true;
  }

  let reason: ParticipationLimitReason | undefined;
  if (config.cooldownSec > 0 && lastSelfMs != null && nowMs - lastSelfMs < config.cooldownSec * 1000)
    reason = 'cooldown';
  else if (config.maxPerHour > 0 && selfLastHour >= config.maxPerHour)
    reason = 'hourly';

  return reason ? { limited: true, reason, bypassed } : { limited: false, bypassed };
};
