import type { TurnBudget } from './types';

// Suggested starting point from the project discussion; tune with real latency.
export const DEFAULT_TURN_BUDGET: TurnBudget = {
  maxToolRounds: 2,
  maxToolCalls: 4,
  maxParticipationCalls: 3,
  deadlineMs: 15_000,
  minModelCallMs: 2_000,
};
