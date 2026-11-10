// Edge Function "preview": reads the public title, picture and description of a gift's web page, so people can see the gift
// without leaving the site. Deploy:  npx supabase functions deploy preview --no-verify-jwt
// Safety: signed-in users only, rate limited, public http(s) addresses only (private and internal addresses are refused,
// redirects are re-checked), 6 second timeout, 400 KB read limit, and results are cached for 7 days.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { try { return new URL(s).origin; } catch { return s; } });
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

const UA = 'Mozilla/5.0 (compatible; GiftListPreview/1.0)';
const MAX_BYTES = 400_000, TIMEOUT_MS = 6000, MAX_REDIRECTS = 3, CACHE_DAYS = 7, PER_HOUR = 40;

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  return {
    'access-control-allow-origin': ORIGINS.length ? (ORIGINS.includes(o) ? o : ORIGINS[0]) : '*',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS', 'vary': 'origin',
  };
};
const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'content-type': 'application/json' } });

function privateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.includes(':')) {                                        // IPv6
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return privateIp(m[1]);
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
  }
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
async function allowed(u: URL): Promise<boolean> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password || (u.port && u.port !== '80' && u.port !== '443')) return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return false;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return !privateIp(h);
  if (!h.includes('.')) return false;
  try {
    const found = [...await Deno.resolveDns(h, 'A').catch(() => []), ...await Deno.resolveDns(h, 'AAAA').catch(() => [])];
    if (found.some(privateIp)) return false;
  } catch { /* DNS lookups unavailable here: the name checks above still apply */ }
  return true;
}

async function readLimited(r: Response): Promise<string> {
  const reader = r.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read(); if (done || !value) break;
    chunks.push(value); total += value.length;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  const all = new Uint8Array(total); let off = 0; for (const c of chunks) { all.set(c, off); off += c.length; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}
async function fetchHtml(start: URL): Promise<{ html: string; url: URL }> {
  let u = start;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (!(await allowed(u))) throw new Error('blocked');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(u, { redirect: 'manual', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'en' } });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { u = new URL(loc, u); continue; }
      if (!r.ok) throw new Error('status ' + r.status);
      if (!/text\/html|application\/xhtml/i.test(r.headers.get('content-type') ?? '')) throw new Error('not a web page');
      return { html: await readLimited(r), url: u };
    } finally { clearTimeout(timer); }
  }
  throw new Error('too many redirects');
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
const clean = (s: string | undefined, max: number) => (s ? decode(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;

const toPrice = (s?: string) => {
  if (!s) return null; const m = decode(s).replace(/,/g, '').match(/(\d{1,6}(?:\.\d{1,2})?)/); if (!m) return null;
  const n = Number(m[1]); return n > 0 && n < 1e6 ? n : null;
};
function findPrice(meta: Record<string, string>, head: string): number | null {      // best effort: many shops do not publish a price
  for (const k of ['product:price:amount', 'og:price:amount', 'product:sale_price:amount']) { const n = toPrice(meta[k]); if (n !== null) return n; }
  const a = head.match(/"@type"\s*:\s*"(?:Aggregate)?Offer"[^{}]{0,400}?"(?:low)?[pP]rice"\s*:\s*"?([0-9][0-9.,]*)/);
  if (a) { const n = toPrice(a[1]); if (n !== null) return n; }
  const b = head.match(/"price"\s*:\s*"?([0-9][0-9.,]*)"?\s*,\s*"priceCurrency"/);
  return b ? toPrice(b[1]) : null;
}

function parse(html: string, base: URL) {
  const head = html.slice(0, 300_000), meta: Record<string, string> = {};
  for (const tag of head.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
    const key = (attrs['property'] ?? attrs['name'] ?? '').toLowerCase();
    if (key && attrs['content'] !== undefined && !(key in meta)) meta[key] = attrs['content'];
  }
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  let image: string | null = null;
  const rawImg = meta['og:image:secure_url'] ?? meta['og:image'] ?? meta['twitter:image'] ?? meta['twitter:image:src'];
  if (rawImg) { try { const iu = new URL(decode(rawImg), base); if (iu.protocol === 'https:' && iu.href.length <= 500) image = iu.href; } catch { /* ignore */ } }
  return {
    title: clean(meta['og:title'] ?? meta['twitter:title'] ?? titleTag, 200),
    description: clean(meta['og:description'] ?? meta['twitter:description'] ?? meta['description'], 400),
    image, site: clean(meta['og:site_name'], 80) ?? base.hostname.replace(/^www\./, ''), price: findPrice(meta, head),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return reply(req, { error: 'Not found' }, 404);
  try {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
    const { data: au, error: ae } = token ? await admin.auth.getUser(token) : { data: { user: null }, error: new Error('no token') };
    if (ae || !au.user) return reply(req, { error: 'Please log in again.' }, 401);

    const body = await req.json(); let u: URL;
    try { u = new URL(String(body.url ?? '').trim()); } catch { return reply(req, { ok: false }); }
    u.hash = ''; const key = u.href;
    if (key.length > 1000) return reply(req, { ok: false });

    const cached = await admin.from('link_previews').select('title,description,image,site,price,fetched_at').eq('url', key).maybeSingle();
    if (cached.data && Date.now() - new Date(cached.data.fetched_at).getTime() < CACHE_DAYS * 86400000) {
      const { title, description, image, site, price } = cached.data; return reply(req, { ok: true, title, description, image, site, price: price === null ? null : Number(price) });
    }
    const rk = 'preview:' + au.user.id;
    const hits = Number((await admin.rpc('service_rate_hits', { p_key: rk, p_seconds: 3600 })).data ?? 0);
    if (hits >= PER_HOUR) return reply(req, { ok: false, error: 'Too many previews. Please try again later.' }, 429);
    await admin.rpc('service_rate_record', { p_key: rk });

    let page; try { page = await fetchHtml(u); } catch { return reply(req, { ok: false }); }
    const p = parse(page.html, page.url);
    if (!p.title && !p.description && !p.image && p.price === null) return reply(req, { ok: false });
    await admin.from('link_previews').upsert({ url: key, ...p, fetched_at: new Date().toISOString() });
    return reply(req, { ok: true, ...p });
  } catch (e) {
    console.error('preview error', e instanceof Error ? e.message : e);
    return reply(req, { ok: false }, 500);
  }
});
