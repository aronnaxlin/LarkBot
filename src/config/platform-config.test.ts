import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'platform-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig, requireFeishuConfig, requireTelegramConfig, resolveChatConfig } = await import('./config');

const FEISHU = { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-secret' };

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const fixture = (overrides: Record<string, unknown>, chats: Record<string, unknown> = { 'oc_synthetic': {} }) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    chats: { default: { tools: {} }, ...chats },
    ...overrides,
  }));
  return loadConfig();
};

describe('platform configuration', () => {
  it('defaults to Telegram and keeps requiring its section', () => {
    const config = fixture({ telegram: { botToken: 'test', apiId: 1, apiHash: 'test' } });
    expect(config.platform).toBe('telegram');
    expect(requireTelegramConfig(config).apiId).toBe(1);
    expect(() => fixture({})).toThrow('"telegram" section is required');
  });

  it('accepts Feishu without any Telegram/TDLib configuration', () => {
    const config = fixture({ platform: 'feishu', feishu: FEISHU });
    expect(config.platform).toBe('feishu');
    expect(config.telegram).toBeUndefined();
    expect(requireFeishuConfig(config)).toEqual({ ...FEISHU, domain: 'feishu' });
    expect(() => requireTelegramConfig(config)).toThrow();
    expect(fixture({ platform: 'feishu', feishu: { ...FEISHU, domain: 'https://open.example.test' } }).feishu?.domain)
      .toBe('https://open.example.test');
  });

  it('resolves participation defaults and per-chat overrides', () => {
    const config = fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: {},
      oc_quiet: { participation: { style: 'quiet', cooldownSec: 300 } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').participation)
      .toEqual({ style: 'normal', brakeMessages10m: 10, cooldownSec: 0, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' });
    expect(resolveChatConfig(config, 'oc_quiet').participation)
      .toEqual({ style: 'quiet', brakeMessages10m: 10, cooldownSec: 300, maxPerHour: 0, botRounds: 2, botInteraction: 'requested' });
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_bad: { participation: { style: 'chatty' } } })).toThrow();
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_bad: { participation: { maxPerHour: -1 } } })).toThrow();
  });

  it('requires valid Feishu credentials in the config file', () => {
    expect(() => fixture({ platform: 'feishu' })).toThrow('"feishu" section is required');
    expect(() => fixture({ platform: 'feishu', feishu: { ...FEISHU, appId: 'not-an-app-id' } })).toThrow('cli_ application id');
    expect(() => fixture({ platform: 'feishu', feishu: { ...FEISHU, appSecret: ' ' } })).toThrow('appSecret is required');
    expect(() => fixture({ platform: 'feishu', feishu: { ...FEISHU, domain: 'ftp://example.test' } })).toThrow('feishu.domain');
    expect(fixture({ platform: 'feishu', feishu: { ...FEISHU, domain: ' lark ' } }).feishu?.domain).toBe('lark');
  });

  it('never echoes a mistyped Feishu secret in the config error', () => {
    let error: unknown;
    try {
      fixture({ platform: 'feishu', feishu: { ...FEISHU, appSecret: 98765432123 } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('feishu.appSecret must be a string');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('98765432123');
  });

  it('merges and validates execution budget overrides', () => {
    const config = fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { maxParticipationCalls: 1, deadlineMs: 9000 } } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').primary.turnBudget).toMatchObject({
      maxToolRounds: 2, maxToolCalls: 4, maxParticipationCalls: 1, deadlineMs: 9000, minModelCallMs: 2000,
    });
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { deadlineMs: 2000 } } },
    })).toThrow('must be greater than minModelCallMs');
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { deadlineMs: 5000 } } },
    })).toThrow('wrapUpReserveMs (6000) must be 0 or between');
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { wrapUpReserveMs: 1000 } } },
    })).toThrow('wrapUpReserveMs');
    expect(resolveChatConfig(fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { deadlineMs: 5000, wrapUpReserveMs: 0 } } },
    }), 'oc_synthetic').primary.turnBudget.wrapUpReserveMs).toBe(0);
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: { primary: { turnBudget: { maxParticipationCalls: -1 } } },
    })).toThrow();
  });

  it('defaults and overrides the probe timeout independently of the primary deadline', () => {
    const config = fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: {},
      oc_slow: { probe: { timeoutMs: 20000 } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').probe.timeoutMs).toBe(15000);
    expect(resolveChatConfig(config, 'oc_slow').probe.timeoutMs).toBe(20000);
    for (const timeoutMs of [0, 999, 120_001, 1500.5])
      expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_synthetic: { probe: { timeoutMs } } })).toThrow();
    for (const timeoutMs of [1_000, 120_000])
      expect(resolveChatConfig(fixture({ platform: 'feishu', feishu: FEISHU }, { oc_synthetic: { probe: { timeoutMs } } }), 'oc_synthetic').probe.timeoutMs).toBe(timeoutMs);
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, {
      default: { tools: {}, probe: { timeoutMs: 500 } },
      oc_synthetic: {},
    })).toThrow();
  });

  it('rejects Telegram-only moderation on Feishu chats', () => {
    expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { 'oc_synthetic': { tools: { banSpammer: true } } }))
      .toThrow('tools.banSpammer is not supported');
  });

  it('defaults and validates the probe context budget, summary cap and reasoning replay limit', () => {
    const config = fixture({ platform: 'feishu', feishu: FEISHU }, {
      oc_synthetic: {},
      oc_custom: { probe: { contextEstTokens: 5000, summaryMaxEstTokens: 4000 }, primary: { reasoningReplayTurns: 0 } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').probe.contextEstTokens).toBe(20000);
    expect(resolveChatConfig(config, 'oc_synthetic').probe.summaryMaxEstTokens).toBe(20000);
    expect(resolveChatConfig(config, 'oc_synthetic').primary.reasoningReplayTurns).toBe(3);
    expect(resolveChatConfig(config, 'oc_custom').probe.contextEstTokens).toBe(5000);
    expect(resolveChatConfig(config, 'oc_custom').probe.summaryMaxEstTokens).toBe(4000);
    expect(resolveChatConfig(config, 'oc_custom').primary.reasoningReplayTurns).toBe(0);
    for (const contextEstTokens of [0, 999, 1500.5])
      expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_synthetic: { probe: { contextEstTokens } } })).toThrow();
    for (const summaryMaxEstTokens of [0, 999, 1500.5])
      expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_synthetic: { probe: { summaryMaxEstTokens } } })).toThrow();
    for (const reasoningReplayTurns of [-1, 1.5])
      expect(() => fixture({ platform: 'feishu', feishu: FEISHU }, { oc_synthetic: { primary: { reasoningReplayTurns } } })).toThrow();
  });
});
