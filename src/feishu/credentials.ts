export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  // `feishu`, `lark`, or an explicit https:// open-platform base URL.
  domain: string;
}
