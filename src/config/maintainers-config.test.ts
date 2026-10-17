import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

const directory = mkdtempSync(join(tmpdir(), 'maintainers-config-'));
const configPath = join(directory, 'config.yaml');
vi.stubEnv('CONFIG_PATH', configPath);
const { loadConfig } = await import('./config');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

const fixture = (maintainers?: unknown, chats: Record<string, unknown> = { default: { tools: {} } }) => {
  writeFileSync(configPath, stringify({
    models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
    telegram: { botToken: 'test', apiId: 1, apiHash: 'test' },
    runtime: { writeFile: ['cat'], readFile: ['cat'] },
    ...(maintainers === undefined ? {} : { maintainers }),
    chats,
  }));
  return loadConfig();
};

describe('maintainers configuration', () => {
  it('defaults to an empty list', () => {
    expect(fixture().maintainers).toEqual([]);
  });

  it('accepts unique non-empty canonical ids from either platform', () => {
    expect(fixture(['ou_abc123', '123456789']).maintainers).toEqual(['ou_abc123', '123456789']);
  });

  it('rejects empty ids, duplicates, and non-strings', () => {
    expect(() => fixture([''])).toThrow();
    expect(() => fixture(['ou_abc', 'ou_abc'])).toThrow('must be unique');
    expect(() => fixture([123])).toThrow();
    expect(() => fixture('ou_abc')).toThrow();
  });

  it('trims ids before validating and storing them', () => {
    expect(fixture([' ou_abc ']).maintainers).toEqual(['ou_abc']);
    expect(() => fixture([' ou_abc ', 'ou_abc'])).toThrow('must be unique');
    expect(() => fixture(['   '])).toThrow();
  });

  it('rejects a maintainer that a chat also blocks', () => {
    expect(() => fixture(['ou_abc'], { default: { tools: {} }, oc_room: { blockedUserIds: ['ou_abc'] } }))
      .toThrow('also in chats.oc_room.blockedUserIds');
  });

  it('rejects a maintainer blocked through the default chat config', () => {
    expect(() => fixture(['ou_abc'], { default: { tools: {}, blockedUserIds: ['ou_abc'] }, oc_room: {} }))
      .toThrow('also in chats.oc_room.blockedUserIds');
  });
});
