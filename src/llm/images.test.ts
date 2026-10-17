import { describe, expect, it } from 'vitest';

import { trimImages } from './images';
import type { ConversationEntry, ImagePart, InputPart } from '../unified-api/types';

const text = (value: string): InputPart => ({ kind: 'text', text: value });
const image = (): ImagePart => ({ kind: 'image', image: {} as ImagePart['image'], detail: 'low' });

const CAP_0 = '[image omitted: this model endpoint is configured to accept no images]';
const capN = (n: number): string =>
  `[image omitted: only the ${n} most recent images are kept in context; call read_image again with the same file-id to view it]`;

describe('trimImages', () => {
  it('replaces images with the cap-0 marker when the endpoint accepts none', () => {
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [text('look'), image(), text('now')] },
    ];

    const out = trimImages(entries, 0);

    expect(out[0]).toEqual({
      kind: 'message',
      role: 'user',
      parts: [text('look'), text(CAP_0), text('now')],
    });
  });

  it('marks only the dropped image inside a multi-image message, preserving positions', () => {
    const kept = image();
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [image(), text('mid'), kept] },
    ];

    const out = trimImages(entries, 1) as { kind: 'message'; parts: InputPart[] }[];
    const parts = out[0]!.parts;

    expect(parts).toEqual([text(capN(1)), text('mid'), kept]);
    expect(parts[2]).toBe(kept);
  });

  it('keeps an all-image tool-result payload valid, replacing every part', () => {
    const entries: ConversationEntry[] = [
      { kind: 'toolResult', callId: 'call-1', payload: [image(), image()], requiresFollowUp: false },
    ];

    const out = trimImages(entries, 0);
    const payload = (out[0] as { payload: InputPart[] }).payload;

    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toEqual([text(CAP_0), text(CAP_0)]);
  });

  it('drops the oldest images first across entries', () => {
    const oldEntries: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [image()] },
      { kind: 'message', role: 'user', parts: [image()] },
    ];

    const out = trimImages(oldEntries, 1);
    const first = out[0] as { parts: InputPart[] };
    const second = out[1] as { parts: InputPart[] };

    expect(first.parts).toEqual([text(capN(1))]);
    expect(second).toBe(oldEntries[1]);
    expect(second.parts[0]).toBe((oldEntries[1] as { parts: InputPart[] }).parts[0]);
  });

  it('returns the same array when nothing is dropped', () => {
    const entries: ConversationEntry[] = [
      { kind: 'message', role: 'user', parts: [text('hi'), image()] },
      { kind: 'message', role: 'assistant', parts: [{ kind: 'text', text: 'hello' }], reasoning: undefined },
    ];

    expect(trimImages(entries, 5)).toBe(entries);
  });

  it('never rewrites assistant messages', () => {
    const assistant: ConversationEntry = {
      kind: 'message',
      role: 'assistant',
      parts: [{ kind: 'text', text: 'reply' }],
      reasoning: undefined,
    };
    const entries: ConversationEntry[] = [
      assistant,
      { kind: 'message', role: 'user', parts: [image()] },
    ];

    const out = trimImages(entries, 0);

    expect(out[0]).toBe(assistant);
  });
});
