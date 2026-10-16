import { describe, expect, it } from 'vitest';

import { parseFeishuContent } from './content';
import type { FeishuMention } from './events';

const alice: FeishuMention = { key: '@_user_1', id: { open_id: 'ou_alice' }, name: 'Alice' };
const bot: FeishuMention = { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'LarkBot' };

describe('parseFeishuContent', () => {
  it('turns text mention placeholders into mention nodes keyed by open_id', () => {
    expect(parseFeishuContent('text', JSON.stringify({ text: '@_user_2 hi @_user_1, see @_user_9' }), [alice, bot])).toEqual([
      { type: 'mention', userId: 'ou_bot', children: [{ type: 'text', text: '@LarkBot' }] },
      { type: 'text', text: ' hi ' },
      { type: 'mention', userId: 'ou_alice', children: [{ type: 'text', text: '@Alice' }] },
      { type: 'text', text: ', see @_user_9' },
    ]);
  });

  it('does not confuse @_user_1 with a longer @_user_10 key', () => {
    const tenth: FeishuMention = { key: '@_user_10', id: { open_id: 'ou_ten' }, name: 'Ten' };
    const nodes = parseFeishuContent('text', JSON.stringify({ text: '@_user_10 @_user_1' }), [alice, tenth]);
    expect(nodes).toEqual([
      { type: 'mention', userId: 'ou_ten', children: [{ type: 'text', text: '@Ten' }] },
      { type: 'text', text: ' ' },
      { type: 'mention', userId: 'ou_alice', children: [{ type: 'text', text: '@Alice' }] },
    ]);
  });

  it('renders @all as a mention without a user id, even when mentions[] omits it', () => {
    expect(parseFeishuContent('text', JSON.stringify({ text: '@_all lunch' }))).toEqual([
      { type: 'mention', children: [{ type: 'text', text: '@所有人' }] },
      { type: 'text', text: ' lunch' },
    ]);
  });

  it('parses post paragraphs with styles, links, mentions, and code blocks', () => {
    const post = {
      title: 'Plan',
      content: [
        [
          { tag: 'text', text: 'bold', style: ['bold'] },
          { tag: 'text', text: ' and ' },
          { tag: 'a', href: 'https://example.test', text: 'link' },
          { tag: 'at', user_id: '@_user_2', user_name: '' },
        ],
        [{ tag: 'code_block', language: 'GO', text: 'func main() {}' }],
        [{ tag: 'img', image_key: 'img_synthetic' }],
      ],
    };
    expect(parseFeishuContent('post', JSON.stringify(post), [bot])).toEqual([
      { type: 'bold', children: [{ type: 'text', text: 'Plan' }] },
      { type: 'text', text: '\n' },
      { type: 'bold', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'link', url: 'https://example.test', children: [{ type: 'text', text: 'link' }] },
      { type: 'mention', userId: 'ou_bot', children: [{ type: 'text', text: '@LarkBot' }] },
      { type: 'text', text: '\n' },
      { type: 'pre', text: 'func main() {}', language: 'go' },
      { type: 'text', text: '\n[image]' },
    ]);
  });

  it('accepts locale-wrapped post content', () => {
    expect(parseFeishuContent('post', JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: 'hi' }]] } })))
      .toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('keeps unsupported message types visible as placeholders', () => {
    expect(parseFeishuContent('image', '{"image_key":"img_synthetic"}')).toEqual([{ type: 'text', text: '[image]' }]);
    expect(parseFeishuContent('vote', '{}')).toEqual([{ type: 'text', text: '[unsupported message type: vote]' }]);
  });
});
