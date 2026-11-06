// Security and behaviour tests. Run ONLY against a throwaway DEV Supabase project, never production:
//   DEV_PROJECT_CONFIRM=yes SUPABASE_URL=... SUPABASE_PUBLISHABLE_KEY=... npm test
// Needs the "account" Edge Function deployed on that project (and SIGNUP_CODE set in your shell if you set one there).
// No secret key is needed: everything runs as real users created through the real sign-up flow, then deleted.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: PUB, SIGNUP_CODE = '', DEV_PROJECT_CONFIRM } = process.env;
if (DEV_PROJECT_CONFIRM !== 'yes' || !URL || !PUB) { console.error('Refusing to run: set DEV_PROJECT_CONFIRM=yes, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for a DEV project.'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + name); };
const anon = () => createClient(URL, PUB, { auth: { persistSession: false } });
const run = randomUUID().slice(0, 8), pw = 'Test-' + randomUUID();
const users = {};
const FN = `${URL}/functions/v1/account`;
const call = async (body, token) => {
  const r = await fetch(FN, { method: 'POST', headers: { 'content-type': 'application/json', apikey: PUB, authorization: 'Bearer ' + (token || PUB) }, body: JSON.stringify(body) });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
};
const Q = 'What was the name of my first pet?';
async function mk(label) {
  const name = `${label}${run}`;
  const r = await call({ action: 'signup', username: name, password: pw, question: Q, answer: 'Rex', signupCode: SIGNUP_CODE });
  if (!r.session) throw new Error('sign-up failed: ' + (r.error || r.status));
  const c = anon(); const s = await c.auth.setSession(r.session); if (s.error) throw s.error;
  const p = await c.rpc('my_profile'); if (p.error || !p.data?.length) throw new Error('profile ' + label);
  users[label] = { c, id: p.data[0].id, name };
  return users[label];
}
const rows = r => (r.data || []).length;

try {
  // --- anonymous visitors see nothing -------------------------------------------------------------------------------------
  const a0 = anon();
  for (const t of ['profiles', 'gifts', 'purchases', 'groups', 'group_members', 'rate_events']) {
    const r = await a0.from(t).select('*'); ok(r.error || rows(r) === 0, `anonymous cannot read ${t}`);
  }
  ok((await a0.rpc('create_group', { p_name: 'x' })).error, 'anonymous cannot call create_group');

  const alice = await mk('alice'), bob = await mk('bob'), carol = await mk('carol');

  // --- sign-in, recovery and deletion (username only, no email) -----------------------------------------------------------
  const bad1 = await call({ action: 'login', username: alice.name, password: 'wrong-password-123' });
  const bad2 = await call({ action: 'login', username: 'nobody' + run, password: 'wrong-password-123' });
  ok(bad1.status === 401 && bad1.error === bad2.error, 'wrong password and unknown user give the same error');
  ok(!!(await call({ action: 'login', username: alice.name, password: pw })).session, 'login with username and password works');
  const qReal = await call({ action: 'question', username: alice.name }), qFake = await call({ action: 'question', username: 'nobody' + run });
  ok(qReal.question === Q && typeof qFake.question === 'string' && qFake.status === 200, 'unknown usernames get a decoy question, not an error');
  ok((await call({ action: 'reset', username: alice.name, answer: 'wrong answer', newPassword: 'Another-pass-1' })).error, 'a wrong recovery answer is refused');
  ok((await alice.c.from('profiles').select('recovery_hash')).error, 'recovery hash is not readable');
  ok((await anon().rpc('service_get_question', { p_username: alice.name })).error, 'service functions are not callable by browsers');
  const dave = await mk('dave');
  ok((await call({ action: 'reset', username: dave.name, answer: '  REX ', newPassword: 'Brand-new-pass-1' })).ok === true, 'the right answer (any capitals) resets the password');
  ok(!!(await call({ action: 'login', username: dave.name, password: 'Brand-new-pass-1' })).session, 'login works with the new password');
  const dTok = (await dave.c.auth.getSession()).data.session?.access_token;
  ok((await call({ action: 'deleteAccount', password: 'not-my-password' }, dTok)).status === 403, 'deleting an account needs the current password');
  ok((await call({ action: 'deleteAccount', password: 'Brand-new-pass-1' }, dTok)).ok === true, 'an account can be deleted');
  ok(!(await call({ action: 'login', username: dave.name, password: 'Brand-new-pass-1' })).session, 'a deleted account cannot log in');
  delete users.dave;

  // --- optional recovery question, priority, birthday ----------------------------------------------------------------
  const noQ = await call({ action: 'signup', username: 'erin' + run, password: pw, signupCode: SIGNUP_CODE });
  ok(!!noQ.session, 'sign-up works without a recovery question');
  const eTok = noQ.session?.access_token;
  ok(typeof (await call({ action: 'question', username: 'erin' + run })).question === 'string', 'a person with no question looks the same as everyone else');
  if (eTok) await call({ action: 'deleteAccount', password: pw }, eTok);
  ok((await alice.c.rpc('set_birthday', { p_month: 2, p_day: 30 })).error, 'an impossible birthday is refused');
  ok(!(await alice.c.rpc('set_birthday', { p_month: 12, p_day: 25 })).error, 'a valid birthday is saved');
  ok((await alice.c.from('gifts').insert({ owner_id: alice.id, name: 'Bad priority', priority: 4 })).error, 'a priority outside 1 to 3 is refused');
  ok((await alice.c.rpc('set_avatar_url', { p_url: 'http://example.com/me.jpg' })).error, 'a picture link must be https');
  ok((await alice.c.rpc('set_avatar_url', { p_url: 'javascript:alert(1)' })).error, 'a script link is refused as a picture');
  ok(!(await alice.c.rpc('set_avatar_url', { p_url: 'https://example.com/me.jpg' })).error, 'an https picture link is saved');
  ok((await alice.c.from('profiles').select('avatar_url').eq('id', alice.id).single()).data?.avatar_url === 'https://example.com/me.jpg', 'the picture link can be read back');

  // --- groups ------------------------------------------------------------------------------------------------------------------
  const g = await alice.c.rpc('create_group', { p_name: 'Family' }); ok(!g.error && g.data, 'alice creates a group');
  const code = (await alice.c.from('groups').select('invite_code').eq('id', g.data).single()).data.invite_code;
  ok(!(await bob.c.rpc('join_group', { p_code: code })).error, 'bob joins with the code');
  ok((await carol.c.rpc('join_group', { p_code: 'ZZZZZZZZ' })).data === null, 'wrong code returns nothing');
  ok(rows(await carol.c.from('groups').select('*')) === 0, 'non-member cannot see the group');
  ok((await bob.c.from('group_members').insert({ group_id: g.data, profile_id: carol.id })).error, 'bob cannot add carol directly');
  ok((await bob.c.from('groups').update({ name: 'Hacked' }).eq('id', g.data).select()).data?.length !== 1, 'bob cannot rename the group');
  ok((await bob.c.rpc('remove_member', { p_group: g.data, p_profile: alice.id })).error, 'a member cannot remove the owner');
  let blocked = 0; for (let i = 0; i < 14; i++) { const r = await carol.c.rpc('join_group', { p_code: 'AAAAAAAA' }); if (r.error) blocked++; }
  ok(blocked > 0, 'guessing invite codes is throttled');

  // --- gifts and ownership -----------------------------------------------------------------------------------------------
  const gid = randomUUID();
  ok(!(await alice.c.from('gifts').insert({ id: gid, owner_id: alice.id, name: 'Board game', price: 40 })).error, 'alice adds a gift');
  ok((await alice.c.from('gifts').insert({ id: gid, owner_id: alice.id, name: 'Board game' })).error?.code === '23505', 'a retried insert does not duplicate');
  ok(rows(await bob.c.from('gifts').select('*').eq('id', gid)) === 1, 'bob (same group) sees alice\'s gift');
  ok(rows(await carol.c.from('gifts').select('*').eq('id', gid)) === 0, 'carol (no shared group) does not');
  ok((await bob.c.from('gifts').update({ name: 'x' }).eq('id', gid).select()).data?.length !== 1, 'bob cannot edit alice\'s gift');
  ok((await bob.c.from('gifts').delete().eq('id', gid).select()).data?.length !== 1, 'bob cannot delete alice\'s gift');
  ok((await bob.c.from('gifts').insert({ owner_id: carol.id, name: 'Sneaky' })).error, 'bob cannot add a gift to a non-group-mate');
  ok((await alice.c.from('gifts').update({ owner_id: bob.id }).eq('id', gid)).error, 'ownership cannot be changed');
  const forged = randomUUID();
  await bob.c.from('gifts').insert({ id: forged, owner_id: alice.id, created_by: alice.id, name: 'Forged as alice' });
  ok(rows(await alice.c.from('gifts').select('*').eq('id', forged)) === 0, 'created_by cannot be forged to dodge the surprise rule');
  ok((await alice.c.from('profiles').select('username')).error, 'other people\'s full names cannot be read');
  ok(rows(await alice.c.from('profiles').select('first_name,last_initial')) >= 1, 'first names are readable');

  // --- purchases and surprise gifts ------------------------------------------------------------------------------------------
  ok(!(await bob.c.from('purchases').insert({ gift_id: gid, bought_by: bob.id })).error, 'bob marks the gift bought');
  ok(rows(await alice.c.from('purchases').select('*')) === 0, 'alice cannot see purchase marks on her list');
  ok((await alice.c.from('purchases').insert({ gift_id: gid, bought_by: alice.id })).error, 'alice cannot mark her own gift');
  ok((await bob.c.from('purchases').insert({ gift_id: gid, bought_by: carol.id })).error, 'bought_by cannot be someone else');
  ok(rows(await carol.c.from('purchases').select('*')) === 0, 'carol cannot see purchases');
  const sid = randomUUID();
  ok(!(await bob.c.from('gifts').insert({ id: sid, owner_id: alice.id, name: 'Surprise scarf' })).error, 'bob adds a surprise gift for alice');
  ok(rows(await alice.c.from('gifts').select('*').eq('id', sid)) === 0, 'alice cannot see the surprise gift (direct query by id)');
  ok(!(await alice.c.from('gifts').select('name')).data.some(x => x.name === 'Surprise scarf'), 'surprise gift is absent from alice\'s list');
  ok((await alice.c.from('gifts').delete().eq('id', sid).select()).data?.length !== 1, 'alice cannot delete the surprise gift');
  const bobView = await bob.c.from('purchases').select('gift_id').eq('gift_id', sid); ok(rows(bobView) === 1, 'the surprise gift shows as bought to others');
  ok((await bob.c.from('purchases').delete().eq('gift_id', sid).select()).data?.length !== 1, 'a surprise gift cannot be un-bought');
  const upd = await bob.c.from('gifts').update({ name: 'Blue scarf' }).eq('id', sid).select(); ok(upd.data?.length === 1, 'bob can edit his own surprise gift');

  // --- concurrency ------------------------------------------------------------------------------------------------------------------
  const cur = (await alice.c.from('gifts').select('updated_at').eq('id', gid).single()).data.updated_at;
  await alice.c.from('gifts').update({ notes: 'first' }).eq('id', gid);
  const stale = await alice.c.from('gifts').update({ notes: 'stale' }).eq('id', gid).eq('updated_at', cur).select('id');
  ok(!stale.error && stale.data.length === 0, 'a stale edit is rejected instead of overwriting');

  // --- Secret Santa and budget ------------------------------------------------------------------------------------------------
  const fay = await mk('fay'); await fay.c.rpc('join_group', { p_code: code });
  const sid2 = (await alice.c.rpc('create_santa', { p_group: g.data, p_name: 'Test Santa', p_budget: 25, p_draws: 2 })).data;
  ok(!!sid2, 'alice creates a Secret Santa (limit 25, two names each)');
  ok(!(await bob.c.rpc('join_santa', { p_santa: sid2 })).error && !(await fay.c.rpc('join_santa', { p_santa: sid2 })).error, 'bob and fay join it');
  ok((await carol.c.rpc('join_santa', { p_santa: sid2 })).error, 'someone outside the group cannot join');
  ok((await bob.c.rpc('draw_santa', { p_santa: sid2 })).error, 'only the organizer can draw the names');
  ok(!(await alice.c.rpc('draw_santa', { p_santa: sid2 })).error, 'the draw works');
  const got = {};
  for (const [n, u] of [['alice', alice], ['bob', bob], ['fay', fay]]) got[n] = (await u.c.from('santa_assignments').select('receiver_id').eq('santa_id', sid2)).data || [];
  ok(Object.values(got).every((a) => a.length === 2 && new Set(a.map((x) => x.receiver_id)).size === 2), 'everyone drew two different names');
  ok(!got.alice.some((x) => x.receiver_id === alice.id) && !got.bob.some((x) => x.receiver_id === bob.id) && !got.fay.some((x) => x.receiver_id === fay.id), 'nobody drew themselves');
  const tally = {}; Object.values(got).flat().forEach((x) => { tally[x.receiver_id] = (tally[x.receiver_id] || 0) + 1; });
  ok(Object.keys(tally).length === 3 && Object.values(tally).every((n) => n === 2), 'everyone was drawn exactly twice');
  ok(rows(await carol.c.from('santa_assignments').select('*')) === 0, 'an outsider sees no assignments');
  ok((await alice.c.rpc('draw_santa', { p_santa: sid2 })).error, 'the names cannot be drawn twice');
  ok((await alice.c.from('santa_assignments').insert({ santa_id: sid2, giver_id: alice.id, receiver_id: bob.id })).error, 'assignments cannot be written directly');
  ok((await bob.c.rpc('reset_santa', { p_santa: sid2 })).error, 'only the organizer can redo the draw');
  ok((await alice.c.from('budget_entries').insert({ label: 'Too much', kind: 'reserved', amount: 30, santa_id: sid2 })).error, 'a Secret Santa entry over the limit is refused');
  ok(!(await alice.c.from('budget_entries').insert({ label: 'Within the limit', kind: 'reserved', amount: 20, santa_id: sid2 })).error, 'an entry within the limit is saved');
  ok(rows(await bob.c.from('budget_entries').select('*')) === 0, 'other people cannot see your budget entries');
  ok(!(await alice.c.rpc('set_budget_total', { p_total: 100 })).error, 'a budget total is saved');
  ok(rows(await bob.c.from('budgets').select('*')) === 0, 'other people cannot see your budget total');

  // --- username change and leaving a group ----------------------------------------------------------------------------------
  ok(!(await alice.c.rpc('change_username', { p_username: `alicia${run}` })).error, 'username changes');
  ok(rows(await alice.c.from('gifts').select('*').eq('id', gid)) === 1, 'gifts stay with the renamed user');
  ok(!(await bob.c.rpc('leave_group', { p_group: g.data })).error, 'bob leaves the group');
  ok(rows(await bob.c.from('gifts').select('*').eq('id', gid)) === 0, 'after leaving, bob can no longer see alice\'s gifts');

  // --- secrets ------------------------------------------------------------------------------------------------------------------------
  const web = ['index.html', 'config.js'].map(f => readFileSync(f, 'utf8')).join('\n');
  ok(!/service_role|sb_secret_/.test(web), 'no secret key text in index.html or config.js');
} catch (e) { fail++; console.error('ERROR', e.message); }
finally {
  for (const u of Object.values(users)) { const t = (await u.c.auth.getSession()).data.session?.access_token; if (t) await call({ action: 'deleteAccount', password: pw }, t); }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
}
