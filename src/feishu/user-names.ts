import type { Logger } from '@guiiai/logg';

const DEFAULT_LOOKUP_TIMEOUT_MS = 1000;
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

// A chat's member list is refetched at most this often when an unknown sender
// is not on it (a member who just joined); a hit keeps it for the refresh window.
const DEFAULT_MEMBER_MISS_BACKOFF_MS = 10 * 60 * 1000;

interface ChatMembersEntry {
  names: Map<string, string>;
  // Next time the member list may be fetched again.
  refreshAtMs: number;
  inFlight?: Promise<void>;
}

interface CacheEntry {
  name?: string;
  // Next time a contact lookup may be attempted.
  refreshAtMs: number;
  inFlight?: Promise<void>;
}

// open_id → display name, with soft degradation.
//
// Feishu events carry only sender IDs. Names come from the contact API (which
// needs a contact scope), then from the chat's member list (needs only the chat
// scope the bot already has, and also covers members outside the contact scope
// or tenant), and from mention entries seen in messages. Lookups are
// bounded so ingress stays within Feishu's 3-second event deadline; on timeout
// or failure the last known name is reused, and an empty name lets Rendering
// fall back to the open_id. Reusing the last known name also avoids spurious
// `user_renamed` events when a lookup fails after a successful one.
export const createFeishuUserNames = (deps: {
  fetchName: (openId: string) => Promise<string | undefined>;
  // open_id → name for every human member of a chat (bots are not listed).
  fetchChatMemberNames?: (chatId: string) => Promise<Map<string, string>>;
  // Last name known from projected history, e.g. after a restart.
  fallbackName?: (chatId: string, openId: string) => string | undefined;
  logger: Logger;
  lookupTimeoutMs?: number;
  refreshMs?: number;
  failureBackoffMs?: number;
  memberMissBackoffMs?: number;
  now?: () => number;
}) => {
  const log = deps.logger.withContext('feishu:user-names');
  const now = deps.now ?? Date.now;
  const lookupTimeoutMs = deps.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const failureBackoffMs = deps.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  const memberMissBackoffMs = deps.memberMissBackoffMs ?? DEFAULT_MEMBER_MISS_BACKOFF_MS;
  const cache = new Map<string, CacheEntry>();
  const chatMembers = new Map<string, ChatMembersEntry>();
  // open_ids seen in this process, as senders or in a message's mention list.
  const known = new Set<string>();

  const remember = (openId: string, name: string | undefined): void => {
    known.add(openId);
    if (!name) return;
    const entry = cache.get(openId);
    if (entry) entry.name = name;
    else cache.set(openId, { name, refreshAtMs: 0 });
  };

  const refresh = (openId: string, entry: CacheEntry): Promise<void> => {
    entry.inFlight ??= deps.fetchName(openId)
      .then(name => {
        if (name) entry.name = name;
        entry.refreshAtMs = now() + refreshMs;
      }, (error: unknown) => {
        entry.refreshAtMs = now() + failureBackoffMs;
        log.withFields({ openId, error: error instanceof Error ? error.message : String(error) })
          .warn('Contact name lookup failed; using last known name');
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
    return entry.inFlight;
  };

  const refreshMembers = (chatId: string, entry: ChatMembersEntry, fetch: (chatId: string) => Promise<Map<string, string>>): Promise<void> => {
    entry.inFlight ??= fetch(chatId)
      .then(names => {
        entry.names = names;
        entry.refreshAtMs = now() + refreshMs;
      }, (error: unknown) => {
        entry.refreshAtMs = now() + failureBackoffMs;
        log.withFields({ chatId, error: error instanceof Error ? error.message : String(error) })
          .warn('Chat member list lookup failed');
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
    return entry.inFlight;
  };

  const withTimeout = async (work: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      work,
      new Promise<void>(done => {
        timer = setTimeout(done, lookupTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
  };

  // Fallback when the contact API yields no name: the chat's member list.
  const memberName = async (chatId: string, openId: string): Promise<string | undefined> => {
    const fetch = deps.fetchChatMemberNames;
    if (!fetch) return undefined;
    let entry = chatMembers.get(chatId);
    if (!entry) {
      entry = { names: new Map(), refreshAtMs: 0 };
      chatMembers.set(chatId, entry);
    }
    if (!entry.names.has(openId) && now() >= entry.refreshAtMs) {
      await withTimeout(refreshMembers(chatId, entry, fetch));
      // Not listed (e.g. joined after the fetch): retry sooner than a hit would.
      if (!entry.inFlight && !entry.names.has(openId))
        entry.refreshAtMs = Math.min(entry.refreshAtMs, now() + memberMissBackoffMs);
    }
    return entry.names.get(openId);
  };

  const resolve = async (chatId: string, openId: string): Promise<string> => {
    known.add(openId);
    let entry = cache.get(openId);
    if (!entry) {
      entry = { refreshAtMs: 0 };
      cache.set(openId, entry);
    }
    if (now() >= entry.refreshAtMs) await withTimeout(refresh(openId, entry));
    if (!entry.name) {
      const name = await memberName(chatId, openId);
      if (name) entry.name = name;
    }
    return entry.name ?? deps.fallbackName?.(chatId, openId) ?? '';
  };

  // True when the open_id is a participant this process has seen, or one that
  // projected history knows (a restart clears the in-process set, and the
  // fallback keeps mentions of previously-seen members working).
  const isKnown = (chatId: string, openId: string): boolean =>
    known.has(openId) || deps.fallbackName?.(chatId, openId) != null;

  return { resolve, remember, isKnown };
};

export type FeishuUserNames = ReturnType<typeof createFeishuUserNames>;
