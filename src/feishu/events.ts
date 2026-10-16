import * as v from 'valibot';

// The subset of Feishu event payloads LarkBot relies on. The SDK's
// EventDispatcher flattens v2 events (`header` + `event`) into one object, so
// these fields sit at the top level. Shapes follow the SDK's generated
// `IHandles` typings and the open-platform event documentation.

const UserIdSchema = v.looseObject({
  open_id: v.optional(v.string()),
  user_id: v.optional(v.string()),
  union_id: v.optional(v.string()),
});

const MentionSchema = v.looseObject({
  key: v.string(),
  id: v.optional(UserIdSchema),
  name: v.optional(v.string()),
});

// Feishu sends absent optional fields as explicit nulls (`parent_id: null`,
// `mentions: null`, ...), which the optional schemas reject as a type error.
// Drop nulls before parsing so an absent field is simply absent; a null in a
// required field still fails, now as missing.
const dropNulls = (value: unknown): unknown => {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(dropNulls).filter(item => item !== undefined);
  if (typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, dropNulls(item)] as const)
      .filter(([, item]) => item !== undefined),
  );
};

const MessageReceiveSchema = v.looseObject({
  sender: v.looseObject({
    sender_id: v.optional(UserIdSchema),
    // `user` for people; `app` (or legacy `bot`) for applications.
    sender_type: v.string(),
  }),
  message: v.looseObject({
    message_id: v.pipe(v.string(), v.minLength(1)),
    parent_id: v.optional(v.string()),
    // Milliseconds since epoch, as a decimal string.
    create_time: v.pipe(v.string(), v.regex(/^\d+$/)),
    chat_id: v.pipe(v.string(), v.minLength(1)),
    chat_type: v.string(),
    message_type: v.string(),
    content: v.string(),
    mentions: v.optional(v.array(MentionSchema)),
  }),
});

const MessageRecalledSchema = v.looseObject({
  message_id: v.pipe(v.string(), v.minLength(1)),
  chat_id: v.pipe(v.string(), v.minLength(1)),
  recall_time: v.optional(v.pipe(v.string(), v.regex(/^\d+$/))),
});

export type FeishuMention = v.InferOutput<typeof MentionSchema>;
export type FeishuMessageReceiveEvent = v.InferOutput<typeof MessageReceiveSchema>;
export type FeishuMessageRecalledEvent = v.InferOutput<typeof MessageRecalledSchema>;

export const parseMessageReceiveEvent = (data: unknown): FeishuMessageReceiveEvent =>
  v.parse(MessageReceiveSchema, dropNulls(data));

export const parseMessageRecalledEvent = (data: unknown): FeishuMessageRecalledEvent =>
  v.parse(MessageRecalledSchema, dropNulls(data));
