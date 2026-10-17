import type { IntermediateContext } from '../projection/types';

// Message-id aliases: the rendered chatlog shows a short per-chat alias instead
// of the platform's canonical id (Feishu `om_...` ids are 34 characters and
// dominate the markup). Canonical ids stay valid everywhere; the alias is a
// display name for the model.
//
// The alias is a pure function of `(chatId, messageId)`, deliberately not
// derived from the message's position among rendered nodes:
// - reproducible from persisted history — no counter or DB state that a cold
//   replay could rebuild differently (cold replay starts at the compaction
//   cursor, so an ordinal would renumber after compaction)
// - stable for the life of a message — appending new messages never renumbers
//   an existing alias, so the rendered prefix stays byte-identical for caching
// - independent of the compaction cursor — a retained message keeps the same
//   alias it had before compaction
//
// A hash collision is the one case where an existing message's rendered id can
// change: only the first colliding message in context order keeps the alias, and
// a restart whose replay order differs could flip which one that is. 46 bits of
// hash makes collisions negligible (birthday bound ≈ 5e-7 among 10k messages in
// one chat), and `assignMessageAliases` resolves the branch deterministically.
const FNV_PRIME = 0x01000193;
const HASH_SEED_A = 0x811c9dc5;
const HASH_SEED_B = 0xc9dc811c;
const ALIAS_MODULUS = 36 ** 9;

const hash32 = (text: string, seed: number): number => {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
};

/** Grammar shared by every tool that accepts an alias instead of a canonical id. */
export const MESSAGE_ALIAS_PATTERN = /^m[0-9a-z]+$/;

export const isMessageAlias = (id: string): boolean => MESSAGE_ALIAS_PATTERN.test(id);

/**
 * Short stable alias for one message. The chat id is part of the hash so the
 * same platform message id in another chat never renders the identical alias.
 */
export const messageAlias = (chatId: string, messageId: string): string => {
  const key = `${chatId}\n${messageId}`;
  const high = hash32(key, HASH_SEED_A);
  const low = hash32(key, HASH_SEED_B);
  const value = ((high & 0xffff) * 0x100000000 + low) % ALIAS_MODULUS;
  return `m${value.toString(36).padStart(9, '0')}`;
};

/**
 * Canonical message id -> rendered id, for every message in the context.
 * A hash collision keeps the alias for the first message in context order and
 * falls back to the canonical id for the later one, so an alias always resolves
 * to exactly one message. A restart whose replay order differs for two colliding
 * messages can change which one wins; at 46 bits this is not expected.
 */
export const assignMessageAliases = (messageIds: Iterable<string>, aliasOf: (messageId: string) => string): Map<string, string> => {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const messageId of messageIds) {
    const alias = aliasOf(messageId);
    if (used.has(alias)) {
      aliases.set(messageId, messageId);
      continue;
    }
    used.add(alias);
    aliases.set(messageId, alias);
  }
  return aliases;
};

export const buildMessageAliases = (ic: IntermediateContext): Map<string, string> =>
  assignMessageAliases(
    ic.nodes.flatMap(node => node.type === 'message' ? [node.messageId] : []),
    messageId => messageAlias(ic.sessionId, messageId),
  );

/**
 * Resolve a rendered alias back to the canonical id using the live context.
 * Returns undefined for a canonical id (callers keep it unchanged) and for an
 * alias that does not name a message in this context.
 */
export const resolveMessageAlias = (ic: IntermediateContext, raw: string): string | undefined => {
  if (!isMessageAlias(raw)) return undefined;
  for (const node of ic.nodes) {
    if (node.type === 'message' && messageAlias(ic.sessionId, node.messageId) === raw)
      return node.messageId;
  }
  return undefined;
};

/**
 * Resolve an alias against candidate ids (e.g. persisted history) when the live
 * context no longer holds the message, such as an id quoted in an older summary
 * after a restart. Returns undefined for canonical ids and unknown aliases.
 */
export const resolveMessageAliasIn = (chatId: string, raw: string, messageIds: Iterable<string>): string | undefined => {
  if (!isMessageAlias(raw)) return undefined;
  for (const messageId of messageIds) {
    if (messageAlias(chatId, messageId) === raw) return messageId;
  }
  return undefined;
};

export interface MessageIdResolverDeps {
  // False when the platform renders canonical ids (Telegram), so no alias can
  // come from the chatlog and the resolver must not scan anything.
  aliasingEnabled: (chatId: string) => boolean;
  // Live context; holds every message the model can still see.
  context: (chatId: string) => IntermediateContext | undefined;
  // Persisted message ids for the chat, used only when the live context lost
  // the message (an alias quoted from an older summary after a restart).
  persistedMessageIds: (chatId: string) => Iterable<string>;
}

/**
 * Resolve a tool-supplied message id. Aliases become canonical ids; canonical
 * ids and unknown input pass through unchanged, so the existing unknown-id
 * errors still apply. The persisted scan runs only on a context miss.
 */
export const createMessageIdResolver = (deps: MessageIdResolverDeps) =>
  (chatId: string, raw: string): string => {
    if (!deps.aliasingEnabled(chatId) || !isMessageAlias(raw)) return raw;
    const context = deps.context(chatId);
    const resolved = context ? resolveMessageAlias(context, raw) : undefined;
    if (resolved) return resolved;
    return resolveMessageAliasIn(chatId, raw, deps.persistedMessageIds(chatId)) ?? raw;
  };
