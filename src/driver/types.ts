import type { ResolvedChatConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { ConversationEntry } from '../unified-api/types';

export interface TurnResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
}

export interface ProbeResponseV2 {
  requestedAtMs: number;
  entries: ConversationEntry[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
  isActivated: boolean;
  createdAt: number;
}

export interface DriverConfig {
  chatIds: string[];
  resolveChatConfig: (chatId: string) => ResolvedChatConfig;
}

export interface CompactionConfig {
  maxContextEstTokens: number;
  workingWindowEstTokens: number;
  model?: LlmEndpoint;
}

export interface DebounceConfig {
  initialDelayMs: number;
  typingExtendMs: number;
  maxDelayMs: number;
}

// Primary tool-loop budget. Counts accumulate across an interruption chain
// (TRs joined by requiresFollowUp); the deadline is per wake-up execution.
export interface TurnBudget {
  // Regular model steps (all tools visible) before the tool-less wrap-up.
  maxToolRounds: number;
  // Work-tool calls; participation tools (send_message/react/end_turn) are exempt.
  maxToolCalls: number;
  // Combined send_message/react attempts across the chain; end_turn is exempt.
  maxParticipationCalls?: number;
  // Measured from executeWakeup entry, probe included.
  deadlineMs: number;
  // A model call starts only with at least this much deadline left; its HTTP
  // timeout is the remaining time, capped by the endpoint's timeoutSec.
  minModelCallMs: number;
}

export interface TurnBudgetUsage {
  toolRounds: number;
  toolCalls: number;
  participationCalls?: number;
}

export interface CompactionSessionMeta {
  oldCursorMs: number;
  newCursorMs: number;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type { ResolvedChatConfig } from '../config/config';
