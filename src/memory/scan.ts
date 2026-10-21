// Write-time backstop for memory text. Provenance and intent checks are the
// defence; this rejects the obvious shapes of prompt injection and secrets that
// would otherwise be replayed into every later prompt. The list is a code
// constant on purpose: no deployment typo can relax it.
const STRUCTURAL = [
  /<memory/i,
  /<\//,
  /```/,
  /\{\{/,
  /\}\}/,
];

const INSTRUCTION_FRAMING = [
  /ignore (all )?(previous|above)/i,
  /system prompt/i,
  /\byou are (now )?/i,
  /\bact as\b/i,
  /new instructions/i,
  /忽略(以上|之前|前面)/,
  /系统提示/,
  /你现在是/,
  /从现在开始/,
  /指令如下/,
  /按以下要求/,
];

// Credential shapes, not the bare words, so "我的密码" stays storable.
const CREDENTIALS = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /[0-9a-f]{32,}/,
];

const URL = /https?:\/\/|www\./i;

export type ScanVerdict = { ok: true } | { ok: false; reason: string };

/**
 * `allowUrls` is for text the card owner wrote themselves (a link a member
 * shared is legitimate); third-party hearsay and SELF.md never carry links.
 */
export const scanMemoryText = (text: string, options: { allowUrls: boolean }): ScanVerdict => {
  for (const pattern of STRUCTURAL)
    if (pattern.test(text)) return { ok: false, reason: `structural:${pattern.source}` };
  for (const pattern of INSTRUCTION_FRAMING)
    if (pattern.test(text)) return { ok: false, reason: `instruction:${pattern.source}` };
  for (const pattern of CREDENTIALS)
    if (pattern.test(text)) return { ok: false, reason: `credential:${pattern.source}` };
  if (!options.allowUrls && URL.test(text)) return { ok: false, reason: 'url' };
  return { ok: true };
};
