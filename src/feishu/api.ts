// The Feishu open-platform calls LarkBot makes, as a narrow interface so that
// adaptation, ingress, and outbound logic stay testable without the SDK.
// `sdk.ts` is the only implementation.
export interface FeishuApi {
  getBotInfo(): Promise<{ openId: string; name: string }>;
  // Contact display name; undefined when the contact has no visible name.
  getUserName(openId: string): Promise<string | undefined>;
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
}

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
