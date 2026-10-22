import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdownString } from '@velin-dev/core-vue';

const __dirname = dirname(fileURLToPath(import.meta.url));
const basePath = resolve(__dirname, '../../package.json');

// Strip Vue SSR artifacts (fragment markers, v-if placeholders),
// restore newline placeholders from template computed properties,
// unescape Velin's markdown escaping, and normalize whitespace.
const cleanVelinOutput = (raw: string): string =>
  raw
    .replace(/<!--\[-->/g, '')
    .replace(/<!--]-->/g, '')
    .replace(/<!--v-if-->/g, '')
    .replace(/​/g, '\n')
    .replace(/\\`/g, '`')
    .replace(/\\_/g, '_')
    .replace(/^[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const systemPromptTemplate = readFileSync(resolve(__dirname, '../../prompts/system.velin.md'), 'utf-8');
const lateBindingTemplate = readFileSync(resolve(__dirname, '../../prompts/late-binding.velin.md'), 'utf-8');
const compactionSystemTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-system.velin.md'), 'utf-8');
const compactionUserTemplate = readFileSync(resolve(__dirname, '../../prompts/compaction-late-binding.velin.md'), 'utf-8');
const memorySystemTemplate = readFileSync(resolve(__dirname, '../../prompts/memory-system.velin.md'), 'utf-8');
const memoryUserTemplate = readFileSync(resolve(__dirname, '../../prompts/memory-user.velin.md'), 'utf-8');

export type PromptMode = 'primary' | 'probe';
// Chat platform, matching DriverPlatform['name'].
export type PromptChannel = 'telegram' | 'feishu';

export const renderSystemPrompt = async (params: {
  mode: PromptMode;
  currentChannel: PromptChannel;
  chatId: string;
  chatTitle?: string;
  systemFiles?: { filename: string; content: string }[];
  // Whether shell tools are enabled and maintainer-gated; the template renders
  // its shell-access sentence only when true.
  shellMaintainerGated?: boolean;
  // `chats.<id>.participation`: the probe's bar for unaddressed chatter and the
  // soft self-volume brake. Static per chat, so the prompt prefix stays cached.
  participationStyle?: 'quiet' | 'normal' | 'lively';
  brakeMessages10m?: number;
  botRounds?: number;
  botInteraction?: 'requested' | 'open';
  // Person memory is injected into this chat's prompts. Gates the "Your notes"
  // paragraph; absent/false renders a byte-identical prompt.
  memoryEnabled?: boolean;
  // Gated extension hints contributed by enabled plugins for this chat.
  promptHints?: string[];
}) => {
  const { rendered } = await renderMarkdownString(systemPromptTemplate, params, basePath);
  return cleanVelinOutput(rendered);
};

export const renderLateBindingPrompt = async (params: {
  mode: PromptMode;
  currentChannel: PromptChannel;
  timeNow: string;
  isInterrupted?: boolean;
  activeBackgroundTasks?: { id: number; typeName: string; intention?: string; liveSummary: string; startedMs: number; timeoutMs: number }[];
  probeReason?: string;
  // Probe `react_only` activation: primary may react or end silently only.
  reactOnly?: boolean;
  // Participation signals from computeParticipationStats; blocks render only
  // when the driver provides the value.
  recentSelfMessages10m?: number;
  secondsSinceLastSelfMessage?: number;
  consecutiveBotExchanges?: number;
  // Soft self-volume brake threshold (messages in 10 minutes).
  brakeMessages10m?: number;
  // Bot-to-bot round cap for a human-requested exchange.
  botRounds?: number;
  // A hard participation limit is reached and nothing deterministic addresses
  // the bot: only a direct address may wake it.
  participationLimited?: boolean;
  // Extra late-binding hint contributed by an active scene or scene profile.
  sceneHint?: string;
  // Pre-rendered person-memory block (src/memory/injection.ts). Appended after
  // the template output instead of interpolated into it: Velin collapses the
  // newlines of interpolated strings and escapes markdown characters, which
  // would mangle the entries.
  memoryXml?: string;
}) => {
  const { memoryXml, sceneHint, ...templateParams } = params;
  const { rendered } = await renderMarkdownString(lateBindingTemplate, templateParams, basePath);
  let prompt = cleanVelinOutput(rendered);
  if (sceneHint) {
    prompt = `${prompt}\n\n${sceneHint}`;
  }
  return memoryXml ? `${prompt}\n\n${memoryXml}` : prompt;
};

export const renderCompactionSystemPrompt = async () => {
  const { rendered } = await renderMarkdownString(compactionSystemTemplate, {}, basePath);
  return cleanVelinOutput(rendered);
};

export const renderCompactionUserInstruction = async () => {
  const { rendered } = await renderMarkdownString(compactionUserTemplate, {}, basePath);
  return cleanVelinOutput(rendered);
};

export const renderMemorySystemPrompt = async (params: {
  cardMaxChars: number;
  selfMaxChars: number;
  hearsayMaxEntries: number;
  hearsayMaxChars: number;
  hearsayPrefix: string;
}) => {
  const { rendered } = await renderMarkdownString(memorySystemTemplate, params, basePath);
  return cleanVelinOutput(rendered);
};

export const renderMemoryUserInstruction = async (params: { currentDate: string }) => {
  const { rendered } = await renderMarkdownString(memoryUserTemplate, params, basePath);
  return cleanVelinOutput(rendered);
};
