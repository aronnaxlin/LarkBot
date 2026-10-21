import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { sharpToDataUrl, sharpToEncoded } from './shared';

const transparentPng = (width: number, height: number) => sharp({
  create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
}).png();

describe('sharpToEncoded', () => {
  it('encodes images as JPEG within the detail edge', async () => {
    const { buf, format } = await sharpToEncoded({ kind: 'image', image: transparentPng(2048, 1024), detail: 'high' });
    expect(format).toBe('jpeg');
    const meta = await sharp(buf).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(512);
  });

  it('flattens transparency onto white', async () => {
    const { buf } = await sharpToEncoded({ kind: 'image', image: transparentPng(8, 8), detail: 'low' });
    const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)].every(v => v > 245)).toBe(true);
  });

  it('labels data URLs as image/jpeg', async () => {
    const url = await sharpToDataUrl({ kind: 'image', image: transparentPng(4, 4), detail: 'low' });
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
