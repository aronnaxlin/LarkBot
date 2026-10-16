import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { merge } from 'es-toolkit';
import * as v from 'valibot';
import { parse as parseYaml } from 'yaml';

import { DEFAULT_TURN_BUDGET } from '../driver/turn-budget';
import type { CompactionConfig, DebounceConfig, TurnBudget } from '../driver/types';
import type { WebFetchConfig } from '../driver/web-fetch/types';
import type { WebSearchConfig } from '../driver/web-search/types';
import type { LlmEndpoint } from '../llm/types';

const llmEndpointEntries = {
  apiBaseUrl: v.string(),
  apiKey: v.string(),
  model: v.string(),
  apiFormat: v.optional(v.picklist(['openai-chat', 'responses', 'anthropic-messages'])),
  maxImagesAllowed: v.optional(v.number()),
  timeoutSec: v.optional(v.number()),
  extraBody: v.optional(v.record(v.string(), v.unknown())),
};

// --- Runtime config schema (top-level, global) ---

const DEFAULT_FILE_SIZE_LIMIT = 20 * 1024 * 1024; // 20 MB

const RuntimeSchema = v.object({
  shell: v.optional(v.pipe(v.array(v.string()), v.minLength(1)), ['/bin/bash', '-c']),
  writeFile: v.pipe(v.array(v.string()), v.minLength(1)),
  readFile: v.pipe(v.array(v.string()), v.minLength(1)),
  writeFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
  readFileSizeLimit: v.optional(v.number(), DEFAULT_FILE_SIZE_LIMIT),
});

// --- Chat-level config schemas ---

// Partial override of DEFAULT_TURN_BUDGET. The cross-field rule
// deadlineMs > minModelCallMs is checked after merging with the defaults.
const TurnBudgetOverrideSchema = v.partial(v.object({
  maxToolRounds: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxToolCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  maxParticipationCalls: v.pipe(v.number(), v.integer(), v.minValue(0)),
  deadlineMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  minModelCallMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
}));

const ChatConfigSchema = v.object({
  primary: v.optional(v.object({
    model: v.optional(v.string(), 'primary'),
    turnBudget: v.optional(TurnBudgetOverrideSchema, {}),
  }), {}),
  systemFiles: v.optional(v.array(v.string()), []),
  sendTypingAction: v.optional(v.boolean(), true),
  blockedUserIds: v.optional(v.array(v.string()), []),
  debounce: v.optional(v.object({
    initialDelayMs: v.optional(v.number(), 1000),
    typingExtendMs: v.optional(v.number(), 5000),
    maxDelayMs: v.optional(v.number(), 30000),
  }), {}),
  compaction: v.optional(v.object({
    maxContextEstTokens: v.optional(v.number(), 200000),
    workingWindowEstTokens: v.optional(v.number(), 8000),
    model: v.optional(v.string()),
  }), {}),
  probe: v.optional(v.object({
    model: v.optional(v.string()),
  }), {}),
  imageToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  animationToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  customEmojiToText: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    maxFrames: v.optional(v.number(), 5),
    maxConcurrency: v.optional(v.number(), 3),
  }), {}),
  tools: v.object({
    banSpammer: v.optional(v.boolean(), false),
    bash: v.optional(v.object({
      backgroundThresholdSec: v.optional(v.number(), 10),
    }), {}),
    web: v.optional(v.object({
      providers: v.optional(v.object({
        tavily: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        microsoftGrounding: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        jina: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
        exa: v.optional(v.object({ apiKey: v.optional(v.string(), '') }), {}),
      }), {}),
      search: v.optional(v.picklist(['tavily', 'microsoft-grounding', 'jina', 'exa'])),
      fetch: v.optional(v.picklist(['jina'])),
    }), {}),
  }),
});

// Per-chat overrides: all fields optional, no defaults
const ChatOverrideSchema = v.optional(v.partial(v.object({
  primary: v.partial(v.object({
    model: v.pipe(v.string(), v.minLength(1)),
    turnBudget: TurnBudgetOverrideSchema,
  })),
  systemFiles: v.array(v.string()),
  sendTypingAction: v.boolean(),
  blockedUserIds: v.array(v.string()),
  debounce: v.partial(v.object({
    initialDelayMs: v.number(),
    typingExtendMs: v.number(),
    maxDelayMs: v.number(),
  })),
  compaction: v.partial(v.object({
    maxContextEstTokens: v.number(),
    workingWindowEstTokens: v.number(),
    model: v.pipe(v.string(), v.minLength(1)),
  })),
  probe: v.partial(v.object({
    model: v.pipe(v.string(), v.minLength(1)),
  })),
  imageToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxConcurrency: v.number(),
  })),
  animationToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  customEmojiToText: v.partial(v.object({
    enabled: v.boolean(),
    model: v.pipe(v.string(), v.minLength(1)),
    maxFrames: v.number(),
    maxConcurrency: v.number(),
  })),
  tools: v.partial(v.object({
    banSpammer: v.boolean(),
    bash: v.partial(v.object({
      backgroundThresholdSec: v.number(),
    })),
    web: v.partial(v.object({
      providers: v.partial(v.object({
        tavily: v.partial(v.object({ apiKey: v.string() })),
        microsoftGrounding: v.partial(v.object({ apiKey: v.string() })),
        jina: v.partial(v.object({ apiKey: v.string() })),
        exa: v.partial(v.object({ apiKey: v.string() })),
      })),
      search: v.picklist(['tavily', 'microsoft-grounding', 'jina', 'exa']),
      fetch: v.picklist(['jina']),
    })),
  })),
})), {});

const BackgroundTasksSchema = v.optional(v.object({
  outputDir: v.optional(v.string(), './data/task-outputs'),
  retentionCount: v.optional(v.number(), 20),
}), {});

const ConfigSchema = v.object({
  models: v.record(v.string(), v.object(llmEndpointEntries)),
  /** Chat platform this process connects to. Exactly one platform runs per process. */
  platform: v.optional(v.picklist(['telegram', 'feishu']), 'telegram'),
  /** Required when platform is "telegram". */
  telegram: v.optional(v.object({
    botToken: v.string(),
    apiId: v.number(),
    apiHash: v.string(),
    /** Whether to enable userbot. Requires running `pnpm login` once to populate the tdlib state dir. */
    userbotEnabled: v.optional(v.boolean(), false),
    /** Override the default tdlib state directory for the bot client (defaults to data/tdlib-bot). */
    botDataDir: v.optional(v.string()),
    /** Override the default tdlib state directory for the userbot client (defaults to data/tdlib-userbot). */
    userbotDataDir: v.optional(v.string()),
  })),
  /** Used when platform is "feishu". Credentials never live in this YAML file. */
  feishu: v.optional(v.object({
    /** Dotenv-style file with FEISHU_APP_ID, FEISHU_APP_SECRET and optional FEISHU_DOMAIN. */
    credentialsFile: v.optional(v.string(), '.config/feishu_cn.env'),
  }), {}),
  database: v.optional(v.object({
    path: v.optional(v.string(), './data/cahciua.db'),
  }), {}),
  runtime: RuntimeSchema,
  backgroundTasks: BackgroundTasksSchema,
  chats: v.objectWithRest({ default: ChatConfigSchema }, ChatOverrideSchema),
});

export type Config = v.InferOutput<typeof ConfigSchema>;
export type TelegramConfig = NonNullable<Config['telegram']>;
export type ChatConfig = v.InferOutput<typeof ChatConfigSchema>;

export type RuntimeConfig = Config['runtime'];
export type BackgroundTasksConfig = Config['backgroundTasks'];

export interface ResolvedChatConfig {
  primary: { model: LlmEndpoint; turnBudget: TurnBudget };
  systemFiles: { filename: string; content: string }[];
  sendTypingAction: boolean;
  blockedUserIds: string[];
  debounce: DebounceConfig;
  compaction: CompactionConfig;
  probe: { model: LlmEndpoint };
  imageToText: { enabled: boolean; model?: string; maxConcurrency: number };
  animationToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  customEmojiToText: { enabled: boolean; model?: string; maxFrames: number; maxConcurrency: number };
  tools: {
    banSpammer: boolean;
    bash: { backgroundThresholdSec: number };
    webSearch?: WebSearchConfig;
    webFetch?: WebFetchConfig;
  };
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? 'config.yaml';

const mergeChatConfig = (config: Config, chatId: string): ChatConfig => {
  const override = config.chats[chatId];
  if (!override) throw new Error(`Unknown chat "${chatId}" — not found in chats registry`);
  return merge(structuredClone(config.chats.default), override);
};

const resolveTurnBudget = (chatId: string, merged: ChatConfig): TurnBudget => {
  const budget = { ...DEFAULT_TURN_BUDGET, ...merged.primary.turnBudget };
  // An interrupted continuation skips probe and must be able to start at least
  // one model step; otherwise the open chain could never close.
  if (budget.deadlineMs <= budget.minModelCallMs)
    throw new Error(`Chat ${chatId}: primary.turnBudget.deadlineMs (${budget.deadlineMs}) must be greater than minModelCallMs (${budget.minModelCallMs})`);
  return budget;
};

// Cross-field rules the schema cannot express.
const validateConfig = (config: Config): void => {
  for (const chatId of getChatIds(config)) resolveTurnBudget(chatId, mergeChatConfig(config, chatId));

  if (config.platform === 'telegram' && !config.telegram)
    throw new Error('Config: the "telegram" section is required when platform is "telegram"');
  if (config.platform === 'feishu') {
    for (const chatId of getChatIds(config)) {
      const merged = mergeChatConfig(config, chatId);
      // ban_spammer is a Telegram moderation backend; Feishu has no equivalent yet.
      if (merged.tools.banSpammer)
        throw new Error(`Chat ${chatId}: tools.banSpammer is not supported when platform is "feishu"`);
    }
  }
};

export const loadConfig = (): Config => {
  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parseYaml(raw);
  const config = v.parse(ConfigSchema, parsed);
  validateConfig(config);
  return config;
};

export const requireTelegramConfig = (config: Config): TelegramConfig => {
  if (!config.telegram) throw new Error('Telegram configuration is unavailable');
  return config.telegram;
};

export const resolveModel = (config: Config, name: string): LlmEndpoint => {
  const entry = config.models[name];
  if (!entry) throw new Error(`Unknown model "${name}" — not found in models registry`);
  return { ...entry, apiFormat: entry.apiFormat ?? 'openai-chat' };
};

/** Return whitelisted chat IDs (all keys in chats except "default"). */
export const getChatIds = (config: Config): string[] =>
  Object.keys(config.chats).filter(k => k !== 'default');

/** Deep-merge default chat config with per-chat overrides and resolve model names. */
export const resolveChatConfig = (config: Config, chatId: string): ResolvedChatConfig => {
  const merged = mergeChatConfig(config, chatId);

  const primaryModel = resolveModel(config, merged.primary.model);
  const web = merged.tools.web;
  const providers = web.providers;

  let webSearch: WebSearchConfig | undefined;
  if (web.search) {
    const apiKey = web.search === 'tavily' ? providers.tavily.apiKey
      : web.search === 'microsoft-grounding' ? providers.microsoftGrounding.apiKey
        : web.search === 'jina' ? providers.jina.apiKey
          : providers.exa.apiKey;
    const providerKey = web.search === 'microsoft-grounding' ? 'microsoftGrounding' : web.search;
    if (!apiKey)
      throw new Error(`Chat ${chatId}: tools.web.providers.${providerKey}.apiKey is required for web.search="${web.search}".`);
    webSearch = { provider: web.search, apiKey };
  }

  let webFetch: WebFetchConfig | undefined;
  if (web.fetch === 'jina') {
    // Jina fetch's apiKey is optional (anonymous tier works); empty string passes through.
    webFetch = { provider: 'jina', jina: { apiKey: providers.jina.apiKey } };
  }

  return {
    primary: { model: primaryModel, turnBudget: resolveTurnBudget(chatId, merged) },
    systemFiles: merged.systemFiles.map(path => ({
      filename: basename(path),
      content: readFileSync(path, 'utf-8').trim(),
    })),
    debounce: merged.debounce,
    sendTypingAction: merged.sendTypingAction,
    blockedUserIds: merged.blockedUserIds,
    compaction: {
      ...merged.compaction,
      model: merged.compaction.model ? resolveModel(config, merged.compaction.model) : undefined,
    },
    probe: {
      model: merged.probe.model ? resolveModel(config, merged.probe.model) : primaryModel,
    },
    imageToText: {
      enabled: merged.imageToText.enabled,
      model: merged.imageToText.model,
      maxConcurrency: merged.imageToText.maxConcurrency,
    },
    animationToText: {
      enabled: merged.animationToText.enabled,
      model: merged.animationToText.model,
      maxFrames: merged.animationToText.maxFrames,
      maxConcurrency: merged.animationToText.maxConcurrency,
    },
    customEmojiToText: {
      enabled: merged.customEmojiToText.enabled,
      model: merged.customEmojiToText.model,
      maxFrames: merged.customEmojiToText.maxFrames,
      maxConcurrency: merged.customEmojiToText.maxConcurrency,
    },
    tools: {
      banSpammer: merged.tools.banSpammer,
      bash: { backgroundThresholdSec: merged.tools.bash.backgroundThresholdSec },
      ...(webSearch ? { webSearch } : {}),
      ...(webFetch ? { webFetch } : {}),
    },
  };
};
