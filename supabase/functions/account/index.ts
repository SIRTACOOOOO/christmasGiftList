// Edge Function "account": sign-in with a full name + password (no email), recovery question, and account deletion.
// Deploy:  supabase functions deploy account --no-verify-jwt
// Secrets: supabase secrets set ALLOWED_ORIGINS=https://yourname.github.io  [SIGNUP_CODE=...]  [SIGNUP_LIMIT_PER_HOUR=5]
// The service role key exists only here, inside Supabase. It is never sent to the browser.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SIGNUP_CODE = Deno.env.get('SIGNUP_CODE') ?? '';
const SIGNUP_LIMIT = Number(Deno.env.get('SIGNUP_LIMIT_PER_HOUR') ?? '5');
const EMAIL_DOMAIN = Deno.env.get('EMAIL_DOMAIN') ?? 'users.giftlist.invalid';   // never receives mail; Supabase just needs an address
// Accepts full addresses too (path and trailing slash are ignored), so https://you.github.io/site/ works like https://you.github.io
const ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  .map((s) => { try { return new URL(s).origin; } catch { return s; } });

const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = () => createClient(SB_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '.\-]{0,29}$/;
const DECOYS = ['What was the name of your first pet?', 'What street did you grow up on?', 'What was your first car?',
  'What is your favourite childhood book?', 'What was the name of your first school?'];

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
const fail = (req: Request, msg: string, status = 400) => reply(req, { error: msg }, status);

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const hits = async (key: string, secs: number) => Number((await admin.rpc('service_rate_hits', { p_key: key, p_seconds: secs })).data ?? 0);
const record = (key: string) => admin.rpc('service_rate_record', { p_key: key });
const TOO_MANY = 'Too many attempts. Please wait a while and try again.';

async function signIn(email: string, password: string) {
  const r = await anonClient().auth.signInWithPassword({ email, password });
  return r.error || !r.data.session ? null : { access_token: r.data.session.access_token, refresh_token: r.data.session.refresh_token };
}
async function authedUser(req: Request) {
  const t = (req.headers.get('authorization') ?? '').replace(/^Bearer /i, '');
  if (!t) return null;
  const { data, error } = await admin.auth.getUser(t);
  return error || !data.user ? null : data.user;
}
// For actions that change something important, the person must prove they know the current password.
async function confirmPassword(user: { id: string; email?: string }, password: unknown) {
  const key = 'pw:' + user.id;
  if ((await hits(key, 900)) >= 10) return 'limit';
  if (typeof password === 'string' && user.email && (await signIn(user.email, password))) return 'ok';
  await record(key);
  return 'bad';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return fail(req, 'Not found', 404);
  try {
    const b = await req.json();
    const ip = await sha((req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim());
    const username = typeof b.username === 'string' ? b.username.trim() : '';

    if (b.action === 'signup') {
      if (SIGNUP_CODE && b.signupCode !== SIGNUP_CODE) return fail(req, 'That sign-up code is not right.');
      if ((await hits('signup:' + ip, 3600)) >= SIGNUP_LIMIT) return fail(req, 'Too many new accounts from this network. Please try later.', 429);
      await record('signup:' + ip);
      if (!NAME_RE.test(username)) return fail(req, "Names can use letters, numbers, spaces and - . ' (30 characters at most).");
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 72) return fail(req, 'Passwords need 8 to 72 characters.');
      const q = String(b.question ?? '').trim(), a = String(b.answer ?? '').trim();
      if (q.length < 8 || q.length > 120 || a.length < 2 || a.length > 100) return fail(req, 'Choose a recovery question (8 or more characters) and an answer.');
      const email = `${crypto.randomUUID()}@${EMAIL_DOMAIN}`;
      const created = await admin.auth.admin.createUser({ email, password: b.password, email_confirm: true });
      if (created.error || !created.data.user) { console.error('createUser', created.error?.message); return fail(req, 'Could not create the account. Please try again.', 500); }
      const p = await admin.rpc('service_create_profile', { p_auth_user_id: created.data.user.id, p_username: username, p_question: q, p_answer: a });
      if (p.error || !p.data) {
        await admin.auth.admin.deleteUser(created.data.user.id);
        return fail(req, p.error ? 'Could not create the account. Please try again.' : 'Someone already has that name. Add a middle name or initial.');
      }
      return reply(req, { session: await signIn(email, b.password) });
    }

    if (b.action === 'login') {
      const uKey = 'login-u:' + username.toLowerCase(), iKey = 'login-ip:' + ip;
      if ((await hits(uKey, 900)) >= 10 || (await hits(iKey, 900)) >= 40) return fail(req, TOO_MANY, 429);
      let session = null;
      if (NAME_RE.test(username) && typeof b.password === 'string') {
        const prof = await admin.from('profiles').select('auth_user_id').eq('username', username).maybeSingle();
        if (prof.data?.auth_user_id) {
          const u = await admin.auth.admin.getUserById(prof.data.auth_user_id);
          if (u.data.user?.email) session = await signIn(u.data.user.email, b.password);
        }
      }
      if (!session) { await record(uKey); await record(iKey); return fail(req, 'Wrong username or password.', 401); }
      return reply(req, { session });
    }

    if (b.action === 'question') {   // unknown names get a believable decoy so this cannot be used to find accounts
      if ((await hits('q-ip:' + ip, 900)) >= 30) return fail(req, TOO_MANY, 429);
      await record('q-ip:' + ip);
      const r = NAME_RE.test(username) ? await admin.rpc('service_get_question', { p_username: username }) : { data: null };
      const decoy = DECOYS[parseInt((await sha('decoy:' + username.toLowerCase())).slice(0, 4), 16) % DECOYS.length];
      return reply(req, { question: r.data || decoy });
    }

    if (b.action === 'reset') {
      const uKey = 'reset-u:' + username.toLowerCase(), iKey = 'reset-ip:' + ip;
      if ((await hits(uKey, 900)) >= 5 || (await hits(iKey, 900)) >= 20) return fail(req, TOO_MANY, 429);
      if (typeof b.newPassword !== 'string' || b.newPassword.length < 8 || b.newPassword.length > 72) return fail(req, 'Passwords need 8 to 72 characters.');
      const uid = NAME_RE.test(username) ? (await admin.rpc('service_check_answer', { p_username: username, p_answer: String(b.answer ?? '') })).data : null;
      if (!uid) { await record(uKey); await record(iKey); return fail(req, 'That answer is not right.'); }
      const up = await admin.auth.admin.updateUserById(uid, { password: b.newPassword });
      if (up.error) { console.error('updateUser', up.error.message); return fail(req, 'Could not change the password. Please try again.', 500); }
      return reply(req, { ok: true });
    }

    // The rest need a signed-in user AND their current password.
    const user = await authedUser(req);
    if (!user) return fail(req, 'Please log in again.', 401);
    if (b.action === 'setQuestion' || b.action === 'deleteAccount') {
      const c = await confirmPassword(user, b.password);
      if (c === 'limit') return fail(req, TOO_MANY, 429);
      if (c === 'bad') return fail(req, 'Current password is wrong.', 403);
      if (b.action === 'setQuestion') {
        const q = String(b.question ?? '').trim(), a = String(b.answer ?? '').trim();
        if (q.length < 8 || q.length > 120 || a.length < 2 || a.length > 100) return fail(req, 'Choose a recovery question (8 or more characters) and an answer.');
        const r = await admin.rpc('service_set_recovery', { p_auth_user_id: user.id, p_question: q, p_answer: a });
        if (r.error) return fail(req, 'Could not save the question.', 500);
        return reply(req, { ok: true });
      }
      const d = await admin.auth.admin.deleteUser(user.id);   // cascades to the profile, list, gifts and memberships
      if (d.error) { console.error('deleteUser', d.error.message); return fail(req, 'Could not delete the account.', 500); }
      return reply(req, { ok: true });
    }
    return fail(req, 'Unknown request.', 404);
  } catch (e) {
    console.error('account function error', e instanceof Error ? e.message : e);
    return fail(req, 'Something went wrong. Please try again.', 500);
  }
});
