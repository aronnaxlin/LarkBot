import { Format, initLogger, LogLevel, useLogger } from '@guiiai/logg';
import { describe, expect, it, vi } from 'vitest';

const wsOptions = vi.hoisted(() => [] as unknown[]);

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { warn: 2, info: 3 },
  Client: class {},
  EventDispatcher: class {
    register() { return this; }
  },
  WSClient: class {
    constructor(options: { onReady: () => void }) {
      wsOptions.push(options);
      options.onReady();
    }

    start() { return Promise.resolve(); }
    close() {}
  },
}));

import { createFeishuSdk } from './sdk';

initLogger(LogLevel.Error, Format.Pretty);

describe('createFeishuSdk', () => {
  it('arms the WebSocket pong watchdog so half-open sockets reconnect', async () => {
    const sdk = createFeishuSdk({ appId: 'app', appSecret: 'secret', domain: 'feishu' }, useLogger('feishu-sdk-test'));
    await sdk.start({ onMessageReceive: async () => {}, onMessageRecalled: async () => {} });
    expect(wsOptions[0]).toMatchObject({ autoReconnect: true, wsConfig: { pingTimeout: 10 } });
    sdk.stop();
  });
});
