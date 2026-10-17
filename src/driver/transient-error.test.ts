import { describe, expect, it } from 'vitest';

import { isTransientModelError } from './transient-error';

const withCause = (error: Error, cause: unknown): Error => Object.assign(error, { cause });
const coded = (message: string, code: string): Error => Object.assign(new Error(message), { code });

// Exact shapes thrown by src/llm/{chat,messages,responses}.ts and undici.
describe('isTransientModelError', () => {
  it.each([
    ['chat timeout', new Error('chat request timed out after 17.98s')],
    ['messages timeout', new Error('messages request timed out after 12s')],
    ['responses timeout', new Error('responses request timed out after 12s')],
    ['fetch failed', new TypeError('fetch failed')],
    ['mid-body reset', new TypeError('terminated')],
    ['ECONNRESET cause', withCause(new TypeError('fetch failed'), coded('read ECONNRESET', 'ECONNRESET'))],
    ['nested UND_ERR_SOCKET cause', withCause(new Error('body read failed'), withCause(new Error('wrapper'), coded('other side closed', 'UND_ERR_SOCKET')))],
    ['ECONNREFUSED cause', withCause(new Error('x'), coded('connect ECONNREFUSED', 'ECONNREFUSED'))],
    ['ETIMEDOUT cause', withCause(new Error('x'), coded('connect ETIMEDOUT', 'ETIMEDOUT'))],
    ['EPIPE cause', withCause(new Error('x'), coded('write EPIPE', 'EPIPE'))],
    ['connect timeout cause', withCause(new Error('x'), coded('Connect Timeout Error', 'UND_ERR_CONNECT_TIMEOUT'))],
    ['headers timeout cause', withCause(new Error('x'), coded('Headers Timeout Error', 'UND_ERR_HEADERS_TIMEOUT'))],
    ['body timeout cause', withCause(new Error('x'), coded('Body Timeout Error', 'UND_ERR_BODY_TIMEOUT'))],
    ['chat 408', new Error('Chat Completions API 408: request timeout')],
    ['chat 409', new Error('Chat Completions API 409: conflict')],
    ['messages 425', new Error('Messages API 425: too early')],
    ['responses 429', new Error('Responses API 429: {"error":{"message":"rate limited"}}')],
    ['chat 500', new Error('Chat Completions API 500: internal error')],
    ['messages 503', new Error('Messages API 503: overloaded')],
    ['messages 529', new Error('Messages API 529: {"type":"error","error":{"type":"overloaded_error"}}')],
  ])('retries %s', (_name, error) => {
    expect(isTransientModelError(error)).toBe(true);
  });

  it.each([
    ['chat 400', new Error('Chat Completions API 400: Thinking mode does not support this tool_choice')],
    ['messages 401', new Error('Messages API 401: invalid x-api-key')],
    ['responses 404', new Error('Responses API 404: model not found')],
    ['responses failed status', new Error('Responses API returned failed: server_error')],
    ['forced-choice exhaustion', new Error('Model did not satisfy forced tool choice after 4 attempts')],
    ['deadline before step', new Error('Turn deadline reached before model step 2')],
    ['deadline-capped abort', withCause(new Error('Turn deadline reached during model step 1'), new Error('chat request timed out after 3.2s'))],
    ['unrelated code cause', withCause(new Error('x'), coded('no such file', 'ENOENT'))],
    ['programming TypeError', new TypeError('Cannot read properties of undefined')],
    ['non-error', 'not an error'],
  ])('does not retry %s', (_name, error) => {
    expect(isTransientModelError(error)).toBe(false);
  });
});
