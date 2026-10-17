import { describe, expect, it, vi } from 'vitest';

import { assignMessageAliases, buildMessageAliases, createMessageIdResolver, isMessageAlias, messageAlias, MESSAGE_ALIAS_PATTERN, resolveMessageAlias, resolveMessageAliasIn } from './aliases';
import type { CanonicalUser } from '../adaptation/types';
import type { ICMessage, IntermediateContext } from '../projection/types';

const alice: CanonicalUser = { id: 'ou_alice', displayName: 'Alice', isBot: false };

const message = (messageId: string, overrides?: Partial<ICMessage>): ICMessage => ({
  type: 'message',
  messageId,
  sender: alice,
  receivedAtMs: 1000,
  timestampSec: 1741761000,
  utcOffsetMin: 480,
  content: [{ type: 'text', text: 'hi' }],
  attachments: [],
  ...overrides,
});

const ic = (nodes: IntermediateContext['nodes'], sessionId = 'oc_chat'): IntermediateContext => ({
  sessionId,
  nodes,
  users: new Map(),
});

describe('messageAlias', () => {
  it('is deterministic for the same chat and message', () => {
    expect(messageAlias('oc_chat', 'om_x')).toBe(messageAlias('oc_chat', 'om_x'));
  });

  it('does not depend on the message position in the context', () => {
    const alone = buildMessageAliases(ic([message('om_x')]));
    const appended = buildMessageAliases(ic([message('om_a'), message('om_b'), message('om_x')]));
    const prepended = buildMessageAliases(ic([message('om_x'), message('om_a')]));
    expect(appended.get('om_x')).toBe(alone.get('om_x'));
    expect(prepended.get('om_x')).toBe(alone.get('om_x'));
  });

  it('separates chats and messages', () => {
    expect(messageAlias('oc_a', 'om_x')).not.toBe(messageAlias('oc_b', 'om_x'));
    expect(messageAlias('oc_chat', 'om_x')).not.toBe(messageAlias('oc_chat', 'om_y'));
  });

  it('emits the alias grammar the tools accept', () => {
    expect(messageAlias('oc_chat', 'om_x')).toMatch(MESSAGE_ALIAS_PATTERN);
    expect(isMessageAlias('m0abc12345')).toBe(true);
    expect(isMessageAlias('om_x100b6214060334a4c0109a055669c5d')).toBe(false);
    expect(isMessageAlias('12345')).toBe(false);
  });

  it('has no collisions across realistic Feishu ids', () => {
    const ids = Array.from({ length: 10_000 }, (_, i) => `om_x100b6${i.toString(16).padStart(20, '0')}`);
    const aliases = new Set(ids.map(id => messageAlias('oc_chat', id)));
    expect(aliases.size).toBe(ids.length);
  });
});

describe('assignMessageAliases', () => {
  it('keeps the alias for the first colliding message and falls back for the later one', () => {
    // A forced collision makes the branch deterministic and testable.
    const aliases = assignMessageAliases(['first', 'second', 'third'], () => 'mcollide00');
    expect(aliases.get('first')).toBe('mcollide00');
    expect(aliases.get('second')).toBe('second');
    expect(aliases.get('third')).toBe('third');
  });

  it('keeps the distinct aliases when nothing collides', () => {
    const aliases = assignMessageAliases(['a', 'b', 'c'], id => `m${id}000`);
    expect([...aliases]).toEqual([['a', 'ma000'], ['b', 'mb000'], ['c', 'mc000']]);
  });
});

describe('buildMessageAliases', () => {
  it('maps every message and ignores non-message nodes', () => {
    const aliases = buildMessageAliases(ic([
      message('a'),
      { type: 'system_event', kind: 'chat_photo_changed', receivedAtMs: 1500, timestampSec: 1741761000, utcOffsetMin: 480 },
      message('b'),
    ]));
    expect(aliases.get('a')).toBe(messageAlias('oc_chat', 'a'));
    expect(aliases.get('b')).toBe(messageAlias('oc_chat', 'b'));
    expect(aliases.size).toBe(2);
  });
});

describe('resolveMessageAlias', () => {
  const context = ic([message('a'), message('b')]);

  it('resolves an alias back to its canonical id', () => {
    expect(resolveMessageAlias(context, messageAlias('oc_chat', 'a'))).toBe('a');
    expect(resolveMessageAlias(context, messageAlias('oc_chat', 'b'))).toBe('b');
  });

  it('returns undefined for canonical ids and unknown aliases', () => {
    expect(resolveMessageAlias(context, 'om_x')).toBeUndefined();
    expect(resolveMessageAlias(context, '12345')).toBeUndefined();
    expect(resolveMessageAlias(context, 'm0zzzzzzzzz')).toBeUndefined();
  });

  it('does not treat a collision fallback id as an alias', () => {
    // The renderer falls back to the canonical id for the later colliding
    // message, so that id must keep resolving as a canonical id, not an alias.
    const colliding = ic([message('om_first'), message('om_second')]);
    expect(assignMessageAliases(['om_first', 'om_second'], () => 'mcollide00').get('om_second')).toBe('om_second');
    expect(resolveMessageAlias(colliding, 'om_second')).toBeUndefined();
  });
});

describe('resolveMessageAliasIn', () => {
  it('resolves against persisted ids when the live context lost the message', () => {
    // Same alias the live context would render for that message.
    expect(resolveMessageAliasIn('oc_chat', messageAlias('oc_chat', 'om_old'), ['om_new', 'om_old'])).toBe('om_old');
  });

  it('ignores canonical ids and unknown aliases', () => {
    expect(resolveMessageAliasIn('oc_chat', 'om_old', ['om_old'])).toBeUndefined();
    expect(resolveMessageAliasIn('oc_chat', 'm0zzzzzzzzz', ['om_old'])).toBeUndefined();
  });
});

describe('createMessageIdResolver', () => {
  const context = ic([message('om_live')]);
  const createResolver = (overrides: Partial<Parameters<typeof createMessageIdResolver>[0]> = {}) => {
    const persistedMessageIds = vi.fn(() => ['om_persisted']);
    const contextLookup = vi.fn(() => context);
    const resolve = createMessageIdResolver({
      aliasingEnabled: () => true,
      context: contextLookup,
      persistedMessageIds,
      ...overrides,
    });
    return { resolve, persistedMessageIds, contextLookup };
  };

  it('resolves an alias through the live context without scanning persisted ids', () => {
    const { resolve, persistedMessageIds } = createResolver();
    expect(resolve('oc_chat', messageAlias('oc_chat', 'om_live'))).toBe('om_live');
    expect(persistedMessageIds).not.toHaveBeenCalled();
  });

  it('falls back to persisted ids when the context no longer holds the message', () => {
    const { resolve, persistedMessageIds } = createResolver();
    expect(resolve('oc_chat', messageAlias('oc_chat', 'om_persisted'))).toBe('om_persisted');
    expect(persistedMessageIds).toHaveBeenCalledWith('oc_chat');
  });

  it('does not resolve an alias from another chat', () => {
    // The alias is chat-scoped: the same message id in another chat hashes
    // differently, so neither the context nor the persisted scan matches it.
    const { resolve } = createResolver();
    expect(resolve('oc_chat', messageAlias('oc_other', 'om_live'))).toBe(messageAlias('oc_other', 'om_live'));
  });

  it('passes canonical and unknown ids through unchanged', () => {
    const { resolve, contextLookup, persistedMessageIds } = createResolver();
    expect(resolve('oc_chat', 'om_canonical')).toBe('om_canonical');
    expect(resolve('oc_chat', 'm0zzzzzzzzz')).toBe('m0zzzzzzzzz');
    // Canonical ids are recognized without touching the context.
    expect(contextLookup).toHaveBeenCalledTimes(1);
    expect(persistedMessageIds).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the platform does not render aliases', () => {
    const { resolve, contextLookup, persistedMessageIds } = createResolver({ aliasingEnabled: () => false });
    expect(resolve('oc_chat', messageAlias('oc_chat', 'om_live'))).toBe(messageAlias('oc_chat', 'om_live'));
    expect(contextLookup).not.toHaveBeenCalled();
    expect(persistedMessageIds).not.toHaveBeenCalled();
  });

  it('returns the raw alias when no context or persisted message matches', () => {
    const { resolve } = createResolver({ context: () => undefined, persistedMessageIds: () => [] });
    expect(resolve('oc_chat', 'm0zzzzzzzzz')).toBe('m0zzzzzzzzz');
  });
});
