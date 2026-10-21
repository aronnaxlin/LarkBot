import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJinaSearcher } from './jina';

const okResponse = () => new Response(JSON.stringify({ data: [{ title: 'T', url: 'https://x', content: 'c' }] }), { status: 200 });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

describe('createJinaSearcher', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('retries once after a timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(timeout()).mockResolvedValueOnce(okResponse());
    vi.stubGlobal('fetch', fetchMock);
    const result = await createJinaSearcher({ apiKey: 'k' }).search('q');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.results).toEqual([{ title: 'T', url: 'https://x', snippet: 'c' }]);
  });

  it('retries a 5xx but gives up after the second failure', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createJinaSearcher({ apiKey: 'k' }).search('q')).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a client error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createJinaSearcher({ apiKey: 'k' }).search('q')).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
