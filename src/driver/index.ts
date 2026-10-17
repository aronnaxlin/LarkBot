import type { Logger } from '@guiiai/logg';
import { signal } from 'alien-signals';

import { createCompactionController } from './compaction-controller';
import { wasToolLoopInterrupted } from './context';
import type { DriverPlatform } from './platform';
import { createPrimaryTools } from './primary-tools';
import { createRunner } from './runner';
import { createReplyScheduler } from './scheduler';
import { isTransientModelError } from './transient-error';
import type { CompactionSessionMeta, DriverConfig, ProbeResponseV2, TurnResponseV2 } from './types';
import { executeWakeup } from './wakeup';
import type { ActiveTaskInfo } from '../background-task/types';
import type { RuntimeConfig } from '../config/config';
import type { LlmEndpoint } from '../llm/types';
import type { RenderedContext } from '../rendering/types';

export { mergeContext } from './merge';
export { renderLateBindingPrompt, renderSystemPrompt } from './prompt';
export type { DriverPlatform } from './platform';
export type { DriverConfig } from './types';
export type { TurnResponseV2, ProbeResponseV2 } from './types';

// Platform capabilities are spread flat into deps (see DriverPlatform).
export const createDriver = (config: DriverConfig, deps: DriverPlatform & {
  loadTurnResponses: (chatId: string, afterMs?: number) => Promise<TurnResponseV2[]>;
  persistTurnResponse: (chatId: string, tr: TurnResponseV2) => Promise<void>;
  persistProbeResponse: (chatId: string, probe: ProbeResponseV2) => Promise<void>;
  loadCompaction: (chatId: string) => CompactionSessionMeta | null;
  loadLastProbeTime: (chatId: string) => number;
  persistCompaction: (chatId: string, meta: CompactionSessionMeta) => void;
  setCompactCursor: (chatId: string, cursorMs: number) => RenderedContext;
  getChatTitle: (chatId: string) => string | undefined;
  runtimeConfig: RuntimeConfig;
  readOldMessages: (chatId: string, messageIds: string[]) => Promise<string> | string;
  // Resolve a rendered message alias (or a canonical id) to the canonical id
  // before any platform call or message existence check. Unknown input is
  // returned unchanged so the normal unknown-id errors still apply.
  resolveMessageId?: (chatId: string, raw: string) => string;
  // Render a canonical id the way the chatlog shows it, for tool results that
  // echo a message id back to the model.
  formatMessageId?: (chatId: string, messageId: string) => string;
  resolveModel: (name: string) => LlmEndpoint;
  backgroundTask: {
    startTask: (typeName: string, sessionId: string, params: unknown, intention: string | undefined, timeoutMs: number) => number;
    killTask: (taskId: number) => { ok: boolean; error?: string };
    getActiveTasks: (sessionId: string) => ActiveTaskInfo[];
    readTaskOutput: (taskId: number, offset?: number, limit?: number) => Promise<{ content: string; totalLines: number; truncated: boolean } | { error: string }>;
  };
  logger: Logger;
}) => {
  const { logger } = deps;
  const log = logger.withContext('driver');
  const chatIds = new Set(config.chatIds);

  const getLastProcessedTime = async (chatId: string): Promise<number> => {
    const trs = await deps.loadTurnResponses(chatId);
    const lastTr = trs.length > 0 ? trs[trs.length - 1]!.requestedAtMs : 0;
    const lastProbe = deps.loadLastProbeTime(chatId);
    return Math.max(lastTr, lastProbe);
  };

  const chatScopes = new Map<string, {
    rc: ReturnType<typeof signal<RenderedContext>>;
    notifyTyping: () => void;
    cleanup: () => void;
  }>();

  const getOrCreateScope = (chatId: string) => {
    const existing = chatScopes.get(chatId);
    if (existing) return existing;

    const chatConfig = config.resolveChatConfig(chatId);

    const rc = signal<RenderedContext>([]);
    const lastProcessedMs = signal(0);
    // A persisted requiresFollowUp result keeps the wake-up eligible after restart.
    const lastTRInterrupted = signal(false);
    void getLastProcessedTime(chatId).then(v => lastProcessedMs(Math.max(lastProcessedMs(), v)));
    void deps.loadTurnResponses(chatId).then(trs => lastTRInterrupted(wasToolLoopInterrupted(trs)));
    const failedRc = signal<RenderedContext | null>(null);

    const compactionMeta = signal<CompactionSessionMeta | null>(
      deps.loadCompaction(chatId),
    );

    const compaction = createCompactionController({
      chatId,
      chatConfig,
      context: rc,
      compactionMeta,
      loadTurnResponses: deps.loadTurnResponses,
      persistCompaction: deps.persistCompaction,
      setCompactCursor: deps.setCompactCursor,
      log,
    });
    const { cursorMs, summary } = compaction;
    const runner = createRunner({
      apiBaseUrl: chatConfig.primary.model.apiBaseUrl,
      apiKey: chatConfig.primary.model.apiKey,
      model: chatConfig.primary.model.model,
      apiFormat: chatConfig.primary.model.apiFormat,
      timeoutSec: chatConfig.primary.model.timeoutSec,
      extraBody: chatConfig.primary.model.extraBody,
    });

    const createTools = () => createPrimaryTools({
      chatId,
      chatConfig,
      runtimeConfig: deps.runtimeConfig,
      sendMessage: deps.sendMessage,
      banSpammer: deps.banSpammer,
      setMessageReaction: deps.setMessageReaction,
      loadMessageAttachments: deps.loadMessageAttachments,
      messageExists: deps.messageExists,
      downloadMessageMedia: deps.downloadMessageMedia,
      supportsOutboundAttachments: deps.supportsOutboundAttachments,
      readOldMessages: deps.readOldMessages,
      resolveMessageId: id => deps.resolveMessageId?.(chatId, id) ?? id,
      formatMessageId: id => deps.formatMessageId?.(chatId, id) ?? id,
      resolveModel: deps.resolveModel,
      backgroundTask: deps.backgroundTask,
      log,
    });

    const scheduler = createReplyScheduler({
      chatId,
      debounce: chatConfig.debounce,
      context: rc,
      lastProcessedMs,
      lastTurnInterrupted: lastTRInterrupted,
      failedContext: failedRc,
      onDebounceStateChange: deps.onDebounceStateChange,
      log,
      execute: async (contextAtStart, retry) => {
        // Survives a primary failure so the retry need not rerun probe.
        let probeActivation = retry?.probeActivation;
        try {
          await executeWakeup({
            chatId,
            chatConfig,
            currentChannel: deps.name,
            turnBudget: chatConfig.primary.turnBudget,
            contextAtStart,
            currentContext: rc,
            cursorMs: cursorMs(),
            summary: summary(),
            loadTurnResponses: deps.loadTurnResponses,
            persistTurnResponse: deps.persistTurnResponse,
            persistProbeResponse: deps.persistProbeResponse,
            getChatTitle: deps.getChatTitle,
            getActiveBackgroundTasks: deps.backgroundTask.getActiveTasks,
            sendTypingAction: deps.sendTypingAction,
            createTools,
            runner,
            getLastProcessedMs: lastProcessedMs,
            setLastProcessedMs: lastProcessedMs,
            probeActivation,
            onProbeActivated: activation => { probeActivation = activation; },
            log,
          });
          return { kind: 'done' };
        } catch (error) {
          const transient = isTransientModelError(error);
          log.withError(error).withFields({ chatId, transient }).error('LLM call failed');
          return transient ? { kind: 'transient-failure', probeActivation } : { kind: 'failure' };
        } finally {
          try {
            const responses = await deps.loadTurnResponses(chatId, cursorMs());
            lastTRInterrupted(wasToolLoopInterrupted(responses));
          } catch (error) {
            log.withError(error).withFields({ chatId }).warn('Failed to refresh lastTRInterrupted');
          }
        }
      },
    });

    const cleanup = () => {
      scheduler.dispose();
      compaction.dispose();
    };

    const entry = { rc, notifyTyping: scheduler.notifyTyping, cleanup };
    chatScopes.set(chatId, entry);
    return entry;
  };

  const handleEvent = (chatId: string, newRC: RenderedContext) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).rc(newRC);
  };

  const handleTyping = (chatId: string) => {
    if (!chatIds.has(chatId)) return;
    getOrCreateScope(chatId).notifyTyping();
  };

  const stop = () => {
    for (const scope of chatScopes.values())
      scope.cleanup();
    chatScopes.clear();
  };

  return { handleEvent, handleTyping, stop };
};
