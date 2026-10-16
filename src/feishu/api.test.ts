import { expect, it } from 'vitest';

import { FeishuApiError } from './api';

it('does not retain untrusted server text in model-visible errors', () => {
  const error = new FeishuApiError('message.create', {
    code: 99991400, httpStatus: 429, msg: 'secret-token', logId: 'secret-token',
  });
  expect(error.message).not.toContain('secret-token');
  expect(JSON.stringify(error)).not.toContain('secret-token');
  expect(error.retryable).toBe(true);
});
