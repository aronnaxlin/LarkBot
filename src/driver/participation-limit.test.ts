import { describe, expect, it } from 'vitest';

import { evaluateParticipationLimit } from './participation-limit';
import type { ParticipationConfig } from '../config/config';
import type { RenderedContextSegment } from '../rendering/types';

const NOW = 10_000_000;
const config = (overrides: Partial<ParticipationConfig>): ParticipationConfig =>
  ({ style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, ...overrides });
const self = (receivedAtMs: number): RenderedContextSegment =>
  ({ receivedAtMs, senderId: 'bot', isMyself: true, content: [] });
const human = (receivedAtMs: number, extra: Partial<RenderedContextSegment> = {}): RenderedContextSegment =>
  ({ receivedAtMs, senderId: 'u1', content: [], ...extra });

describe('evaluateParticipationLimit', () => {
  it('is never limited when both hard limits are off', () => {
    const segments = [self(NOW - 1000), human(NOW - 500)];
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 1000, nowMs: NOW, config: config({}) }).limited).toBe(false);
  });

  it('limits inside the cooldown and releases after it', () => {
    const segments = [self(NOW - 60_000), human(NOW - 1000)];
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 60_000, nowMs: NOW, config: config({ cooldownSec: 120 }) }))
      .toEqual({ limited: true, reason: 'cooldown', bypassed: false });
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 60_000, nowMs: NOW, config: config({ cooldownSec: 30 }) }).limited)
      .toBe(false);
  });

  it('counts only the last hour against maxPerHour', () => {
    const segments = [self(NOW - 2 * 3_600_000), self(NOW - 1_800_000), self(NOW - 600_000), human(NOW - 1000)];
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 600_000, nowMs: NOW, config: config({ maxPerHour: 2 }) }).reason)
      .toBe('hourly');
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 600_000, nowMs: NOW, config: config({ maxPerHour: 3 }) }).limited)
      .toBe(false);
  });

  it('is bypassed by an @-mention, a quote-reply or a runtime event since the last action', () => {
    const limited = config({ cooldownSec: 600 });
    for (const extra of [{ mentionsMe: true }, { repliesToMe: true }, { isRuntimeEvent: true, senderId: undefined }]) {
      const segments = [self(NOW - 1000), human(NOW - 500, extra)];
      expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 1000, nowMs: NOW, config: limited }))
        .toEqual({ limited: true, reason: 'cooldown', bypassed: true });
    }
  });

  it('ignores addresses the bot already acted on', () => {
    const segments = [human(NOW - 2000, { mentionsMe: true }), self(NOW - 1000), human(NOW - 500)];
    expect(evaluateParticipationLimit({ segments, lastActedMs: NOW - 1000, nowMs: NOW, config: config({ cooldownSec: 600 }) }).bypassed)
      .toBe(false);
  });
});
