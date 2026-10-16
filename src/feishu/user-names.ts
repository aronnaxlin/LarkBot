import type { Logger } from '@guiiai/logg';

const DEFAULT_LOOKUP_TIMEOUT_MS = 1000;
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FAILURE_BACKOFF_MS = 10 * 60 * 1000;

interface CacheEntry {
  name?: string;
  // Next time a contact lookup may be attempted.
  refreshAtMs: number;
  inFlight?: Promise<void>;
}

// open_id → display name, with soft degradation.
//
// Feishu events carry only sender IDs. Names come from the contact API (which
// needs a contact scope) and from mention entries seen in messages. Lookups are
// bounded so ingress stays within Feishu's 3-second event deadline; on timeout
// or failure the last known name is reused, and an empty name lets Rendering
// fall back to the open_id. Reusing the last known name also avoids spurious
// `user_renamed` events when a lookup fails after a successful one.
export const createFeishuUserNames = (deps: {
  fetchName: (openId: string) => Promise<string | undefined>;
  // Last name known from projected history, e.g. after a restart.
  fallbackName?: (chatId: string, openId: string) => string | undefined;
  logger: Logger;
  lookupTimeoutMs?: number;
  refreshMs?: number;
  failureBackoffMs?: number;
  now?: () => number;
}) => {
  const log = deps.logger.withContext('feishu:user-names');
  const now = deps.now ?? Date.now;
  const lookupTimeoutMs = deps.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
  const failureBackoffMs = deps.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
  const cache = new Map<string, CacheEntry>();

  const remember = (openId: string, name: string | undefined): void => {
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

  const resolve = async (chatId: string, openId: string): Promise<string> => {
    let entry = cache.get(openId);
    if (!entry) {
      entry = { refreshAtMs: 0 };
      cache.set(openId, entry);
    }
    if (now() >= entry.refreshAtMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        refresh(openId, entry),
        new Promise<void>(done => {
          timer = setTimeout(done, lookupTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
    }
    return entry.name ?? deps.fallbackName?.(chatId, openId) ?? '';
  };

  return { resolve, remember };
};

export type FeishuUserNames = ReturnType<typeof createFeishuUserNames>;
