// Edge Function "push": sends phone / computer notifications for new group chat messages.
// It is called ONLY by the database (see 0010 migration), with a shared secret in the "x-push-secret" header.
// Deploy:  npx supabase functions deploy push --no-verify-jwt
// Secrets: npx supabase secrets set PUSH_SECRET=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
// Who is notified: everyone else in the group, a little differently if they were @mentioned or replied to.
// Notifications never include gift information, so surprise gifts stay secret.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SECRET = Deno.env.get('PUSH_SECRET') ?? '';
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY') ?? '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
const SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com';
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const same = (a: string, b: string) => { if (a.length !== b.length || !a) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const snip = (s: string | null, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '\u2026' : t; };

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
  if (!SECRET || !same(req.headers.get('x-push-secret') ?? '', SECRET)) return json({ error: 'No' }, 401);
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return json({ error: 'VAPID keys are not set' }, 500);
  try {
    const { message_id } = await req.json();
    const { data: m } = await admin.from('chat_messages')
      .select('id,group_id,sender_id,kind,anonymous,event,body,mentions,reply_to').eq('id', message_id).maybeSingle();
    if (!m) return json({ ok: true, sent: 0 });
    const [{ data: g }, { data: members }] = await Promise.all([
      admin.from('groups').select('name').eq('id', m.group_id).maybeSingle(),
      admin.from('group_members').select('profile_id').eq('group_id', m.group_id),
    ]);
    const groupName = g?.name ?? 'Group chat';
    let recipients = (members ?? []).map((x) => x.profile_id as string);

    let sender = 'Someone', replyTo: string | null = null;
    if (m.kind === 'user') {
      const { data: au } = await admin.from('chat_authors').select('author_id').eq('message_id', m.id).maybeSingle();
      if (au) recipients = recipients.filter((id) => id !== au.author_id);          // never notify the writer
      if (!m.anonymous && m.sender_id) {
        const { data: p } = await admin.from('profiles').select('first_name').eq('id', m.sender_id).maybeSingle();
        sender = p?.first_name ?? 'Someone';
      } else sender = 'Anonymous';
      if (m.reply_to) {
        const { data: ra } = await admin.from('chat_authors').select('author_id').eq('message_id', m.reply_to).maybeSingle();
        replyTo = ra?.author_id ?? null;
      }
    }
    if (!recipients.length) return json({ ok: true, sent: 0 });

    const { data: subs } = await admin.from('push_subscriptions').select('endpoint,p256dh,auth,profile_id').in('profile_id', recipients);
    let sent = 0;
    await Promise.allSettled((subs ?? []).map(async (s) => {
      let title = groupName, body: string;
      if (m.kind === 'system') body = 'The Secret Santa names were drawn' + (m.body ? ' for \u201c' + snip(m.body, 60) + '\u201d' : '') + '. Open the app to see yours.';
      else if (s.profile_id === replyTo) { title = sender + ' replied to you in ' + groupName; body = snip(m.body, 140); }
      else if ((m.mentions ?? []).includes(s.profile_id)) { title = sender + ' mentioned you in ' + groupName; body = snip(m.body, 140); }
      else body = sender + ': ' + snip(m.body, 140);
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title, body, group: m.group_id, tag: 'chat-' + m.group_id }), { TTL: 3600 });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await admin.from('push_subscriptions').delete().eq('endpoint', s.endpoint);   // phone unsubscribed
        else console.error('push failed', code);
      }
    }));
    return json({ ok: true, sent });
  } catch (e) {
    console.error('push error', e instanceof Error ? e.message : e);
    return json({ ok: false }, 500);
  }
});
