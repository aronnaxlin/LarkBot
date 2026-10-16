import type { FeishuMention } from './events';
import type { ContentNode } from '../adaptation/types';

// Feishu message content → canonical ContentNode[].
//
// The SDK's `normalize()` is not used here: it flattens mentions into `@name`
// text (and strips bot mentions by default), losing the per-position open_id
// that Rendering needs for `<mention uid>` and `mentionsMe`. Text and post
// content are small enough to parse directly from the documented JSON.

const MENTION_ALL_KEY = '@_all';

interface PostElement {
  tag?: unknown;
  text?: unknown;
  href?: unknown;
  user_id?: unknown;
  user_name?: unknown;
  style?: unknown;
  language?: unknown;
  emoji_type?: unknown;
}

const asString = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

// Feishu sends empty strings for absent names; treat them as missing.
const nonEmpty = (value: string | undefined): string | undefined => value === '' ? undefined : value;

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const mentionNode = (mention: FeishuMention | undefined, fallbackLabel: string): ContentNode => {
  if (!mention) return { type: 'text', text: fallbackLabel };
  if (mention.key === MENTION_ALL_KEY) return { type: 'mention', children: [{ type: 'text', text: `@${nonEmpty(mention.name) ?? 'all'}` }] };
  const label = `@${nonEmpty(mention.name) ?? nonEmpty(mention.id?.open_id) ?? mention.key}`;
  const openId = mention.id?.open_id;
  return openId
    ? { type: 'mention', userId: openId, children: [{ type: 'text', text: label }] }
    : { type: 'mention', children: [{ type: 'text', text: label }] };
};

const pushText = (nodes: ContentNode[], text: string): void => {
  if (text === '') return;
  const last = nodes[nodes.length - 1];
  if (last?.type === 'text') last.text += text;
  else nodes.push({ type: 'text', text });
};

// Splits plain text on `@_user_N` / `@_all` placeholders that have a matching
// `mentions[]` entry. Unmatched placeholders stay literal text.
const parseTextWithMentions = (text: string, mentions: readonly FeishuMention[]): ContentNode[] => {
  const byKey = new Map(mentions.map(mention => [mention.key, mention]));
  if (!byKey.has(MENTION_ALL_KEY) && text.includes(MENTION_ALL_KEY))
    byKey.set(MENTION_ALL_KEY, { key: MENTION_ALL_KEY, name: '所有人' });
  if (byKey.size === 0) return text === '' ? [] : [{ type: 'text', text }];

  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length)
    .map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(keys.join('|'), 'g');
  const nodes: ContentNode[] = [];
  let lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    pushText(nodes, text.slice(lastIndex, match.index));
    nodes.push(mentionNode(byKey.get(match[0]), match[0]));
    lastIndex = match.index + match[0].length;
  }
  pushText(nodes, text.slice(lastIndex));
  return nodes;
};

const styled = (children: ContentNode[], style: unknown): ContentNode[] => {
  if (!Array.isArray(style)) return children;
  let result = children;
  if (style.includes('codeInline') || style.includes('code')) {
    const text = result.map(node => node.type === 'text' ? node.text : '').join('');
    return [{ type: 'code', text }];
  }
  if (style.includes('bold')) result = [{ type: 'bold', children: result }];
  if (style.includes('italic')) result = [{ type: 'italic', children: result }];
  if (style.includes('underline')) result = [{ type: 'underline', children: result }];
  if (style.includes('lineThrough') || style.includes('strikethrough')) result = [{ type: 'strikethrough', children: result }];
  return result;
};

const postElementNodes = (element: PostElement, mentions: readonly FeishuMention[]): ContentNode[] => {
  const text = asString(element.text) ?? '';
  switch (element.tag) {
  case 'text':
    return text === '' ? [] : styled([{ type: 'text', text }], element.style);
  case 'a': {
    const href = asString(element.href);
    const label: ContentNode[] = [{ type: 'text', text: nonEmpty(text) ?? href ?? '' }];
    return href ? [{ type: 'link', url: href, children: label }] : label;
  }
  case 'at': {
    // Received posts carry the `@_user_N` placeholder in user_id; fall back to
    // matching a raw open_id for robustness.
    const userId = asString(element.user_id) ?? '';
    if (userId === 'all' || userId === MENTION_ALL_KEY)
      return [mentionNode(mentions.find(m => m.key === MENTION_ALL_KEY) ?? { key: MENTION_ALL_KEY, name: '所有人' }, '@all')];
    const mention = mentions.find(m => m.key === userId || m.id?.open_id === userId);
    if (mention) return [mentionNode(mention, userId)];
    const label = `@${nonEmpty(asString(element.user_name)) ?? userId}`;
    if (userId.startsWith('ou_'))
      return [{ type: 'mention', userId, children: [{ type: 'text', text: label }] }];
    return [{ type: 'text', text: label }];
  }
  case 'code_block': {
    const language = asString(element.language)?.toLowerCase();
    return [language ? { type: 'pre', text, language } : { type: 'pre', text }];
  }
  case 'hr':
    return [{ type: 'text', text: '\n---\n' }];
  case 'emotion':
    return [{ type: 'text', text: `[${asString(element.emoji_type) ?? 'emoji'}]` }];
  case 'img':
    return [{ type: 'text', text: '[image]' }];
  case 'media':
    return [{ type: 'text', text: '[video]' }];
  default:
    return text === '' ? [] : [{ type: 'text', text }];
  }
};

const unwrapPost = (parsed: unknown): { title?: unknown; content?: unknown } | undefined => {
  if (parsed == null || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  if ('content' in record || 'title' in record) return record;
  for (const locale of ['zh_cn', 'en_us', 'ja_jp', ...Object.keys(record)]) {
    const inner = record[locale];
    if (inner != null && typeof inner === 'object') return inner as Record<string, unknown>;
  }
  return undefined;
};

const parsePost = (parsed: unknown, mentions: readonly FeishuMention[]): ContentNode[] => {
  const body = unwrapPost(parsed);
  if (!body) return [{ type: 'text', text: '[rich text]' }];
  const nodes: ContentNode[] = [];
  const title = asString(body.title);
  if (title) nodes.push({ type: 'bold', children: [{ type: 'text', text: title }] });
  const paragraphs = Array.isArray(body.content) ? body.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    if (nodes.length > 0) pushText(nodes, '\n');
    for (const element of paragraph) {
      if (element == null || typeof element !== 'object') continue;
      for (const node of postElementNodes(element as PostElement, mentions)) {
        if (node.type === 'text') pushText(nodes, node.text);
        else nodes.push(node);
      }
    }
  }
  return nodes;
};

// Media and other rich types are out of scope for the first Feishu version;
// they render as an explicit placeholder rather than disappearing.
const PLACEHOLDERS: Record<string, string> = {
  image: '[image]',
  file: '[file]',
  audio: '[audio]',
  media: '[video]',
  sticker: '[sticker]',
  interactive: '[card]',
  share_chat: '[shared chat]',
  share_user: '[shared contact]',
  merge_forward: '[forwarded messages]',
};

export const parseFeishuContent = (
  messageType: string,
  rawContent: string,
  mentions: readonly FeishuMention[] = [],
): ContentNode[] => {
  if (messageType === 'text') {
    const parsed = parseJson(rawContent) as { text?: unknown } | undefined;
    return parseTextWithMentions(asString(parsed?.text) ?? '', mentions);
  }
  if (messageType === 'post') return parsePost(parseJson(rawContent), mentions);
  return [{ type: 'text', text: PLACEHOLDERS[messageType] ?? `[unsupported message type: ${messageType}]` }];
};
