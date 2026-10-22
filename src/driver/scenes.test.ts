import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { renderLateBindingPrompt } from './prompt';
import { applySceneOverrides, getActiveSceneHint, type ActiveScene } from './scenes';
import { SceneProfileSchema, type ResolvedChatConfig } from '../config/config';

describe('scene overrides', () => {
  const baseChatConfig: ResolvedChatConfig = {
    primary: {
      model: {
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-4o',
        apiFormat: 'openai-chat',
        extraBody: { reasoning_effort: 'medium' },
      },
      turnBudget: {
        maxToolRounds: 2,
        maxToolCalls: 4,
        maxParticipationCalls: 3,
        deadlineMs: 15000,
        minModelCallMs: 2000,
        wrapUpReserveMs: 6000,
      },
      reasoningReplayTurns: 3,
    },
    probe: {
      model: {
        apiBaseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-4o-mini',
        apiFormat: 'openai-chat',
      },
      timeoutMs: 15000,
      contextEstTokens: 20000,
      summaryMaxEstTokens: 20000,
    },
    systemFiles: [],
    sendTypingAction: true,
    blockedUserIds: [],
    debounce: { initialDelayMs: 1000, typingExtendMs: 5000, maxDelayMs: 30000 },
    compaction: { maxContextEstTokens: 200000, workingWindowEstTokens: 8000 },
    participation: {
      style: 'normal',
      brakeMessages10m: 10,
      cooldownSec: 0,
      maxPerHour: 0,
      botRounds: 2,
      botInteraction: 'requested',
    },
    memory: {
      enabled: false,
      inject: false,
      model: { apiBaseUrl: '', apiKey: '', model: '', apiFormat: 'openai-chat' },
      triggerMessages: 10,
      maxWindowMessages: 20,
      cardMaxChars: 1200,
      selfMaxChars: 1000,
      hearsayMaxEntries: 10,
      hearsayMaxChars: 1000,
      injectionMaxChars: 4000,
      selfInjectionChars: 1000,
      lookbackMessages: 50,
      recentSpeakers: 4,
      doNotReadd: 10,
    },
    imageToText: { enabled: false, maxConcurrency: 3 },
    animationToText: { enabled: false, maxFrames: 5, maxConcurrency: 3 },
    customEmojiToText: { enabled: false, maxFrames: 5, maxConcurrency: 3 },
    plugins: { tavern: { enabled: true } },
    scenes: {
      'tavern.table': {
        hint: 'Config override hint for tavern table.',
        participation: {
          botRounds: 4,
          brakeMessages10m: 15,
        },
        primary: {
          extraBody: { reasoning_effort: 'low', custom_flag: true },
        },
      },
    },
    tools: {
      banSpammer: false,
      bash: { enabled: false, backgroundThresholdSec: 10, requireMaintainer: true, maintainerWindowSec: 600 },
    },
  };

  it('validates SceneProfileSchema strictly and rejects unknown keys (e.g. model switch)', () => {
    // Valid profile
    const valid = v.safeParse(SceneProfileSchema, {
      hint: 'A valid hint',
      participation: { botRounds: 3 },
      primary: { extraBody: { temperature: 0.7 } },
    });
    expect(valid.success).toBe(true);

    // Unknown top-level key rejected
    const unknownKey = v.safeParse(SceneProfileSchema, {
      hint: 'A valid hint',
      model: 'forbidden-model',
    });
    expect(unknownKey.success).toBe(false);

    // Unknown key inside primary rejected (model switch forbidden)
    const modelInPrimary = v.safeParse(SceneProfileSchema, {
      primary: {
        model: 'forbidden-model-switch',
        extraBody: {},
      },
    });
    expect(modelInPrimary.success).toBe(false);
  });

  it('leaves config completely unchanged when no scene is active', () => {
    const activeScenes: ActiveScene[] = [];
    const merged = applySceneOverrides(baseChatConfig, activeScenes);
    expect(merged).toBe(baseChatConfig);
    expect(getActiveSceneHint(merged, activeScenes)).toBeUndefined();
  });

  it('applies scene overrides for that wake-up only and does not mutate base config', () => {
    const activeScenes: ActiveScene[] = [
      {
        pluginId: 'tavern',
        sceneId: 'table',
        key: 'tavern.table',
        defaultHint: 'Plugin default hint',
      },
    ];

    const merged = applySceneOverrides(baseChatConfig, activeScenes);
    expect(merged).not.toBe(baseChatConfig);

    // Base config was NOT mutated
    expect(baseChatConfig.participation.botRounds).toBe(2);
    expect(baseChatConfig.participation.brakeMessages10m).toBe(10);
    expect(baseChatConfig.primary.model.extraBody).toEqual({ reasoning_effort: 'medium' });

    // Merged config has the overrides
    expect(merged.participation.botRounds).toBe(4);
    expect(merged.participation.brakeMessages10m).toBe(15);
    expect(merged.primary.model.extraBody).toEqual({
      reasoning_effort: 'low',
      custom_flag: true,
    });

    // Probe model is unaffected
    expect(merged.probe.model.model).toBe('gpt-4o-mini');
    expect(merged.probe.model.extraBody).toBeUndefined();

    // Config hint overrides plugin default hint
    const hint = getActiveSceneHint(merged, activeScenes);
    expect(hint).toBe('Config override hint for tavern table.');
  });

  it('falls back to plugin default hint when config does not supply a hint override', () => {
    const activeScenes: ActiveScene[] = [
      {
        pluginId: 'tavern',
        sceneId: 'arena',
        key: 'tavern.arena',
        defaultHint: 'Fallback default arena hint',
      },
    ];

    const hint = getActiveSceneHint(baseChatConfig, activeScenes);
    expect(hint).toBe('Fallback default arena hint');
  });

  it('renders late-binding hint only when in scene, and preserves byte-identical prompts when no scene is active', async () => {
    const timeNow = '2026-10-22T20:00:00+08:00';

    // 1. Without scene
    const promptWithoutScene = await renderLateBindingPrompt({
      mode: 'primary',
      currentChannel: 'feishu',
      timeNow,
      sceneHint: undefined,
    });

    // Baseline prompt with no sceneHint passed at all
    const promptBaseline = await renderLateBindingPrompt({
      mode: 'primary',
      currentChannel: 'feishu',
      timeNow,
    });

    expect(promptWithoutScene).toBe(promptBaseline);
    expect(promptWithoutScene).not.toContain('Config override hint');

    // 2. With scene
    const promptWithScene = await renderLateBindingPrompt({
      mode: 'primary',
      currentChannel: 'feishu',
      timeNow,
      sceneHint: 'Config override hint for tavern table.',
    });

    expect(promptWithScene).toContain('Config override hint for tavern table.');
    // The prefix before the hint is identical to promptWithoutScene
    expect(promptWithScene.startsWith(promptWithoutScene)).toBe(true);

    // 3. Probe prompt is unaffected
    const probePrompt = await renderLateBindingPrompt({
      mode: 'probe',
      currentChannel: 'feishu',
      timeNow,
      sceneHint: undefined,
    });
    expect(probePrompt).not.toContain('Config override hint');
  });
});
