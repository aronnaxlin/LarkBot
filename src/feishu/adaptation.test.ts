import { describe, expect, it } from 'vitest';

import { adaptFeishuMessage } from './adaptation';
import type { FeishuMessageReceiveEvent } from './events';
import type { CanonicalUser } from '../adaptation/types';

// Synthetic identifiers only; no real chat content or names.
const alice: CanonicalUser = { id: 'ou_synthetic_alice', displayName: 'Alice', isBot: false };

const event = (messageType: string, content: unknown, parentId?: string): FeishuMessageReceiveEvent => ({
  sender: { sender_id: { open_id: alice.id }, sender_type: 'user' },
  message: {
    message_id: 'om_synthetic_1',
    ...(parentId ? { parent_id: parentId } : {}),
    create_time: '1760000000000',
    chat_id: 'oc_synthetic_group',
    chat_type: 'group',
    message_type: messageType,
    content: JSON.stringify(content),
  },
});

describe('adaptFeishuMessage', () => {
  it('carries an image message key as a persisted photo attachment', () => {
    const canonical = adaptFeishuMessage(event('image', { image_key: 'img_v3_synthetic' }), alice, {
      receivedAtMs: 5000,
      utcOffsetMin: 480,
    });
    expect(canonical.content).toEqual([]);
    expect(canonical.attachments).toEqual([{ type: 'photo', fileKey: 'img_v3_synthetic' }]);
  });

  it('collects post images while keeping the text and reply linkage', () => {
    const canonical = adaptFeishuMessage(event('post', {
      content: [
        [{ tag: 'text', text: 'look' }],
        [{ tag: 'img', image_key: 'img_v3_a' }, { tag: 'img', image_key: 'img_v3_b' }],
      ],
    }, 'om_parent'), alice, { receivedAtMs: 5000, utcOffsetMin: 480 });
    expect(canonical.replyToMessageId).toBe('om_parent');
    expect(canonical.content).toEqual([{ type: 'text', text: 'look' }]);
    expect(canonical.attachments).toEqual([
      { type: 'photo', fileKey: 'img_v3_a' },
      { type: 'photo', fileKey: 'img_v3_b' },
    ]);
  });

  it('keeps messages without media attachment-free', () => {
    const canonical = adaptFeishuMessage(event('text', { text: 'hi' }), alice, {
      receivedAtMs: 5000,
      utcOffsetMin: 480,
    });
    expect(canonical.attachments).toEqual([]);
  });
});
