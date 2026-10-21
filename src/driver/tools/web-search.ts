import { createTool } from './create-tool';
import type { CahciuaTool } from './types';
import type { WebSearcher } from '../web-search/types';

const EMPTY_RESULTS_NOTE = 'No results. The search index has nothing for this query; that is not evidence the thing does not exist (new or unindexed pages are common).';

export const createWebSearchTool = (searcher: WebSearcher): CahciuaTool => createTool({
  name: 'web_search',
  description: 'Search the web. Returns up to 5 results with title, URL, and a relevant snippet/passage. No results or an error only means this search found nothing; it never shows that something does not exist.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
    },
    required: ['query'],
  },
  execute: async input => {
    const { query } = input as { query: string };
    const result = await searcher.search(query);
    return {
      content: JSON.stringify({
        results: result.results.map(item => ({
          title: item.title,
          url: item.url,
          snippet: item.snippet,
          ...(item.pageAge ? { page_age: item.pageAge } : {}),
        })),
        // An empty list read as "this does not exist" (issue #20); say what it means.
        ...(result.results.length === 0 ? { note: EMPTY_RESULTS_NOTE } : {}),
      }),
      requiresFollowUp: true,
    };
  },
});
