import type { Logger } from '@guiiai/logg';

import { extractToolCalls } from './tools';
import type { TurnBudget, TurnBudgetUsage } from './types';
import type { LlmCallUsage } from '../llm/call';
import type { ConversationEntry, ToolResult } from '../unified-api/types';

export { DEFAULT_TURN_BUDGET } from './turn-budget';

// Tools that only participate in the conversation. They stay available in the
// wrap-up step and never consume or get skipped by the work-call budget.
export const PARTICIPATION_TOOL_NAMES: ReadonlySet<string> = new Set(['send_message', 'react', 'end_turn']);

// Probe `react_only` activation: primary may acknowledge with a reaction or
// end silently, but cannot send a message or run work tools this turn.
export const REACT_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['react', 'end_turn']);

export const countParticipationCalls = (entries: ConversationEntry[]): number =>
  extractToolCalls(entries).filter(call => call.name === 'send_message' || call.name === 'react').length;

export const countWorkToolCalls = (entries: ConversationEntry[]): number =>
  extractToolCalls(entries).filter(call => !PARTICIPATION_TOOL_NAMES.has(call.name)).length;

export interface ModelStepResult {
  modelEntries: ConversationEntry[];
  usage: LlmCallUsage;
  requestedAtMs: number;
}

export interface ExecutedStepResult {
  stepEntries: ConversationEntry[];
  usage: LlmCallUsage;
  requestedAtMs: number;
  hasToolCalls: boolean;
}

export interface ModelStepOptions {
  // Wrap-up steps expose only participation tools.
  wrapUp: boolean;
  deadlineAtMs: number;
}

export interface TurnLoopOperations {
  callModelStep: (
    workingEntries: ConversationEntry[],
    step: number,
    options: ModelStepOptions,
  ) => Promise<ModelStepResult>;
  executeToolStep: (
    modelStep: ModelStepResult,
    options: { remainingToolCalls: number; remainingParticipationCalls: number; deadlineAtMs: number },
  ) => Promise<ExecutedStepResult>;
}

export interface TurnLoopParams {
  chatId: string;
  entries: ConversationEntry[];
  budget: TurnBudget;
  // Usage already consumed by earlier TRs of an interrupted chain.
  budgetUsed?: TurnBudgetUsage;
  // A react_only turn closes after its first step even when a tool result
  // asks for follow-up, so a continuation can never regain the full tool set.
  reactOnly?: boolean;
  deadlineAtMs: number;
  onStepComplete: (
    stepEntries: ConversationEntry[],
    usage: LlmCallUsage,
    requestedAtMs: number,
  ) => void | Promise<void>;
  checkInterrupt: () => boolean;
  log: Logger;
}

// Persisted requiresFollowUp records whether the loop actually continued, so a
// step that closes the turn must not leave the chain open for the scheduler.
const closeFollowUps = (entries: ConversationEntry[]): ConversationEntry[] =>
  entries.map(entry => entry.kind === 'toolResult' && entry.requiresFollowUp
    ? { ...entry, requiresFollowUp: false }
    : entry);

export const runTurnLoop = async (
  params: TurnLoopParams,
  operations: TurnLoopOperations,
): Promise<void> => {
  const { budget } = params;
  const used: TurnBudgetUsage = { toolRounds: 0, toolCalls: 0, ...params.budgetUsed };
  const hasTimeForModelCall = () => params.deadlineAtMs - Date.now() >= budget.minModelCallMs;
  const isShortOnTime = () => params.deadlineAtMs - Date.now() < (budget.wrapUpReserveMs ?? 0);
  let workingEntries = [...params.entries];

  if (!hasTimeForModelCall()) {
    // Throw so the scheduler's failedRc guard prevents an open continuation
    // from spinning when it cannot even start a model step.
    throw new Error('Turn deadline reached before the first primary step');
  }

  for (let step = 1; ; step++) {
    const wrapUp = used.toolRounds >= budget.maxToolRounds || used.toolCalls >= budget.maxToolCalls || isShortOnTime();
    const modelStep = await operations.callModelStep(workingEntries, step, {
      wrapUp,
      deadlineAtMs: params.deadlineAtMs,
    });
    const executed = await operations.executeToolStep(modelStep, {
      remainingToolCalls: wrapUp ? 0 : Math.max(0, budget.maxToolCalls - used.toolCalls),
      remainingParticipationCalls: Math.max(0, (budget.maxParticipationCalls ?? 3) - (used.participationCalls ?? 0)),
      deadlineAtMs: params.deadlineAtMs,
    });
    used.participationCalls = (used.participationCalls ?? 0) + countParticipationCalls(modelStep.modelEntries);
    if (!wrapUp) {
      used.toolRounds++;
      used.toolCalls += countWorkToolCalls(modelStep.modelEntries);
    }

    const toolResults = executed.stepEntries.filter((entry): entry is ToolResult => entry.kind === 'toolResult');
    const anyRequiresFollowUp = toolResults.some(result => result.requiresFollowUp);
    const endTurnCalled = extractToolCalls(modelStep.modelEntries).some(call => call.name === 'end_turn');
    // end_turn is explicit: it closes the turn even beside follow-up results.
    // A react_only turn is one step by construction: `react` reports follow-up,
    // but there is no message or work tool to wait for. The wrap-up is the last
    // step; running short on time makes the next step the wrap-up, so only a
    // step that leaves less than minModelCallMs ends the turn silently.
    let closeReason: string | undefined;
    if (anyRequiresFollowUp) {
      if (endTurnCalled) closeReason = 'end_turn';
      else if (params.reactOnly) closeReason = 'react-only';
      else if (wrapUp) closeReason = 'wrap-up';
      else if (!hasTimeForModelCall()) closeReason = 'deadline';
    }
    const stepEntries = closeReason ? closeFollowUps(executed.stepEntries) : executed.stepEntries;

    params.log.withFields({
      chatId: params.chatId,
      step,
      wrapUp,
      hasToolCalls: executed.hasToolCalls,
      newEntries: stepEntries.length,
      usage: executed.usage,
      budgetUsed: used,
      ...(closeReason ? { closeReason } : {}),
    }).log('Step completed');

    await params.onStepComplete(stepEntries, executed.usage, executed.requestedAtMs);

    if (!executed.hasToolCalls || !anyRequiresFollowUp || closeReason) break;

    if (params.checkInterrupt()) {
      params.log.withFields({ chatId: params.chatId, step }).log('Turn interrupted by new messages');
      break;
    }

    workingEntries = [...workingEntries, ...stepEntries];
  }
};
