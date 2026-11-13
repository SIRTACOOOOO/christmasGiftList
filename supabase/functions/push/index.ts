// Edge Function "push": sends phone / computer notifications.
// Two callers:
//   1. The DATABASE (pg_net), with a shared secret in "x-push-secret". The database has already worked out who gets which
//      message, so this function does no database lookups: it only encrypts and sends, all devices at the same time.
//   2. A signed-in person pressing "Send a test notification" in Settings (action "test"), which also reports what is wrong.
// Deploy:  npx supabase functions deploy push --no-verify-jwt
// Secrets: npx supabase secrets set PUSH_SECRET=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// No libraries: the Web Push maths lives in webpush.ts (checked against the official RFC 8291 test vector), so the function
// starts fast. Messages are sent with Urgency "high" so a sleeping Android phone is woken right away.
import { sendPush, type Sub } from './webpush.ts';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('PUSH_SECRET') ?? '';
const VAPID = { pub: Deno.env.get('VAPID_PUBLIC_KEY') ?? '', priv: Deno.env.get('VAPID_PRIVATE_KEY') ?? '', subject: Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com' };
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { try { return new URL(s).origin; } catch { return s; } });

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? '';
  return {
    'access-control-allow-origin': ORIGINS.length ? (ORIGINS.includes(o) ? o : ORIGINS[0]) : '*',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS', 'vary': 'origin',
  };
};
const json = (req: Request, b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors(req), 'content-type': 'application/json' } });
const same = (a: string, b: string) => { if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, ...(init.headers ?? {}) } });
const forget = (endpoint: string) => rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: 'DELETE' }).catch(() => {});   // a phone that unsubscribed

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return json(req, { error: 'Not found' }, 404);
  try {
    const secret = req.headers.get('x-push-secret');
    if (secret !== null) {                                                           // ---- 1. from the database ----
      if (!same(secret, SECRET)) return json(req, { error: 'No' }, 401);
      if (!VAPID.pub || !VAPID.priv) { console.error('VAPID keys are not set'); return json(req, { error: 'VAPID keys are not set' }, 500); }
      const b = await req.json();
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 200) as (Sub & { title: string; body: string })[];
      let sent = 0, failed = 0;
      await Promise.all(items.map(async (it) => {
        try {
          const icon = typeof b.icon === 'string' && /^https:\/\//.test(b.icon) && b.icon.length <= 500 ? b.icon : undefined;      // the sender's profile picture
          const r = await sendPush(it, { title: it.title, body: it.body, group: b.group, tag: b.tag, icon }, VAPID);
          if (r.status < 300) sent++;
          else if (r.status === 404 || r.status === 410) await forget(it.endpoint);
          else { failed++; console.error('push rejected', r.status, new URL(it.endpoint).host, r.text); }
        } catch (e) { failed++; console.error('push error', new URL(it.endpoint).host, e instanceof Error ? e.message : e); }
      }));
      return json(req, { ok: true, sent, failed });
    }

    // ---- 2. a signed-in person testing their own device ----
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const u = token ? await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SERVICE, authorization: `Bearer ${token}` } }) : null;
    if (!u || !u.ok) return json(req, { error: 'Please sign in again.' }, 401);
    const uid = (await u.json()).id as string;
    const body = await req.json().catch(() => ({}));
    const prof = await (await rest(`profiles?auth_user_id=eq.${uid}&select=id`)).json();
    const pid = prof?.[0]?.id as string | undefined;
    const subs: Sub[] = pid ? await (await rest(`push_subscriptions?profile_id=eq.${pid}&select=endpoint,p256dh,auth&limit=10`)).json() : [];
    const report: Record<string, unknown> = {
      ok: true, vapid_configured: !!(VAPID.pub && VAPID.priv), push_secret_set: !!SECRET,
      vapid_matches_app: typeof body.vapid_public === 'string' && body.vapid_public ? body.vapid_public === VAPID.pub : null,
      devices: subs.length, results: [] as unknown[],
    };
    if (VAPID.pub && VAPID.priv) {
      report.results = await Promise.all(subs.map(async (s) => {
        const host = new URL(s.endpoint).host, t0 = Date.now();
        try {
          const r = await sendPush(s, { title: 'Gift List', body: 'Test notification. If you can read this, notifications work.', tag: 'test', force: true }, VAPID, 120);
          if (r.status === 404 || r.status === 410) await forget(s.endpoint);
          return { host, status: r.status, ms: Date.now() - t0, text: r.text };
        } catch (e) { return { host, status: 0, ms: Date.now() - t0, text: e instanceof Error ? e.message : String(e) }; }
      }));
    }
    return json(req, report);
  } catch (e) {
    console.error('push error', e instanceof Error ? e.message : e);
    return json(req, { ok: false }, 500);
  }
});
