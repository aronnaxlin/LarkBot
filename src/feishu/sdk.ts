import type { Readable } from 'node:stream';

import type { Logger } from '@guiiai/logg';
import * as lark from '@larksuiteoapi/node-sdk';

import { assertMessageResourceSize, FeishuApiError, MessageResourceReadError, readMessageResourceStream } from './api';
import type { FeishuApi } from './api';
import type { FeishuCredentials } from './credentials';

// The only module that touches @larksuiteoapi/node-sdk. Method shapes follow
// node-sdk 1.76.0 (commit b188be6): `Client` generated IM/contact methods,
// `Client.request` for bot info, and `WSClient` + `EventDispatcher` for the
// long connection. The SDK's higher-level `Channel` is intentionally unused: it
// brings its own dedup/policy/queueing that would compete with the Driver.

// SDK logs can contain axios errors with request config (Authorization header,
// token request bodies). Reduce every argument to a summary and drop
// credential-bearing keys before anything reaches our logs.
const SENSITIVE_KEYS = /^(config|headers|request|authorization|app_secret|.*token.*)$/i;

const describeLogArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const response = (arg as { response?: { status?: unknown; data?: { code?: unknown; msg?: unknown } } }).response;
    const extras = response
      ? ` http=${String(response.status)} code=${String(response.data?.code)} msg=${String(response.data?.msg)}`
      : '';
    return `${arg.name}: ${arg.message}${extras}`;
  }
  try {
    return JSON.stringify(arg, (key, value: unknown) => SENSITIVE_KEYS.test(key) ? '[redacted]' : value) ?? String(arg);
  } catch {
    return String(arg);
  }
};

const createRedactor = (secrets: readonly string[]) => (text: string): string => {
  let result = text;
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]');
  return result;
};

const createSdkLogger = (logger: Logger, redact: (text: string) => string): lark.Logger => {
  const log = logger.withContext('feishu:sdk');
  const format = (args: unknown[]): string => redact(args.map(describeLogArg).join(' '));
  return {
    error: (...args: unknown[]) => log.error(format(args)),
    warn: (...args: unknown[]) => log.warn(format(args)),
    info: (...args: unknown[]) => log.log(format(args)),
    debug: (...args: unknown[]) => log.debug(format(args)),
    trace: (...args: unknown[]) => log.debug(format(args)),
  };
};

const toApiError = (operation: string, error: unknown): FeishuApiError => {
  if (error instanceof FeishuApiError) return error;
  const { response, message } = (error ?? {}) as {
    message?: unknown;
    response?: { status?: unknown; data?: { code?: unknown; msg?: unknown }; headers?: Record<string, unknown> };
  };
  if (!response) return new FeishuApiError(operation, { msg: typeof message === 'string' ? message : undefined });
  const logId = response.headers?.['x-tt-logid'];
  return new FeishuApiError(operation, {
    httpStatus: typeof response.status === 'number' ? response.status : undefined,
    code: typeof response.data?.code === 'number' ? response.data.code : undefined,
    msg: typeof response.data?.msg === 'string' ? response.data.msg : undefined,
    logId: typeof logId === 'string' ? logId : undefined,
  });
};

const call = async <T extends { code?: number; msg?: string }>(
  operation: string,
  run: () => Promise<T>,
): Promise<T> => {
  let response: T;
  try {
    response = await run();
  } catch (error) {
    throw toApiError(operation, error);
  }
  if (response.code !== 0) throw new FeishuApiError(operation, { code: response.code, msg: response.msg });
  return response;
};

const resolveDomain = (domain: string): lark.Domain | string =>
  domain === 'feishu' ? lark.Domain.Feishu : domain === 'lark' ? lark.Domain.Lark : domain;

export interface FeishuEventHandlers {
  onMessageReceive: (data: unknown) => Promise<void>;
  onMessageRecalled: (data: unknown) => Promise<void>;
}

export const createFeishuSdk = (credentials: FeishuCredentials, logger: Logger) => {
  const log = logger.withContext('feishu');
  const redact = createRedactor([credentials.appSecret]);
  const sdkLogger = createSdkLogger(logger, redact);
  const domain = resolveDomain(credentials.domain);
  const client = new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    domain,
    logger: sdkLogger,
    loggerLevel: lark.LoggerLevel.warn,
  });

  const api: FeishuApi = {
    getBotInfo: async () => {
      const response = await call('bot.info', () => client.request<{
        code?: number;
        msg?: string;
        bot?: { open_id?: string; app_name?: string };
      }>({ method: 'GET', url: '/open-apis/bot/v3/info' }));
      const openId = response.bot?.open_id;
      if (!openId) throw new FeishuApiError('bot.info', { msg: 'response has no bot.open_id' });
      return { openId, name: response.bot?.app_name ?? '' };
    },
    getUserName: async openId => {
      const response = await call('contact.user.get', () => client.contact.v3.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      }));
      const name = response.data?.user?.name;
      return name === '' ? undefined : name;
    },
    sendPost: async ({ chatId, replyToMessageId, content, uuid }) => {
      const operation = replyToMessageId ? 'message.reply' : 'message.create';
      const response = replyToMessageId
        ? await call(operation, () => client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post', uuid },
        }))
        : await call(operation, () => client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'post', content, uuid },
        }));
      const messageId = response.data?.message_id;
      if (!messageId) throw new FeishuApiError(operation, { msg: 'response has no message_id' });
      const createTimeMs = Number(response.data?.create_time);
      return { messageId, createTimeMs: Number.isFinite(createTimeMs) && createTimeMs > 0 ? createTimeMs : Date.now() };
    },
    createReaction: async (messageId, emojiType) => {
      const response = await call('reaction.create', () => client.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      }));
      const reactionId = response.data?.reaction_id;
      if (!reactionId) throw new FeishuApiError('reaction.create', { msg: 'response has no reaction_id' });
      return { reactionId };
    },
    deleteReaction: async (messageId, reactionId) => {
      await call('reaction.delete', () => client.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      }));
    },
    getMessageResource: async ({ messageId, fileKey, type }) => {
      // A stream response has no `code`, so `call` does not apply; SDK/axios
      // failures are converted here and the read enforces the size cap.
      let response: { getReadableStream: () => Readable; headers?: Record<string, unknown> };
      try {
        response = await client.im.v1.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type },
        });
      } catch (error) {
        throw toApiError('message.resource.get', error);
      }
      // Reject an advertised oversized body before consuming it; the reader
      // enforces the cap again because Content-Length can be absent or wrong.
      assertMessageResourceSize(response.headers?.['content-length']);
      try {
        return await readMessageResourceStream(response.getReadableStream());
      } catch (error) {
        // Locally raised size/timeout errors carry no server data; mid-stream
        // transport failures may, so they go through the same sanitizer as
        // other SDK errors before reaching the model.
        if (error instanceof MessageResourceReadError) throw error;
        throw toApiError('message.resource.get', error);
      }
    },
  };

  let wsClient: lark.WSClient | undefined;

  // Resolves after the first WebSocket handshake. Feishu delivers each event
  // to only one connection of an app, so exactly one LarkBot process (and no
  // other long-connection consumer such as `lark-cli event consume`) may run
  // per app.
  const start = (handlers: FeishuEventHandlers): Promise<void> => {
    if (wsClient) throw new Error('Feishu WebSocket client already started');
    const eventDispatcher = new lark.EventDispatcher({ logger: sdkLogger, loggerLevel: lark.LoggerLevel.warn }).register({
      'im.message.receive_v1': data => handlers.onMessageReceive(data),
      'im.message.recalled_v1': data => handlers.onMessageRecalled(data),
    });
    return new Promise<void>((resolve, reject) => {
      wsClient = new lark.WSClient({
        appId: credentials.appId,
        appSecret: credentials.appSecret,
        domain,
        logger: sdkLogger,
        loggerLevel: lark.LoggerLevel.info,
        autoReconnect: true,
        handshakeTimeoutMs: 15_000,
        // Without this the SDK never notices a half-open socket: it pings every
        // 120s but only arms a pong watchdog when `pingTimeout` is set, and a
        // switched network (or restarted proxy) can leave the old TCP
        // connection ESTABLISHED at our end while the peer is gone, so events
        // are silently lost until something writes to the dead socket.
        wsConfig: { pingTimeout: 10 },
        onReady: () => {
          log.log('Feishu long connection ready');
          resolve();
        },
        onError: error => {
          log.withFields({ error: redact(describeLogArg(error)) }).error('Feishu long connection failed');
          reject(new Error('Feishu long connection failed; see logs'));
        },
        onReconnecting: () => log.warn('Feishu long connection lost; reconnecting'),
        onReconnected: () => log.log('Feishu long connection re-established'),
      });
      void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
        reject(new Error(`Feishu long connection start failed: ${redact(describeLogArg(error))}`));
      });
    });
  };

  const stop = (): void => {
    // Non-forced close sends a CLOSE frame so the server stops routing events
    // to this connection.
    wsClient?.close();
    wsClient = undefined;
  };

  return { api, start, stop };
};

export type FeishuSdk = ReturnType<typeof createFeishuSdk>;
