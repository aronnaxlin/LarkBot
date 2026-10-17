import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'platform-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig, requireTelegramConfig, resolveChatConfig } = await import('./config');

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
    const config = fixture({ platform: 'feishu' });
    expect(config.platform).toBe('feishu');
    expect(config.telegram).toBeUndefined();
    expect(config.feishu.credentialsFile).toBe('.config/feishu_cn.env');
    expect(() => requireTelegramConfig(config)).toThrow();
    expect(fixture({ platform: 'feishu', feishu: { credentialsFile: 'elsewhere.env' } }).feishu.credentialsFile).toBe('elsewhere.env');
  });

  it('merges and validates execution budget overrides', () => {
    const config = fixture({ platform: 'feishu' }, {
      oc_synthetic: { primary: { turnBudget: { maxParticipationCalls: 1, deadlineMs: 9000 } } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').primary.turnBudget).toMatchObject({
      maxToolRounds: 2, maxToolCalls: 4, maxParticipationCalls: 1, deadlineMs: 9000, minModelCallMs: 2000,
    });
    expect(() => fixture({ platform: 'feishu' }, {
      oc_synthetic: { primary: { turnBudget: { deadlineMs: 2000 } } },
    })).toThrow('must be greater than minModelCallMs');
    expect(() => fixture({ platform: 'feishu' }, {
      oc_synthetic: { primary: { turnBudget: { maxParticipationCalls: -1 } } },
    })).toThrow();
  });

  it('defaults and overrides the probe timeout independently of the primary deadline', () => {
    const config = fixture({ platform: 'feishu' }, {
      oc_synthetic: {},
      oc_slow: { probe: { timeoutMs: 20000 } },
    });
    expect(resolveChatConfig(config, 'oc_synthetic').probe.timeoutMs).toBe(15000);
    expect(resolveChatConfig(config, 'oc_slow').probe.timeoutMs).toBe(20000);
    for (const timeoutMs of [0, 999, 120_001, 1500.5])
      expect(() => fixture({ platform: 'feishu' }, { oc_synthetic: { probe: { timeoutMs } } })).toThrow();
    for (const timeoutMs of [1_000, 120_000])
      expect(resolveChatConfig(fixture({ platform: 'feishu' }, { oc_synthetic: { probe: { timeoutMs } } }), 'oc_synthetic').probe.timeoutMs).toBe(timeoutMs);
    expect(() => fixture({ platform: 'feishu' }, {
      default: { tools: {}, probe: { timeoutMs: 500 } },
      oc_synthetic: {},
    })).toThrow();
  });

  it('rejects Telegram-only moderation on Feishu chats', () => {
    expect(() => fixture({ platform: 'feishu' }, { 'oc_synthetic': { tools: { banSpammer: true } } }))
      .toThrow('tools.banSpammer is not supported');
  });
});
