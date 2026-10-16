import { readFileSync } from 'node:fs';

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  // `feishu`, `lark`, or an explicit https:// open-platform base URL.
  domain: string;
}

// Minimal dotenv reader. Values are returned to the caller only: they are never
// copied into process.env (child processes such as the bash tool inherit it),
// never interpolated, and never included in error messages — errors name the
// offending key or line number only.
const parseEnvFile = (raw: string): Map<string, string> => {
  const values = new Map<string, string>();
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(trimmed);
    if (!match) throw new Error(`Feishu credentials file: line ${index + 1} is not KEY=VALUE`);
    const key = match[1]!;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === '\'') && value.length >= 2 && value.endsWith(quote))
      value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
};

const requireValue = (values: Map<string, string>, key: string): string => {
  const value = values.get(key);
  if (value == null || value === '') throw new Error(`Feishu credentials file: ${key} is missing or empty`);
  return value;
};

export const parseFeishuCredentials = (raw: string): FeishuCredentials => {
  const values = parseEnvFile(raw);
  const configuredDomain = values.get('FEISHU_DOMAIN');
  const domain = configuredDomain == null || configuredDomain === '' ? 'feishu' : configuredDomain;
  if (domain !== 'feishu' && domain !== 'lark' && !/^https:\/\/[^\s/]+\/?$/.test(domain))
    throw new Error('Feishu credentials file: FEISHU_DOMAIN must be "feishu", "lark", or an https:// base URL');
  const appId = requireValue(values, 'FEISHU_APP_ID');
  // The SDK's WSClient silently refuses to start with a malformed app id.
  if (!/^cli_[0-9a-fA-F]{16}$/.test(appId))
    throw new Error('Feishu credentials file: FEISHU_APP_ID is not a cli_ application id');
  return { appId, appSecret: requireValue(values, 'FEISHU_APP_SECRET'), domain };
};

export const loadFeishuCredentials = (path: string): FeishuCredentials => {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    // Re-throw with the path only; fs errors carry no file content.
    throw new Error(`Cannot read Feishu credentials file at ${path}`, { cause: error });
  }
  return parseFeishuCredentials(raw);
};
