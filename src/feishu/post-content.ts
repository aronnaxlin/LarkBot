import type { ContentNode } from '../adaptation/types';

// Feishu caps post/card request bodies at 30 KB. Leave headroom for the other
// request fields rather than letting the server reject the call.
const MAX_POST_CONTENT_BYTES = 28 * 1024;

// Outgoing mention syntax, taken from Feishu's `md` extension:
//   <at user_id="ou_xxx">Alice</at>
// Verified against
// https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
const MENTION_PATTERN = /<at\s+user_id\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/at>/g;

// Any other `at`/`mention` spelling would leak raw markup into the `md` text,
// which Feishu renders literally instead of as a mention.
const UNSUPPORTED_TAG_PATTERN = /<\/?(?:at|mention)\b/i;

const OPEN_ID_PATTERN = /^ou_[0-9A-Za-z_-]+$/;

interface MarkdownSegment {
  text: string;
  code: boolean;
}

const countRun = (text: string, start: number, char: string): number => {
  let end = start;
  while (text[end] === char) end++;
  return end - start;
};

const isLineStart = (text: string, index: number): boolean =>
  text.slice(text.lastIndexOf('\n', index - 1) + 1, index).trim() === '';

// An unclosed fence runs to the end of the message (CommonMark).
const findFenceEnd = (text: string, from: number, char: string, minLength: number): number => {
  let lineStart = text.indexOf('\n', from);
  if (lineStart === -1) return text.length;
  lineStart += 1;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(lineStart, end).replace(/^ {0,3}/, '');
    const run = countRun(line, 0, char);
    if (run >= minLength && line.slice(run).trim() === '') return lineEnd === -1 ? text.length : lineEnd + 1;
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return text.length;
};

const findBacktickSpanEnd = (text: string, from: number, runLength: number): number => {
  for (let i = from; i < text.length;) {
    if (text[i] !== '`') { i++; continue; }
    const run = countRun(text, i, '`');
    if (run === runLength) return i + run;
    i += run;
  }
  return -1;
};

// Splits Markdown into code and non-code segments. Mentions inside inline code
// or fenced blocks are sent verbatim: Feishu renders them as code, so neither
// rewriting them nor rejecting their syntax would be correct.
const scanSegments = (markdown: string): MarkdownSegment[] => {
  const segments: MarkdownSegment[] = [];
  let plainStart = 0;
  let i = 0;
  const push = (end: number, code: boolean): void => {
    if (end > plainStart) segments.push({ text: markdown.slice(plainStart, end), code });
    plainStart = end;
  };
  while (i < markdown.length) {
    const char = markdown[i]!;
    if (char !== '`' && char !== '~') { i++; continue; }
    const run = countRun(markdown, i, char);
    if (run >= 3 && isLineStart(markdown, i)) {
      const end = findFenceEnd(markdown, i, char, run);
      push(i, false);
      push(end, true);
      i = end;
      continue;
    }
    if (char === '`') {
      const end = findBacktickSpanEnd(markdown, i + run, run);
      if (end !== -1) {
        push(i, false);
        push(end, true);
        i = end;
        continue;
      }
    }
    i += run;
  }
  push(markdown.length, false);
  return segments;
};

const parseMention = (
  userId: string,
  rawLabel: string,
  isKnownParticipant: ((openId: string) => boolean) | undefined,
): { fragment: string; node: ContentNode } => {
  if (userId === 'all')
    throw new Error('Mentioning everyone is not supported. Write the person\'s name in plain text instead.');
  if (!OPEN_ID_PATTERN.test(userId))
    throw new Error(`Mention id "${userId}" is not a Feishu open_id; copy the uid (starting with "ou_") from the chatlog.`);
  if (isKnownParticipant && !isKnownParticipant(userId))
    throw new Error(`Unknown participant ${userId} — copy the uid from the chatlog.`);
  if (rawLabel.includes('<') || rawLabel.includes('>'))
    throw new Error('A mention label cannot contain "<" or ">"; write the person\'s name as plain text inside the tags.');
  const name = rawLabel.trim().replace(/^@/, '').replace(/\s+/g, ' ').trim();
  if (name === '')
    throw new Error(`Mention <at user_id="${userId}"> must include the person's name, e.g. <at user_id="${userId}">Alice</at>.`);
  return {
    fragment: `<at user_id="${userId}">${name}</at>`,
    // Same shape content.ts produces for an incoming `at` post element, so the
    // synthetic self-event renders like any other mention.
    node: { type: 'mention', userId, children: [{ type: 'text', text: `@${name}` }] },
  };
};

export interface FeishuPostContent {
  /** JSON-encoded `content` field for a Feishu `post` message. */
  content: string;
  /** Canonical content nodes for the synthetic self-event of the same send. */
  nodes: ContentNode[];
}

// Markdown is sent as a single `md` element of a `post` message; Feishu renders
// CommonMark + GFM there. Mentions are validated and rewritten to Feishu's
// documented wire form. Telegram-only syntax (e.g. spoilers) is not converted.
export const buildPostContent = (
  markdown: string,
  isKnownParticipant?: (openId: string) => boolean,
): FeishuPostContent => {
  if (markdown.trim() === '') throw new Error('Message text is empty.');

  const wireText: string[] = [];
  const nodes: ContentNode[] = [];
  const pushText = (text: string): void => {
    if (text === '') return;
    wireText.push(text);
    const last = nodes[nodes.length - 1];
    if (last?.type === 'text') last.text += text;
    else nodes.push({ type: 'text', text });
  };
  const rejectUnsupportedTags = (text: string): void => {
    if (UNSUPPORTED_TAG_PATTERN.test(text))
      throw new Error('Unsupported mention syntax; write it as <at user_id="ou_xxx">Name</at>.');
  };

  const pushPlain = (text: string): void => {
    let lastIndex = 0;
    MENTION_PATTERN.lastIndex = 0;
    for (let match = MENTION_PATTERN.exec(text); match; match = MENTION_PATTERN.exec(text)) {
      const plain = text.slice(lastIndex, match.index);
      rejectUnsupportedTags(plain);
      pushText(plain);
      const { fragment, node } = parseMention(match[1]!, match[2]!, isKnownParticipant);
      wireText.push(fragment);
      nodes.push(node);
      lastIndex = match.index + match[0].length;
    }
    const tail = text.slice(lastIndex);
    rejectUnsupportedTags(tail);
    pushText(tail);
  };

  for (const segment of scanSegments(markdown)) {
    if (segment.code) pushText(segment.text);
    else pushPlain(segment.text);
  }

  const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: wireText.join('') }]] } });
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_POST_CONTENT_BYTES)
    throw new Error(`Message is too long for Feishu (${bytes} bytes encoded; limit ${MAX_POST_CONTENT_BYTES}). Split it into several shorter messages.`);
  return { content, nodes };
};
