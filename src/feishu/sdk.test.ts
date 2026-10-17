import { Readable } from 'node:stream';

import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Offline stand-in for the SDK: no network, no real credentials.
const lark = vi.hoisted(() => {
  const messageResourceGet = vi.fn();
  return {
    messageResourceGet,
    wsOptions: [] as unknown[],
    Client: vi.fn(() => ({ im: { v1: { messageResource: { get: messageResourceGet } } } })),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: lark.Client,
  Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
  LoggerLevel: { warn: 'warn', info: 'info', error: 'error', debug: 'debug' },
  EventDispatcher: class {
    register() { return this; }
  },
  WSClient: class {
    constructor(options: { onReady: () => void }) {
      lark.wsOptions.push(options);
      options.onReady();
    }

    start() { return Promise.resolve(); }
    close() {}
  },
}));

const { createFeishuSdk } = await import('./sdk');
const { FeishuApiError, MAX_MESSAGE_RESOURCE_BYTES } = await import('./api');

initLogger(LogLevel.Error, Format.Pretty);
const logger = useLogger('feishu-sdk-test');

// Synthetic identifiers and secret only.
const credentials = { appId: 'cli_0123456789abcdef', appSecret: 'synthetic-secret', domain: 'feishu' } as const;
const request = { messageId: 'om_synthetic', fileKey: 'img_v3_synthetic', type: 'image' as const };
const createSdk = () => createFeishuSdk(credentials, logger);

const streamResponse = (getReadableStream: () => Readable, headers: Record<string, unknown> = {}) => ({
  getReadableStream,
  headers,
  writeFile: vi.fn(),
});

beforeEach(() => lark.messageResourceGet.mockReset());

describe('createFeishuSdk', () => {
  it('arms the WebSocket pong watchdog so half-open sockets reconnect', async () => {
    const sdk = createSdk();
    await sdk.start({ onMessageReceive: async () => {}, onMessageRecalled: async () => {} });
    expect(lark.wsOptions[0]).toMatchObject({ autoReconnect: true, wsConfig: { pingTimeout: 10 } });
    sdk.stop();
  });
});

describe('getMessageResource', () => {
  it('reads message resource bytes through the v1 resource endpoint', async () => {
    lark.messageResourceGet.mockResolvedValue(
      streamResponse(() => Readable.from([Buffer.from('synthetic')]), { 'content-length': '9' }),
    );
    await expect(createSdk().api.getMessageResource(request)).resolves.toEqual(Buffer.from('synthetic'));
    expect(lark.messageResourceGet).toHaveBeenCalledWith({
      path: { message_id: 'om_synthetic', file_key: 'img_v3_synthetic' },
      params: { type: 'image' },
    });
  });

  it('fails fast on an advertised oversized body without reading the stream', async () => {
    const getReadableStream = vi.fn(() => Readable.from([Buffer.from('x')]));
    lark.messageResourceGet.mockResolvedValue(
      streamResponse(getReadableStream, { 'content-length': String(MAX_MESSAGE_RESOURCE_BYTES + 1) }),
    );
    await expect(createSdk().api.getMessageResource(request)).rejects.toThrow('exceeds');
    expect(getReadableStream).not.toHaveBeenCalled();
  });

  it('sanitizes mid-stream transport errors and destroys the stream', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('socket hang up; authorization=Bearer synthetic-secret'));
      },
    });
    lark.messageResourceGet.mockResolvedValue(streamResponse(() => failing));
    const error = await createSdk().api.getMessageResource(request).catch(caught => caught);
    expect(error).toBeInstanceOf(FeishuApiError);
    expect((error as Error).message).not.toContain('synthetic-secret');
    expect((error as Error).message).not.toContain('socket hang up');
    expect(failing.destroyed).toBe(true);
  });
});
