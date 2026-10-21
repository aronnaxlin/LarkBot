import type { WebSearchResult, WebSearcher } from './types';
import { HttpError } from '../../http';

const JINA_SEARCH_URL = 'https://s.jina.ai/';
const JINA_TIMEOUT_MS = 15_000;
const JINA_MAX_RESULTS = 5;

interface JinaSearchResponse {
  data?: { title?: unknown; url?: unknown; content?: unknown; date?: unknown }[];
}

// One retry for failures that say nothing about the query: Jina's search
// often exceeds 15 s once and then answers (issue #20, 2026-10-20: a timeout
// reached the model as an error and it concluded the project was made up).
const isRetryable = (error: unknown): boolean => {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError'
    || (error instanceof TypeError && (error.message === 'fetch failed' || error.message === 'terminated'));
};

/**
 * Jina `s.jina.ai` search. `X-Retain-Images: none` keeps result snippets
 * compact — image links blow up payloads without helping a textual ranker.
 */
export const createJinaSearcher = (opts: { apiKey: string }): WebSearcher => {
  const searchOnce = async (query: string): Promise<WebSearchResult> => {
    const resp = await fetch(JINA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Retain-Images': 'none',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ q: query, count: JINA_MAX_RESULTS }),
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!resp.ok) throw new HttpError(resp.status, JINA_SEARCH_URL);

    const data = await resp.json() as JinaSearchResponse;
    return {
      results: (data.data ?? []).flatMap(r => {
        if (typeof r.title !== 'string' || typeof r.url !== 'string') return [];
        return [{
          title: r.title,
          url: r.url,
          snippet: typeof r.content === 'string' ? r.content : '',
          ...(typeof r.date === 'string' && r.date ? { pageAge: r.date } : {}),
        }];
      }),
    };
  };

  return {
    search: async (query: string): Promise<WebSearchResult> => {
      try {
        return await searchOnce(query);
      } catch (error) {
        if (!isRetryable(error)) throw error;
        return await searchOnce(query);
      }
    },
  };
};
