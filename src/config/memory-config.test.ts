import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'memory-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig, resolveChatConfig } = await import('./config');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const FEISHU = { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-secret' };

const fixture = (
  chats: Record<string, unknown>,
  options: { defaultMemory?: Record<string, unknown>; compactionModel?: string; top?: Record<string, unknown> } = {},
) => {
  writeFileSync(configPath, stringify({
    models: {
      primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'primary-model' },
      cheap: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'cheap-model' },
      other: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'other-model' },
    },
    platform: 'feishu',
    feishu: FEISHU,
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    ...options.top,
    chats: {
      default: {
        tools: {},
        ...(options.defaultMemory ? { memory: options.defaultMemory } : {}),
        ...(options.compactionModel ? { compaction: { model: options.compactionModel } } : {}),
      },
      ...chats,
    },
  }));
  return loadConfig();
};

describe('memory configuration', () => {
  it('defaults to off, with the injected-by-default shadow-mode switch and the agreed budgets', () => {
    const config = fixture({ oc_a: {} });
    expect(config.memoryDir).toBe('./data/memory');
    expect(resolveChatConfig(config, 'oc_a').memory).toEqual({
      enabled: false,
      inject: true,
      model: undefined,
      triggerMessages: 40,
      maxWindowMessages: 200,
      cardMaxChars: 1200,
      selfMaxChars: 1000,
      hearsayMaxEntries: 3,
      hearsayMaxChars: 500,
      injectionMaxChars: 4000,
      selfInjectionChars: 800,
      lookbackMessages: 30,
      recentSpeakers: 4,
      doNotReadd: 20,
    });
  });

  it('reads a global memory directory and merges per-chat overrides over the default', () => {
    const config = fixture(
      { oc_a: { memory: { enabled: true, cardMaxChars: 800, model: 'cheap' } }, oc_b: {} },
      { top: { memoryDir: '/app/data/memory' }, defaultMemory: { triggerMessages: 20, inject: false } },
    );
    expect(config.memoryDir).toBe('/app/data/memory');
    expect(resolveChatConfig(config, 'oc_a').memory).toMatchObject({
      enabled: true, inject: false, triggerMessages: 20, cardMaxChars: 800, selfMaxChars: 1000,
      model: { model: 'cheap-model', apiFormat: 'openai-chat' },
    });
    expect(resolveChatConfig(config, 'oc_b').memory).toMatchObject({ enabled: false, inject: false, triggerMessages: 20, cardMaxChars: 1200 });
  });

  it('leaves the model unset so the wiring can fall back to compaction.model and then primary', () => {
    const config = fixture({ oc_a: { memory: { enabled: true } } }, { compactionModel: 'other' });
    expect(resolveChatConfig(config, 'oc_a').memory.model).toBeUndefined();
    expect(resolveChatConfig(config, 'oc_a').compaction.model?.model).toBe('other-model');
    expect(() => resolveChatConfig(fixture({ oc_a: { memory: { model: 'nope' } } }), 'oc_a')).toThrow('Unknown model "nope"');
  });

  it('rejects out-of-range values', () => {
    const bad = (memory: Record<string, unknown>) => () => fixture({ oc_a: { memory } });
    expect(bad({ triggerMessages: 4 })).toThrow();
    expect(bad({ cardMaxChars: 99 })).toThrow();
    expect(bad({ injectionMaxChars: 50 })).toThrow();
    expect(bad({ recentSpeakers: 0 })).toThrow();
    expect(bad({ hearsayMaxChars: 0 })).toThrow();
    expect(bad({ hearsayMaxEntries: -1 })).toThrow();
    expect(bad({ doNotReadd: 1.5 })).toThrow();
    expect(bad({ model: '' })).toThrow();
    expect(bad({ enabled: 'yes' })).toThrow();
  });

  it('enforces the cross-field budget rules on the merged chat config', () => {
    const bad = (memory: Record<string, unknown>) => () => fixture({ oc_a: { memory } });
    expect(bad({ injectionMaxChars: 700, selfInjectionChars: 800, recentSpeakers: 1, cardMaxChars: 200 })).toThrow('>= selfInjectionChars');
    expect(bad({ injectionMaxChars: 700, selfInjectionChars: 100, recentSpeakers: 4, cardMaxChars: 200 })).toThrow('recentSpeakers * 200');
    // half a full card per speaker: 4000 / 4 = 1000 >= 2400 / 2 fails, 2000 passes
    expect(bad({ cardMaxChars: 2400 })).toThrow('cardMaxChars / 2');
    expect(bad({ triggerMessages: 100, maxWindowMessages: 50 })).toThrow('maxWindowMessages');
    expect(fixture({ oc_a: { memory: { cardMaxChars: 2000 } } })).toBeDefined();
    expect(fixture({ oc_a: { memory: { cardMaxChars: 2000, injectionMaxChars: 4000, recentSpeakers: 4 } } })).toBeDefined();
    // the rule applies to the merged result, so a default plus an override is checked together
    expect(() => fixture({ oc_a: { memory: { cardMaxChars: 3000 } } }, { defaultMemory: { injectionMaxChars: 4000 } })).toThrow('cardMaxChars / 2');
  });
});
