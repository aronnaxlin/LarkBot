import type { TurnBudget } from './types';

// Suggested starting point from the project discussion; tune with real latency.
export const DEFAULT_TURN_BUDGET: TurnBudget = {
  maxToolRounds: 2,
  maxToolCalls: 4,
  maxParticipationCalls: 3,
  deadlineMs: 15_000,
  minModelCallMs: 2_000,
};

// Probe has its own bound, separate from the primary deadline: on the first
// live Feishu run probe latency was p50 7 s, p90 11 s, max 17 s. A timed-out
// probe is retried by the scheduler.
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
