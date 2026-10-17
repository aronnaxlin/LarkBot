import { Readable } from 'node:stream';

import { expect, it } from 'vitest';

import {
  assertMessageResourceSize,
  FeishuApiError,
  MAX_MESSAGE_RESOURCE_BYTES,
  MessageResourceReadError,
  readMessageResourceStream,
} from './api';

it('does not retain untrusted server text in model-visible errors', () => {
  const error = new FeishuApiError('message.create', {
    code: 99991400, httpStatus: 429, msg: 'secret-token', logId: 'secret-token',
  });
  expect(error.message).not.toContain('secret-token');
  expect(JSON.stringify(error)).not.toContain('secret-token');
  expect(error.retryable).toBe(true);
});

it('buffers a resource stream below the size cap', async () => {
  const bytes = await readMessageResourceStream(Readable.from([Buffer.alloc(10), Buffer.alloc(20)]));
  expect(bytes.length).toBe(30);
});

it('rejects a resource stream above the size cap and destroys it', async () => {
  const oversized = Readable.from([Buffer.alloc(MAX_MESSAGE_RESOURCE_BYTES), Buffer.alloc(1)]);
  await expect(readMessageResourceStream(oversized)).rejects.toThrow('exceeds');
  expect(oversized.destroyed).toBe(true);
});

it('rejects an advertised content-length above the size cap', () => {
  expect(() => assertMessageResourceSize(String(MAX_MESSAGE_RESOURCE_BYTES + 1))).toThrow('exceeds');
  expect(() => assertMessageResourceSize(MAX_MESSAGE_RESOURCE_BYTES + 1)).toThrow('exceeds');
  expect(() => assertMessageResourceSize(undefined)).not.toThrow();
  expect(() => assertMessageResourceSize('not-a-number')).not.toThrow();
});

it('aborts a stalled resource stream after the timeout', async () => {
  const stalled = new Readable({ read() {} });
  const error = await readMessageResourceStream(stalled, 20).catch(caught => caught);
  expect(error).toBeInstanceOf(MessageResourceReadError);
  expect((error as Error).message).toContain('timed out');
  expect(stalled.destroyed).toBe(true);
});
