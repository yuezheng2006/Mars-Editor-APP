/**
 * Inline remote images in the body as data URIs, before copying or exporting.
 *
 * Pasting into the WeChat backend makes it fetch and re-host the https images
 * in the body itself, and most image hosts are fine with that — but the moment
 * one turns on hotlink protection, WeChat cannot fetch it and the paste is a
 * row of broken images, which you only discover after publishing.
 * Long-image export is stricter still: `<foreignObject>` only sees resources it
 * carries itself, so a remote image simply never paints.
 *
 * A plain browser cannot read the pixels of a cross-origin image at all; here
 * the request goes out from Rust, where the same-origin policy does not apply,
 * so the bytes come straight back and get turned into a data URI.
 * Anything that cannot be fetched is left as it was — inlining only improves
 * the odds, and one failed image should not block copying the whole piece.
 */

import { fetch } from '@tauri-apps/plugin-http';

/** One fetch per image per session */
const cache = new Map<string, string>();

/** Images already on WeChat's own CDN need nothing: pasted back, they just work */
function isWechatCdn(src: string): boolean {
  return /^https?:\/\/mmbiz\.(qpic|qlogo)\.cn\//i.test(src);
}

/** Remote images that need inlining */
function needsInline(src: string): boolean {
  return /^https?:\/\//i.test(src) && !isWechatCdn(src);
}

/**
 * Fetch one; null on failure, leaving the caller to keep the original address.
 *
 * Exported because importing a web page needs exactly this and nothing more
 * (see reader.ts): the same Referer trick, the same "is it really an image"
 * check, the same per-session cache.
 */
export async function fetchImageAsDataUrl(src: string): Promise<string | null> {
  const cached = cache.get(src);
  if (cached) return cached;
  try {
    // Send the image's own site as the Referer: most hotlink protection looks
    // at that header and nothing else
    const res = await fetch(src, {
      headers: { Referer: new URL(src).origin, 'User-Agent': 'Mozilla/5.0 (compatible; VinsEditor/1.0)' },
    });
    if (!res.ok) {
      console.warn('外链图抓取失败', src, `HTTP ${res.status}`);
      return null;
    }
    const type = (res.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) {
      console.warn('外链图抓取失败', src, `不是图片（${type || '未知类型'}）`);
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    // Build in chunks: one apply() with a few hundred thousand arguments blows the stack
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const dataUrl = `data:${type};base64,${btoa(binary)}`;
    cache.set(src, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn('外链图抓取失败', src, err);
    return null;
  }
}

export interface InlineResult {
  html: string;
  /** How many were successfully inlined */
  inlined: number;
  /** How many could not be fetched and were left alone */
  failed: number;
}

/**
 * Replace the remote images in a piece of HTML with data URIs.
 *
 * Three at a time: a body usually has only a handful of remote images, serial
 * fetching is noticeably sluggish, and going higher is impolite to the host.
 */
export async function inlineRemoteImages(
  html: string,
  onProgress?: (done: number, total: number) => void,
): Promise<InlineResult> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  const targets = [...new Set(imgs.map((img) => img.getAttribute('src') ?? '').filter(needsInline))];
  if (!targets.length) return { html, inlined: 0, failed: 0 };

  const resolved = new Map<string, string>();
  let done = 0;
  const CONCURRENCY = 3;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= targets.length) return;
      const src = targets[index];
      const dataUrl = await fetchImageAsDataUrl(src);
      if (dataUrl) resolved.set(src, dataUrl);
      onProgress?.(++done, targets.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    const dataUrl = resolved.get(src);
    if (dataUrl) img.setAttribute('src', dataUrl);
  }
  return {
    html: doc.body.innerHTML,
    inlined: resolved.size,
    failed: targets.length - resolved.size,
  };
}

/**
 * Fetch one remote image back and measure its real pixels and weight.
 *
 * This exists to check whether "what we uploaded" and "what WeChat stored" are
 * the same image — whether a soft image was compressed on our side or on
 * WeChat's is an argument nobody wins by feel, and one measurement settles it.
 */
export async function measureRemoteImage(url: string): Promise<{ w: number; h: number; bytes: number } | null> {
  const dataUrl = await fetchImageAsDataUrl(url);
  if (!dataUrl) return null;
  const bytes = Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);
  return await new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, bytes });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
