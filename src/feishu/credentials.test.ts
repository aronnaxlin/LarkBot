import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadFeishuCredentials, parseFeishuCredentials } from './credentials';

// Synthetic values only.
const APP_ID = 'cli_0123456789abcdef';
const SECRET = 'synthetic-secret-value';

const directory = mkdtempSync(join(tmpdir(), 'feishu-credentials-'));
afterAll(() => rmSync(directory, { recursive: true }));

describe('Feishu credentials', () => {
  it('parses dotenv lines, quotes, comments, and ignores unrelated keys', () => {
    expect(parseFeishuCredentials([
      '# comment',
      `FEISHU_APP_ID=${APP_ID}`,
      `export FEISHU_APP_SECRET="${SECRET}"`,
      'FEISHU_DOMAIN=lark',
      'REGION=somewhere',
      'CHAT_ID=oc_synthetic',
      '',
    ].join('\n'))).toEqual({ appId: APP_ID, appSecret: SECRET, domain: 'lark' });
  });

  it('defaults to the Feishu (China) domain and accepts an explicit https base URL', () => {
    expect(parseFeishuCredentials(`FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${SECRET}`).domain).toBe('feishu');
    expect(parseFeishuCredentials(`FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${SECRET}\nFEISHU_DOMAIN=https://open.example.test`).domain)
      .toBe('https://open.example.test');
  });

  it('never echoes values in errors', () => {
    const cases = [
      `FEISHU_APP_ID=${APP_ID}`,
      `FEISHU_APP_ID=not-${SECRET}\nFEISHU_APP_SECRET=${SECRET}`,
      `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${SECRET}\nFEISHU_DOMAIN=ftp://${SECRET}`,
      `FEISHU_APP_ID=${APP_ID}\n${SECRET}`,
    ];
    for (const raw of cases) {
      let message = '';
      try {
        parseFeishuCredentials(raw);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(APP_ID);
    }
  });

  it('does not export values into process.env', () => {
    const path = join(directory, 'feishu.env');
    writeFileSync(path, `FEISHU_APP_ID=${APP_ID}\nFEISHU_APP_SECRET=${SECRET}\n`);
    const before = process.env.FEISHU_APP_SECRET;
    expect(loadFeishuCredentials(path).appSecret).toBe(SECRET);
    expect(process.env.FEISHU_APP_SECRET).toBe(before);
  });

  it('reports a missing file by path only', () => {
    expect(() => loadFeishuCredentials(join(directory, 'missing.env'))).toThrow(/Cannot read Feishu credentials file/);
  });
});
