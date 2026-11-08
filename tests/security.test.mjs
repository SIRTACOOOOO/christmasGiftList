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
  const gid2 = randomUUID(); await alice.c.from('gifts').insert({ id: gid2, owner_id: alice.id, name: 'Second gift' });
  ok(!(await alice.c.rpc('reorder_gifts', { p_ids: [gid2, gid] })).error, 'a list can be put in a new order');
  const ord = (await alice.c.from('gifts').select('id,position').in('id', [gid, gid2])).data || [];
  ok(ord.find((x) => x.id === gid2)?.position === 1 && ord.find((x) => x.id === gid)?.position === 2, 'the first gift in the new order is number 1');
  ok((await bob.c.rpc('reorder_gifts', { p_ids: [gid, gid2] })).error, 'nobody can reorder someone else\'s gifts');
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
  ok(rows(await bob.c.from('secret_santas').select('*').eq('id', sid2)) === 1, 'everyone in the group can see the Secret Santa without joining');
  ok((await carol.c.rpc('set_santa_optout', { p_santa: sid2, p_out: true })).error, 'someone outside the group cannot opt in or out');
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
  ok(rows(await bob.c.from('budget_entries').select('*')) === 0, 'other people cannot see your budget entries');
  ok(!(await alice.c.rpc('set_budget_total', { p_total: 100 })).error, 'a budget total is saved');
  ok(rows(await bob.c.from('budgets').select('*')) === 0, 'other people cannot see your budget total');

  // --- blacklist ------------------------------------------------------------------------------------------------------------------
  const sid3 = (await alice.c.rpc('create_santa', { p_group: g.data, p_name: 'Blacklist test', p_budget: null, p_draws: 1 })).data;
  ok(!(await alice.c.rpc('set_santa_blacklist', { p_santa: sid3, p_receivers: [bob.id] })).error, 'alice blacklists bob');
  ok(rows(await bob.c.from('santa_blacklist').select('*')) === 0 && rows(await alice.c.from('santa_blacklist').select('*')) === 1, 'a blacklist can only be read by its owner');
  ok(!(await alice.c.rpc('draw_santa', { p_santa: sid3 })).error, 'the draw works with a blacklist');
  const aliceGives = (await alice.c.from('santa_assignments').select('receiver_id').eq('santa_id', sid3)).data || [];
  ok(aliceGives.length === 1 && aliceGives[0].receiver_id === fay.id, 'alice was not matched with bob');
  ok((await alice.c.rpc('set_santa_blacklist', { p_santa: sid3, p_receivers: [] })).error, 'a blacklist cannot be changed after the draw');

  // --- opting out, drawing fewer names ----------------------------------------------------------------------------------------
  const sid4 = (await alice.c.rpc('create_santa', { p_group: g.data, p_name: 'Opt-out test', p_budget: 20, p_draws: 1 })).data;
  ok(!(await bob.c.rpc('set_santa_optout', { p_santa: sid4, p_out: true })).error, 'bob opts out of a Secret Santa');
  ok((await bob.c.rpc('set_santa_blacklist', { p_santa: sid4, p_receivers: [alice.id] })).error, 'someone who opted out has nothing to edit');
  ok(!(await alice.c.rpc('draw_santa', { p_santa: sid4 })).error, 'the draw works without bob');
  ok(rows(await bob.c.from('santa_assignments').select('*').eq('santa_id', sid4)) === 0, 'bob has no names because he opted out');
  const a4 = (await alice.c.from('santa_assignments').select('receiver_id').eq('santa_id', sid4)).data || [];
  ok(a4.length === 1 && a4[0].receiver_id === fay.id, 'alice gives to fay, the only other person in');
  const sid5 = (await alice.c.rpc('create_santa', { p_group: g.data, p_name: 'Fewer names test', p_budget: null, p_draws: 2 })).data;
  ok(!(await bob.c.rpc('set_santa_draws', { p_santa: sid5, p_draws: 1 })).error, 'bob asks to draw fewer names');
  ok((await bob.c.rpc('set_santa_draws', { p_santa: sid5, p_draws: 3 })).error, 'nobody can ask for more than the maximum');
  ok(rows(await alice.c.from('santa_wanted').select('*').eq('santa_id', sid5)) === 1, 'the group can see who asked for fewer');
  ok((await alice.c.rpc('draw_santa', { p_santa: sid5 })).error, 'a draw that cannot be fair with only three people is refused');
  ok(rows(await alice.c.from('santa_assignments').select('*').eq('santa_id', sid5)) === 0, 'nothing is drawn when it is refused');

  // --- clearing ticks after Christmas ---------------------------------------------------------------------------------------
  const cleared = await bob.c.from('purchases').delete().eq('bought_by', bob.id).select('gift_id');
  ok((cleared.data || []).some((x) => x.gift_id === gid) && !(cleared.data || []).some((x) => x.gift_id === sid), 'clearing my ticks removes ordinary ticks but not surprise gifts');
  await bob.c.from('purchases').insert({ gift_id: gid, bought_by: bob.id });
  ok(!(await alice.c.rpc('reset_ticks_on_my_list')).error, 'the owner can reset ticks on their own list');
  ok(rows(await bob.c.from('purchases').select('*').eq('gift_id', gid)) === 0, 'resetting a list clears everyone\'s ticks');
  ok(rows(await bob.c.from('gifts').select('*').eq('id', gid)) === 1, 'the gift itself is still there');
  ok(rows(await bob.c.from('purchases').select('*').eq('gift_id', sid)) === 1, 'surprise gifts stay marked as bought');

  // --- group chat -------------------------------------------------------------------------------------------------------------------
  const sys = (await alice.c.from('chat_messages').select('event').eq('group_id', g.data).eq('kind', 'system')).data || [];
  ok(sys.some((x) => x.event === 'joined') && sys.some((x) => x.event === 'group_created'), 'creating and joining a group post notices in the chat');
  const m1 = (await alice.c.rpc('post_chat', { p_group: g.data, p_body: 'Hello @bob', p_anon: false, p_mentions: [bob.id, carol.id] })).data;
  ok(!!m1, 'alice posts a chat message');
  const seen = (await bob.c.from('chat_messages').select('sender_id,mentions').eq('id', m1).single()).data;
  ok(seen && seen.sender_id === alice.id && seen.mentions.length === 1 && seen.mentions[0] === bob.id, 'bob sees it, and only real group members count as mentioned');
  ok(rows(await carol.c.from('chat_messages').select('*').eq('group_id', g.data)) === 0, 'someone outside the group sees no chat');
  const m2 = (await bob.c.rpc('post_chat', { p_group: g.data, p_body: 'psst', p_anon: true, p_mentions: [] })).data;
  const anon = (await alice.c.from('chat_messages').select('sender_id,anonymous').eq('id', m2).single()).data;
  ok(anon && anon.anonymous === true && anon.sender_id === null, 'an anonymous message hides the sender');
  ok(rows(await alice.c.from('chat_authors').select('*').eq('message_id', m2)) === 0, 'nobody else can look up who wrote it');
  ok(rows(await bob.c.from('chat_authors').select('*').eq('message_id', m2)) === 1, 'the author can');
  ok((await fay.c.rpc('delete_chat_message', { p_id: m1 })).error, 'a member cannot delete someone else\'s message');
  ok(!(await alice.c.rpc('delete_chat_message', { p_id: m2 })).error, 'the group owner can delete any message');
  ok((await bob.c.from('chat_messages').insert({ group_id: g.data, kind: 'user', body: 'forged' })).error, 'chat messages cannot be written directly');
  ok((await alice.c.from('link_previews').select('*')).error, 'the link preview cache cannot be read from a browser');

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
