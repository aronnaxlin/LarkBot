import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

// Feishu mode must never configure or start TDLib.
const tdl = vi.hoisted(() => ({
  configure: vi.fn(() => {
    throw new Error('TDLib must not be configured in Feishu mode');
  }),
  createClient: vi.fn(() => {
    throw new Error('TDLib must not be started in Feishu mode');
  }),
}));
vi.mock('tdl', () => tdl);

// Offline stand-in for the SDK wrapper: no network, no real credentials.
const sdk = vi.hoisted(() => {
  const state: { handlers?: { onMessageReceive: (data: unknown) => Promise<void> } } = {};
  const fake = {
    api: {
      getBotInfo: async () => ({ openId: 'ou_synthetic_bot', name: 'LarkBot' }),
      getUserName: async () => 'Alice',
      sendPost: async () => ({ messageId: 'om_sent', createTimeMs: 1 }),
      createReaction: async () => ({ reactionId: 'r1' }),
      deleteReaction: async () => {},
    },
    start: async (handlers: { onMessageReceive: (data: unknown) => Promise<void> }) => {
      state.handlers = handlers;
    },
    stop: () => {},
  };
  return { state, fake, createFeishuSdk: vi.fn((_credentials: unknown, _logger: unknown) => fake) };
});
vi.mock('../feishu/sdk', () => ({ createFeishuSdk: sdk.createFeishuSdk }));

const CHAT = 'oc_synthetic_group';
const directory = mkdtempSync(join(tmpdir(), 'feishu-mode-'));
const credentialsFile = join(directory, 'feishu.env');
writeFileSync(credentialsFile, 'FEISHU_APP_ID=cli_0123456789abcdef\nFEISHU_APP_SECRET=synthetic-secret\n');
const configPath = join(directory, 'config.yaml');
writeFileSync(configPath, stringify({
  platform: 'feishu',
  feishu: { credentialsFile },
  models: { primary: { apiBaseUrl: 'https://example.test', apiKey: 'test', model: 'test' } },
  database: { path: join(directory, 'test.db') },
  runtime: { writeFile: ['cat'], readFile: ['cat'] },
  backgroundTasks: { outputDir: join(directory, 'tasks') },
  chats: { default: { tools: {}, sendTypingAction: false }, [CHAT]: {} },
}));
vi.stubEnv('CONFIG_PATH', configPath);
vi.stubEnv('CONTACTS_PATH', join(directory, 'contacts.json'));

const { buildContainer } = await import('./index');
const { TOKENS } = await import('./tokens');
const { loadEvents } = await import('../db');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true });
});

describe('Feishu platform wiring', () => {
  it('builds the Feishu stack without TDLib and routes ingress into Pipeline', async () => {
    const container = buildContainer();
    try {
      await container.get(TOKENS.PLATFORM_IDENTITY).prepare();
      expect(container.get(TOKENS.PLATFORM_IDENTITY).botUserId()).toBe('ou_synthetic_bot');
      expect(sdk.createFeishuSdk).toHaveBeenCalledWith(
        { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-secret', domain: 'feishu' },
        expect.anything(),
      );

      const driverInput = container.get(TOKENS.DRIVER_INPUT_BUS);
      const handleEvent = vi.fn();
      driverInput.attach({ handleEvent, handleTyping: vi.fn() });
      driverInput.activate();
      expect(container.get(TOKENS.DRIVER_PLATFORM).name).toBe('feishu');
      expect(container.get(TOKENS.DRIVER_PLATFORM).banSpammer).toBeUndefined();

      const runtime = container.get(TOKENS.PLATFORM_RUNTIME);
      runtime.startIngress();
      await runtime.start();
      await sdk.state.handlers!.onMessageReceive({
        sender: { sender_id: { open_id: 'ou_synthetic_alice' }, sender_type: 'user' },
        message: {
          message_id: 'om_1',
          create_time: '1760000000000',
          chat_id: CHAT,
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      });

      expect(loadEvents(container.get(TOKENS.DB), CHAT)).toMatchObject([
        { type: 'message', messageId: 'om_1', sender: { id: 'ou_synthetic_alice', displayName: 'Alice' } },
      ]);
      expect(handleEvent).toHaveBeenCalledWith(CHAT, expect.any(Array));
      // Feishu chatlogs carry the sender open_id, which outgoing mentions copy.
      const [, rendered] = handleEvent.mock.calls.at(-1) as [string, Array<{ content: Array<{ type: string; text?: string }> }>];
      expect(rendered[0]!.content[0]!.text).toContain('uid="ou_synthetic_alice"');
      // Ingress and the driver platform share one participant cache.
      const userNames = container.get(TOKENS.FEISHU_USER_NAMES);
      expect(userNames.isKnown(CHAT, 'ou_synthetic_alice')).toBe(true);
      expect(userNames.isKnown(CHAT, 'ou_synthetic_stranger')).toBe(false);
      await runtime.stop();
      expect(tdl.configure).not.toHaveBeenCalled();
      expect(tdl.createClient).not.toHaveBeenCalled();
    } finally {
      container.get(TOKENS.DB).$client.close();
      await container.dispose();
    }
  });
});
