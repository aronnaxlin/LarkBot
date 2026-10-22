import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPluginHost } from './host';
import { CURRENT_SDK_VERSION, definePlugin, type PluginCapabilities, type PluginDefinition } from '../../plugins/src/sdk';
import type { Config } from '../config/config';
import type { EventSink } from '../event-sink';
import type { PipelineEvent } from '../projection/reduce';

const CHAT_ENABLED = 'oc_plugin_enabled';
const CHAT_DISABLED = 'oc_plugin_disabled';

const makeMockConfig = (pluginOverrides: Record<string, unknown> = {}): Config => ({
  models: {
    probe: {
      apiBaseUrl: 'https://api.example.com',
      apiKey: 'key',
      model: 'test-probe',
      apiFormat: 'openai-chat',
      forceToolChoice: true,
    },
  },
  maintainers: [],
  platform: 'feishu',
  runtime: {
    shell: ['/bin/sh'],
    writeFile: ['/bin/cat'],
    readFile: ['/bin/cat'],
    writeFileSizeLimit: 20000000,
    readFileSizeLimit: 20000000,
  },
  plugins: {
    server: { host: '127.0.0.1', port: 9999 },
    ...pluginOverrides,
  },
  chats: {
    default: {
      primary: { model: 'probe' },
      systemFiles: [],
      sendTypingAction: false,
      blockedUserIds: [],
      debounce: {},
      compaction: {},
      probe: {},
      memory: {},
      participation: {},
      imageToText: {},
      animationToText: {},
      customEmojiToText: {},
      tools: {},
      plugins: {},
    },
    [CHAT_ENABLED]: {
      plugins: {
        test_plugin: { enabled: true },
      },
    },
    [CHAT_DISABLED]: {
      plugins: {
        test_plugin: { enabled: false },
      },
    },
  },
} as unknown as Config);

describe('Core Plugin Host', () => {
  let tmpDataDir: string;
  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'luckybot-plugin-test-'));
  });
  afterEach(() => {
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  const createMockDeps = () => {
    const accepted: Array<{ event: PipelineEvent; options?: { notifyDriver?: boolean } }> = [];
    const eventSink: EventSink = {
      persist: vi.fn(),
      publish: vi.fn(),
      accept: vi.fn((event, options) => {
        accepted.push({ event, options });
        return undefined;
      }),
    };
    const logCalls: Array<{ level: string; msg: string; fields?: any }> = [];
    const logger: any = {
      log: (msg: string, fields?: any) => logCalls.push({ level: 'log', msg, fields }),
      warn: (msg: string, fields?: any) => logCalls.push({ level: 'warn', msg, fields }),
      error: (msg: string, fields?: any) => logCalls.push({ level: 'error', msg, fields }),
      debug: (msg: string, fields?: any) => logCalls.push({ level: 'debug', msg, fields }),
      withFields: () => logger,
      withError: () => logger,
      withContext: () => logger,
    };
    return { eventSink, accepted, logger, logCalls };
  };

  it('fails fast on incompatible sdkVersion', async () => {
    const config = makeMockConfig({ bad_plugin: { enabled: true } });
    const { eventSink, logger } = createMockDeps();

    const badPlugin: PluginDefinition = {
      id: 'bad_plugin',
      sdkVersion: 999,
      setup: vi.fn(),
    };

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [badPlugin],
      dataDir: tmpDataDir,
    });

    await expect(host.start()).rejects.toThrow('Plugin bad_plugin requires SDK version 999');
  });

  it('validates plugin configuration with configSchema', async () => {
    const config = makeMockConfig({
      strict_plugin: { portNumber: 'not-a-number' },
    });
    const { eventSink, logger } = createMockDeps();

    const strictPlugin = definePlugin({
      id: 'strict_plugin',
      sdkVersion: CURRENT_SDK_VERSION,
      configSchema: v.object({
        portNumber: v.number('portNumber must be a number'),
      }),
      setup: vi.fn(),
    });

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [strictPlugin],
      dataDir: tmpDataDir,
    });

    await expect(host.start()).rejects.toThrow('configuration failed validation');
  });

  it('skips disabled plugins without calling setup', async () => {
    const config = makeMockConfig({
      disabled_plugin: { enabled: false },
    });
    const { eventSink, logger } = createMockDeps();
    const setupFn = vi.fn();

    const disabledPlugin = definePlugin({
      id: 'disabled_plugin',
      sdkVersion: CURRENT_SDK_VERSION,
      setup: setupFn,
    });

    const host = createPluginHost({
      config,
      eventSink,
      logger,
      plugins: [disabledPlugin],
      dataDir: tmpDataDir,
    });

    await host.start();
    expect(setupFn).not.toHaveBeenCalled();
    await host.stop();
  });

  describe('Capabilities', () => {
    it('gates chat.publish by per-chat plugin enablement', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, accepted, logger } = createMockDeps();

      let publishFn: any;
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          publishFn = ctx.capabilities.chat.publish;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      // Enabled chat -> published to eventSink as plugin_event
      await publishFn(CHAT_ENABLED, {
        text: 'Hello group!',
        wake: true,
      });

      expect(accepted.length).toBe(1);
      const first = accepted[0]!;
      expect(first.event.type).toBe('runtime');
      expect((first.event as any).kind).toBe('plugin_event');
      expect((first.event as any).plugin).toBe('test_plugin');
      expect((first.event as any).text).toBe('Hello group!');
      expect(first.options?.notifyDriver).toBe(true);

      // Disabled chat -> dropped silently
      await publishFn(CHAT_DISABLED, {
        text: 'Should not appear',
        wake: true,
      });

      expect(accepted.length).toBe(1); // unchanged

      await host.stop();
    });

    it('enforces plugin identity on chat.publish and prevents spoofing (R1)', async () => {
      const config = makeMockConfig({
        rogue_plugin: { enabled: true },
      });
      // Allow rogue_plugin on CHAT_ENABLED
      (config.chats[CHAT_ENABLED]!.plugins as any).rogue_plugin = { enabled: true };

      const { eventSink, accepted, logger } = createMockDeps();

      let publishFn: any;
      const roguePlugin = definePlugin({
        id: 'rogue_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          publishFn = ctx.capabilities.chat.publish;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [roguePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      await publishFn(CHAT_ENABLED, {
        pluginId: 'admin_plugin',
        text: 'Spoofed announcement',
      } as any);

      expect(accepted.length).toBe(1);
      expect((accepted[0]!.event as any).plugin).toBe('rogue_plugin');
      await host.stop();
    });

    it('media.send throws unsupported error in this runtime', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      let mediaSend: any;
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          mediaSend = ctx.capabilities.media.send;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      await expect(mediaSend('oc_chat', { kind: 'image' })).rejects.toThrow('media.send is unsupported');
      await host.stop();
    });

    it('creates per-plugin storage directory under dataDir', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      let storageRoot = '';
      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          storageRoot = ctx.capabilities.storage.rootDir;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      expect(storageRoot).toBe(join(tmpDataDir, 'plugins', 'test_plugin'));
      await host.stop();
    });
  });

  describe('Prompt Hints', () => {
    it('aggregates prompt hints only for chats with the plugin enabled', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          promptHints: chatId => [
            { placement: 'system', text: `Hint for ${chatId}` },
            { placement: 'lateBinding', text: 'Ignored for system prompt' },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      const enabledHints = host.getSystemPromptHints(CHAT_ENABLED);
      expect(enabledHints).toEqual([`Hint for ${CHAT_ENABLED}`]);

      const disabledHints = host.getSystemPromptHints(CHAT_DISABLED);
      expect(disabledHints).toEqual([]);

      await host.stop();
    });
  });

  describe('HTTP Server routing', () => {
    it('handles routes registered by plugins with parameter extraction', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          ctx.capabilities.http.route({
            method: 'POST',
            path: '/api/items/:id',
            handler: req => ({
              status: 200,
              body: { receivedId: req.params?.id, receivedBody: req.body },
            }),
          });
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      const server = host.getHttpServer();

      // Test route matching via server handleRequest
      const reqHeaders = { 'content-type': 'application/json' };
      const rawPayload = JSON.stringify({ name: 'gadget' });
      const chunks: string[] = [];
      let statusCode = 0;
      const resHeaders: Record<string, string> = {};

      const req: any = {
        method: 'POST',
        url: '/api/items/42',
        headers: reqHeaders,
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(rawPayload);
        },
      };
      const res: any = {
        headersSent: false,
        writeHead: (status: number, headers?: any) => {
          statusCode = status;
          if (headers) Object.assign(resHeaders, headers);
          res.headersSent = true;
        },
        end: (chunk?: string) => {
          if (chunk) chunks.push(chunk);
        },
      };

      await server.handleRequest(req, res);
      expect(statusCode).toBe(200);
      const json = JSON.parse(chunks.join(''));
      expect(json).toEqual({ receivedId: '42', receivedBody: { name: 'gadget' } });

      await host.stop();
    });

    it('returns 500 without leaking error details when a handler throws', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const testPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        setup: ctx => {
          ctx.capabilities.http.route({
            method: 'GET',
            path: '/crash',
            handler: () => {
              throw new Error('Database password leak: secret123');
            },
          });
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [testPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      const server = host.getHttpServer();

      const chunks: string[] = [];
      let statusCode = 0;
      const req: any = {
        method: 'GET',
        url: '/crash',
        headers: {},
        async *[Symbol.asyncIterator]() {},
      };
      const res: any = {
        headersSent: false,
        writeHead: (status: number) => {
          statusCode = status;
          res.headersSent = true;
        },
        end: (chunk?: string) => {
          if (chunk) chunks.push(chunk);
        },
      };

      await server.handleRequest(req, res);
      expect(statusCode).toBe(500);
      const body = chunks.join('');
      expect(body).not.toContain('secret123');
      expect(body).toContain('Internal Server Error');

      await host.stop();
    });
  });

  describe('tools extension point', () => {
    it('fails fast when a plugin tool name collides with a built-in tool', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const collidingPlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'send_message',
              description: 'Colliding tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [collidingPlugin],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/collides with a built-in tool/);
    });

    it('fails fast when two plugins contribute the same tool name', async () => {
      const config = makeMockConfig({
        plugin_a: { enabled: true },
        plugin_b: { enabled: true },
      });
      const { eventSink, logger } = createMockDeps();

      const pluginA = definePlugin({
        id: 'plugin_a',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'shared_tool',
              description: 'A tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const pluginB = definePlugin({
        id: 'plugin_b',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'shared_tool',
              description: 'Another tool',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [pluginA, pluginB],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/collides with plugin "plugin_a"/);
    });

    it('fails fast on duplicate tool name within the same plugin', async () => {
      const config = makeMockConfig({ test_plugin: { enabled: true } });
      const { eventSink, logger } = createMockDeps();

      const duplicatePlugin = definePlugin({
        id: 'test_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: [
            {
              name: 'dup_tool',
              description: 'First',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
            {
              name: 'dup_tool',
              description: 'Second',
              parameters: { type: 'object' },
              execute: () => ({ content: '' }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [duplicatePlugin],
        dataDir: tmpDataDir,
      });

      await expect(host.start()).rejects.toThrow(/Duplicate tool name "dup_tool"/);
    });

    it('exposes contributed tools only to chats that have the plugin enabled', async () => {
      const config = makeMockConfig({ tool_plugin: { enabled: true } });
      config.chats['oc_enabled'] = {
        plugins: { tool_plugin: { enabled: true } },
      } as any;
      config.chats['oc_disabled'] = {
        plugins: { tool_plugin: { enabled: false } },
      } as any;

      const { eventSink, logger } = createMockDeps();

      const toolPlugin = definePlugin({
        id: 'tool_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          tools: (_chatId: string) => [
            {
              name: 'custom_calc',
              description: 'A calculator tool',
              parameters: {
                type: 'object',
                properties: { num: { type: 'number' } },
                required: ['num'],
              },
              execute: (input: any) => ({
                content: `result: ${input.num * 2}`,
                requiresFollowUp: true,
              }),
            },
          ],
        },
        setup: () => {},
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [toolPlugin],
        dataDir: tmpDataDir,
      });

      await host.start();

      const enabledTools = host.getTools('oc_enabled');
      expect(enabledTools.map(t => t.name)).toEqual(['custom_calc']);

      const tool = enabledTools[0]!;
      expect(tool.description).toBe('A calculator tool');
      const valid = tool.validate({ num: 21 });
      expect(valid.valid).toBe(true);
      const res = await tool.execute({ num: 21 });
      expect(res).toEqual({ content: 'result: 42', requiresFollowUp: true });

      const disabledTools = host.getTools('oc_disabled');
      expect(disabledTools).toEqual([]);

      await host.stop();
    });
  });

  describe('scenes capability and extension point', () => {
    it('manages scene enter, exit, and idle timeout', async () => {
      vi.useFakeTimers();
      const config = makeMockConfig({ scene_plugin: { enabled: true } });
      config.chats['oc_scene_chat'] = {
        plugins: { scene_plugin: { enabled: true } },
      } as any;

      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const scenePlugin = definePlugin({
        id: 'scene_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          scenes: [
            {
              id: 'arena',
              hint: 'Arena default hint',
              idleTimeoutMs: 5000,
            },
          ],
        },
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [scenePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      expect(capturedCaps).toBeDefined();

      // Enter scene
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      const scenes = host.getActiveScenes('oc_scene_chat');
      expect(scenes).toEqual([
        {
          pluginId: 'scene_plugin',
          sceneId: 'arena',
          key: 'scene_plugin.arena',
          defaultHint: 'Arena default hint',
        },
      ]);

      // Advance time by 4 seconds (timeout is 5000ms) - still active
      vi.advanceTimersByTime(4000);
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);

      // chat.publish from the same plugin refreshes the timeout
      await capturedCaps!.chat.publish('oc_scene_chat', { text: 'Round 2 start' });

      // Advance by another 4 seconds (8s from start, but 4s from refresh) - still active
      vi.advanceTimersByTime(4000);
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);

      // Advance another 2 seconds (6s from refresh) - now expired
      vi.advanceTimersByTime(2000);
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      // Manual enter and exit
      capturedCaps!.scene.enter('oc_scene_chat', 'arena');
      expect(host.getActiveScenes('oc_scene_chat')).toHaveLength(1);
      capturedCaps!.scene.exit('oc_scene_chat', 'arena');
      expect(host.getActiveScenes('oc_scene_chat')).toEqual([]);

      await host.stop();
      vi.useRealTimers();
    });

    it('drops scene enter if plugin is disabled for the chat', async () => {
      const config = makeMockConfig({ scene_plugin: { enabled: true } });
      config.chats['oc_disabled_chat'] = {
        plugins: { scene_plugin: { enabled: false } },
      } as any;

      const { eventSink, logger } = createMockDeps();
      let capturedCaps: PluginCapabilities | undefined;

      const scenePlugin = definePlugin({
        id: 'scene_plugin',
        sdkVersion: CURRENT_SDK_VERSION,
        contributes: {
          scenes: [{ id: 'arena', hint: 'Arena' }],
        },
        setup: ctx => {
          capturedCaps = ctx.capabilities;
        },
      });

      const host = createPluginHost({
        config,
        eventSink,
        logger,
        plugins: [scenePlugin],
        dataDir: tmpDataDir,
      });

      await host.start();
      capturedCaps!.scene.enter('oc_disabled_chat', 'arena');
      expect(host.getActiveScenes('oc_disabled_chat')).toEqual([]);
      await host.stop();
    });
  });
});
