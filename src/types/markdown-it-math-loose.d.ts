declare module 'markdown-it-math-loose' {
  import type MarkdownIt from 'markdown-it';
  import type Token from 'markdown-it/lib/token.mjs';

  interface MathOptions {
    inlineOpen?: string;
    inlineClose?: string;
    blockOpen?: string;
    blockClose?: string;
    inlineRenderer?: (content: string, token: Token) => string;
    blockRenderer?: (content: string, token: Token) => string;
    renderingOptions?: Record<string, unknown>;
  }

  const mathPlugin: (md: MarkdownIt, options?: MathOptions) => void;
  export = mathPlugin;
}
