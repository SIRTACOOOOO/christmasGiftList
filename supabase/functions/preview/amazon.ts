// Amazon (and its short links a.co, amzn.to, ...). Amazon pages are not like other shops: they have no og: tags, and Amazon often
// shows a "robot check" page to web servers. So this file (1) reads Amazon's own page layout when we are let in, and (2) when we are not,
// still builds a useful preview from the link alone: the product name from the address, the picture from the product number (ASIN).
// Pure functions only, so they can be tested without the internet (see tests/amazon.test.mjs).

const SHORT_HOSTS = ['a.co', 'amzn.to', 'amzn.com', 'amzn.eu', 'amzn.asia', 'amzn.in'];
export const isAmazonHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return SHORT_HOSTS.includes(h) || /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h);
};
export const isAmazonStore = (host: string): boolean => /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host.toLowerCase());

/** The 10-character product number, from /dp/B0..., /gp/product/..., /gp/aw/d/... and the like. */
export function asinFrom(u: URL): string | null {
  if (!isAmazonStore(u.hostname)) return null;
  const m = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|gp\/offer-listing|exec\/obidos\/ASIN|product|d)\/([A-Za-z0-9]{10})(?:[/?#]|$)/);
  return m ? m[1].toUpperCase() : null;
}

const SLUG_STOP = new Set(['dp', 'gp', 'product', 'd', 'exec', 'obidos', 'aw', 'offer-listing', 'ASIN', 's', 'stores', 'b', 'hz', 'ap', 'cart', 'wishlist', 'ref']);
/** Amazon addresses usually read /Product-Name-Here/dp/ASIN: turn that into a name. */
export function titleFromSlug(u: URL): string | null {
  const parts = u.pathname.split('/').filter(Boolean); const i = parts.findIndex((p) => /^(dp|gp|d)$/i.test(p));
  const slug = i > 0 ? parts[i - 1] : '';
  if (!slug || SLUG_STOP.has(slug.toLowerCase())) return null;
  let t = ''; try { t = decodeURIComponent(slug); } catch { t = slug; }
  t = t.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= 6 && /[a-z]/i.test(t) ? t.slice(0, 200) : null;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
const tidy = (s: string | undefined | null, max: number) => (s ? decode(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;

/** True for the "prove you are not a robot" page (or an Amazon error page) instead of a product page. */
export const looksBlocked = (html: string): boolean =>
  /Type the characters you see in this image|Enter the characters you see below|validateCaptcha|automated access to Amazon data|api-services-support@amazon\.com|<title>\s*(Robot Check|Sorry! Something went wrong|Page Not Found)/i.test(html.slice(0, 200_000));

const httpsUrl = (raw: string | undefined | null, base: URL): string | null => {
  if (!raw) return null; try { const u = new URL(decode(raw).trim(), base); return u.protocol === 'https:' && u.href.length <= 500 ? u.href : null; } catch { return null; }
};
const toPrice = (s?: string | null) => {
  if (!s) return null; const m = decode(s).replace(/,/g, '').match(/(\d{1,6}(?:\.\d{1,2})?)/); if (!m) return null;
  const n = Number(m[1]); return n > 0 && n < 1e6 ? n : null;
};

export type Preview = { title: string | null; description: string | null; image: string | null; site: string | null; price: number | null };

/** Reads a real Amazon product page. */
export function parseAmazon(html: string, base: URL): Preview {
  const h = html.slice(0, 600_000);
  let title = tidy(h.match(/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/i)?.[1], 200);
  if (!title) {      // "Amazon.com: Product name : Category"
    const t = tidy(h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1], 300);
    if (t) title = t.replace(/^Amazon\.[a-z.]+\s*:\s*/i, '').replace(/\s+:\s+[^:]{2,40}$/, '').slice(0, 200) || null;
  }
  if (title && /^(amazon(\.[a-z.]+)?|robot check)$/i.test(title)) title = null;

  let image = httpsUrl(h.match(/data-old-hires="(https:[^"]+)"/i)?.[1], base)
    ?? httpsUrl(h.match(/"hiRes"\s*:\s*"(https:[^"]+)"/i)?.[1], base);
  if (!image) {
    const dyn = h.match(/data-a-dynamic-image="([^"]+)"/i)?.[1];
    if (dyn) { try { const first = Object.keys(JSON.parse(decode(dyn)))[0]; image = httpsUrl(first, base); } catch { /* ignore */ } }
  }
  image ??= httpsUrl(h.match(/<img[^>]*id="landingImage"[^>]*\ssrc="(https:[^"]+)"/i)?.[1], base)
    ?? httpsUrl(h.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1], base);

  const at = h.search(/apexPriceToPay|priceToPay|corePrice_(?:desktop|feature)_div|corePriceDisplay/), from = at < 0 ? 0 : Math.max(0, h.lastIndexOf('<', at));      // start of the tag that holds the price
  const price = toPrice(h.slice(from).match(/class="a-price[^"]*"[^>]*>\s*<span[^>]*class="a-offscreen"[^>]*>([^<]+)<\/span>/i)?.[1])
    ?? toPrice(h.slice(from).match(/"priceAmount"\s*:\s*"?([0-9][0-9.,]*)/)?.[1]);

  const desc = tidy(h.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/i)?.[1], 400);
  return { title, description: desc && !/^Amazon\.[a-z.]+\s*$/i.test(desc) ? desc : null, image, site: 'Amazon', price };
}

/** Amazon's old picture-by-product-number address. Returns the address, or null when Amazon has no picture for it. */
export async function asinImage(asin: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const url = `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
  try {
    const r = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    const type = r.headers.get('content-type') ?? ''; const buf = new Uint8Array(await r.arrayBuffer());
    return r.ok && /^image\/(jpeg|png|webp)/i.test(type) && buf.length > 2500 ? url : null;      // missing pictures come back as a tiny placeholder
  } catch { return null; }
}

/** Builds the preview: the real page if we were let in, otherwise what the link itself tells us. `partial` = built from the link only. */
export async function amazonPreview(page: { html: string; url: URL; ok: boolean } | null, original: URL, fetcher: typeof fetch = fetch): Promise<{ preview: Preview; partial: boolean } | null> {
  const final = page?.url ?? original;
  let p: Preview = { title: null, description: null, image: null, site: 'Amazon', price: null }, partial = false;
  if (page && page.ok && !looksBlocked(page.html)) p = parseAmazon(page.html, page.url);
  if (p.title && p.image) return { preview: p, partial: false };
  const asin = asinFrom(final) ?? asinFrom(original);
  if (!p.title) { p.title = titleFromSlug(final) ?? titleFromSlug(original); partial = true; }
  if (!p.image && asin) { p.image = await asinImage(asin, fetcher); partial = true; }
  return p.title || p.image || p.price !== null ? { preview: p, partial } : null;
}
