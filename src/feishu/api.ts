import type { Readable } from 'node:stream';

// The Feishu open-platform calls LarkBot makes, as a narrow interface so that
// adaptation, ingress, and outbound logic stay testable without the SDK.
// `sdk.ts` is the only implementation.
export interface FeishuApi {
  getBotInfo(): Promise<{ openId: string; name: string }>;
  // Contact display name; undefined when the contact has no visible name.
  getUserName(openId: string): Promise<string | undefined>;
  // open_id → name of every human member of a group chat (Feishu omits bots).
  // Needs only the chat scope, so it also names members the contact API can't.
  listChatMemberNames(chatId: string): Promise<Map<string, string>>;
  // Sends one `post` message, as a quoted reply when replyToMessageId is set.
  // `uuid` makes retries of the same logical send idempotent server-side.
  sendPost(params: {
    chatId: string;
    replyToMessageId?: string;
    content: string;
    uuid: string;
  }): Promise<{ messageId: string; createTimeMs: number }>;
  createReaction(messageId: string, emojiType: string): Promise<{ reactionId: string }>;
  deleteReaction(messageId: string, reactionId: string): Promise<void>;
  // Downloads one resource embedded in a message (image/file) as raw bytes.
  // The caller supplies the resource key parsed from the persisted message.
  getMessageResource(params: {
    messageId: string;
    fileKey: string;
    type: 'image' | 'file';
  }): Promise<Buffer>;
}

// Feishu allows message resources up to 100 MB; LarkBot's shared media budget
// is 20 MB, so an oversized response is rejected instead of buffered.
export const MAX_MESSAGE_RESOURCE_BYTES = 20 * 1024 * 1024;

// A stalled transfer must not hold a tool call open indefinitely.
export const MESSAGE_RESOURCE_TIMEOUT_MS = 30_000;

// Locally raised resource-read failures (size cap, timeout). They carry no
// server or request data, so they are safe to show to the model verbatim.
export class MessageResourceReadError extends Error {}

const tooLargeError = (): MessageResourceReadError =>
  new MessageResourceReadError(`Feishu message resource exceeds the ${MAX_MESSAGE_RESOURCE_BYTES}-byte download limit`);

/** Reject an advertised oversized body before consuming the stream. */
export const assertMessageResourceSize = (contentLength: unknown): void => {
  const length = typeof contentLength === 'string' ? Number(contentLength) : contentLength;
  if (typeof length === 'number' && Number.isFinite(length) && length > MAX_MESSAGE_RESOURCE_BYTES) throw tooLargeError();
};

export const readMessageResourceStream = async (
  stream: Readable,
  timeoutMs = MESSAGE_RESOURCE_TIMEOUT_MS,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  const timer = setTimeout(() => {
    stream.destroy(new MessageResourceReadError(`Feishu message resource download timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > MAX_MESSAGE_RESOURCE_BYTES) throw tooLargeError();
      chunks.push(buffer);
    }
  } finally {
    // Abort the socket on early exit (over cap, timeout, consumer error).
    clearTimeout(timer);
    stream.destroy();
  }
  return Buffer.concat(chunks);
};

// Error surface for all Feishu API failures. It carries only the operation,
// numeric server code and HTTP status only. Free-form server messages and
// network errors may echo credentials; tool errors reach the model verbatim.
export class FeishuApiError extends Error {
  constructor(
    readonly operation: string,
    details: { code?: number; msg?: string; httpStatus?: number; logId?: string },
  ) {
    const parts = [
      details.code != null ? `code=${details.code}` : undefined,
      details.httpStatus != null ? `http=${details.httpStatus}` : undefined,
    ].filter(part => part != null);
    super(`Feishu ${operation} failed${parts.length > 0 ? `: ${parts.join(', ')}` : ' (no response)'}`);
    this.name = 'FeishuApiError';
    this.details = { code: details.code, httpStatus: details.httpStatus };
  }

  readonly details: { code?: number; httpStatus?: number };

  // Server rate limit (99991400), HTTP 429/5xx, or no response at all.
  get retryable(): boolean {
    const { code, httpStatus } = this.details;
    if (code === 99991400 || httpStatus === 429) return true;
    if (httpStatus != null) return httpStatus >= 500;
    return code == null;
  }
}
