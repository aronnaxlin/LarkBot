import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'bash-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { findChatsWithUnreachableShellGate, loadConfig, resolveChatConfig } = await import('./config');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const fixture = (chats: Record<string, unknown>, maintainers?: string[]) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
    telegram: { botToken: 'test', apiId: 1, apiHash: 'test' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    ...(maintainers === undefined ? {} : { maintainers }),
    chats,
  }));
  return loadConfig();
};

describe('tools.bash.requireMaintainer configuration', () => {
  it('defaults to true when bash is enabled', () => {
    const config = fixture({ default: { tools: { bash: { enabled: true } } }, oc_room: {} });
    expect(resolveChatConfig(config, 'oc_room').tools.bash).toEqual({
      enabled: true,
      backgroundThresholdSec: 10,
      requireMaintainer: true,
      maintainerWindowSec: 600,
    });
  });

  it('honors false from the default chat and per-chat overrides', () => {
    const config = fixture({
      default: { tools: { bash: { requireMaintainer: false } } },
      oc_room: {},
      oc_strict: { tools: { bash: { requireMaintainer: true } } },
    });
    expect(resolveChatConfig(config, 'oc_room').tools.bash.requireMaintainer).toBe(false);
    expect(resolveChatConfig(config, 'oc_strict').tools.bash.requireMaintainer).toBe(true);
  });

  it('rejects a non-boolean value', () => {
    expect(() => fixture({
      default: { tools: { bash: { requireMaintainer: 'yes' } } },
      oc_room: {},
    })).toThrow();
  });
});

describe('tools.bash.maintainerWindowSec configuration', () => {
  it('defaults to 600 and accepts a per-chat override', () => {
    const config = fixture({
      default: { tools: { bash: {} } },
      oc_room: {},
      oc_short: { tools: { bash: { maintainerWindowSec: 60 } } },
    });
    expect(resolveChatConfig(config, 'oc_room').tools.bash.maintainerWindowSec).toBe(600);
    expect(resolveChatConfig(config, 'oc_short').tools.bash.maintainerWindowSec).toBe(60);
  });

  it('rejects zero, negative, and non-integer values', () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => fixture({
        default: { tools: { bash: { maintainerWindowSec: value } } },
        oc_room: {},
      })).toThrow();
    }
  });
});

describe('findChatsWithUnreachableShellGate', () => {
  it('reports chats with enabled, maintainer-gated bash and no maintainers', () => {
    const config = fixture({ default: { tools: {} }, oc_room: {} });
    expect(findChatsWithUnreachableShellGate(config)).toEqual(['oc_room']);
  });

  it('returns nothing once a maintainer is configured', () => {
    const config = fixture({ default: { tools: {} }, oc_room: {} }, ['ou_boss']);
    expect(findChatsWithUnreachableShellGate(config)).toEqual([]);
  });

  it('skips chats that disabled bash or the maintainer requirement', () => {
    const config = fixture({
      default: { tools: {} },
      oc_no_bash: { tools: { bash: { enabled: false } } },
      oc_open: { tools: { bash: { requireMaintainer: false } } },
    });
    expect(findChatsWithUnreachableShellGate(config)).toEqual([]);
  });
});
