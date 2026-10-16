import { describe, expect, it } from 'vitest';

import { parseMessageReceiveEvent } from './events';

// Shape captured from a real im.message.receive_v1 delivery: optional fields
// present as explicit nulls rather than omitted.
const realWorldPayload = {
  sender: {
    sender_id: { open_id: 'ou_sender', union_id: 'on_sender', user_id: null },
    sender_type: 'user',
    tenant_key: 'tenant',
  },
  message: {
    message_id: 'om_message',
    root_id: null,
    parent_id: null,
    create_time: '1792148400000',
    chat_id: 'oc_group',
    chat_type: 'group',
    message_type: 'text',
    content: JSON.stringify({ text: '@_user_1 是你吗？' }),
    mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot', union_id: null, user_id: null }, name: 'LarkBot_Test', tenant_key: 'tenant' },
    ],
    thread_id: null,
    chat_name: null,
  },
};

describe('parseMessageReceiveEvent', () => {
  it('accepts null-valued optional fields', () => {
    const event = parseMessageReceiveEvent(realWorldPayload);
    expect(event.message.chat_id).toBe('oc_group');
    expect(event.message.parent_id).toBeUndefined();
    expect(event.message.mentions?.[0]?.id?.open_id).toBe('ou_bot');
    expect(event.sender.sender_id?.user_id).toBeUndefined();
  });

  it('still rejects a payload whose required field is missing', () => {
    const broken = structuredClone(realWorldPayload);
    // @ts-expect-error — simulating a malformed delivery.
    delete broken.message.chat_id;
    expect(() => parseMessageReceiveEvent(broken)).toThrow();
  });

  it('drops a null required field instead of accepting it', () => {
    const broken = structuredClone(realWorldPayload);
    // @ts-expect-error — simulating a malformed delivery.
    broken.message.content = null;
    expect(() => parseMessageReceiveEvent(broken)).toThrow();
  });
});
