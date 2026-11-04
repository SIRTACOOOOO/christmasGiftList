// Safe, repeatable import of gift-list-export.json into Supabase.
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migration/import.mjs path/to/gift-list-export.json [--dry-run]
// Run it on your own computer only. The service role key must never be committed or put in the website.
// Re-running is safe: every record gets a deterministic id, so existing rows are updated, not duplicated.
// Nothing is deleted. Passwords, hashes and recovery answers are never read.
import { createClient } from '@supabase/supabase-js';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
const dry = flags.includes('--dry-run');
if (!file) { console.error('Usage: node migration/import.mjs export.json [--dry-run]'); process.exit(1); }
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your shell (see .env.example).'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Deterministic UUID v5 so re-runs hit the same rows.
const NS = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');
function uuid5(name) {
  const h = createHash('sha1').update(NS).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 '.\-]{0,29}$/;
const norm = c => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = c => createHash('sha256').update(norm(c)).digest('hex');
const newCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', b = randomBytes(16); return [...b].map(x => a[x % 32]).join('').replace(/(.{4})(?=.)/g, '$1-'); };
const key = s => s.toLowerCase();

const data = JSON.parse(readFileSync(file, 'utf8'));
const report = { dryRun: dry, profiles: { imported: 0, existing: 0, skipped: [] }, gifts: { imported: 0, skipped: [], failed: [] },
                 groups: { imported: 0, skipped: [] }, members: { imported: 0, skipped: [] }, purchases: { imported: 0, failed: [] }, warnings: [] };

// 1. Profiles -----------------------------------------------------------------------------------------------
const names = new Map();                                    // lowercase name -> canonical name
for (const n of [...(data.users || []), ...Object.keys(data.lists || {})]) {
  if (!n) continue;
  if (!NAME_RE.test(n)) { report.profiles.skipped.push({ name: n, reason: 'invalid username' }); continue; }
  if (!names.has(key(n))) names.set(key(n), n);
}
const { data: existing, error: e0 } = await sb.from('profiles').select('id, username, auth_user_id');
if (e0) { console.error('Could not read profiles:', e0.message); process.exit(1); }
const have = new Map(existing.map(p => [key(p.username), p]));
const profileId = n => uuid5('profile:' + key(n));
const claimRows = [];
for (const [k, n] of names) {
  if (have.has(k)) { report.profiles.existing++; continue; }
  const code = newCode();
  claimRows.push([n, code]);
  if (!dry) {
    const { error } = await sb.from('profiles').upsert({ id: profileId(n), username: n, claim_hash: hashCode(code) }, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { report.profiles.skipped.push({ name: n, reason: error.message }); continue; }
  }
  report.profiles.imported++;
}
const idOf = n => (have.get(key(n)) || { id: profileId(n) }).id;
const known = n => names.has(key(n));

// 2. Gifts + purchases -----------------------------------------------------------------------------------------
for (const [owner, list] of Object.entries(data.lists || {})) {
  if (!known(owner)) { report.gifts.skipped.push({ owner, reason: 'owner not imported' }); continue; }
  const seen = new Map();
  for (const g of list) {
    const label = `${owner}: ${String(g.name).slice(0, 40)}`;
    const name = String(g.name || '').trim();
    if (!name || name.length > 200) { report.gifts.skipped.push({ item: label, reason: 'bad name' }); continue; }
    const price = g.price == null ? null : Number(g.price);
    if (price != null && (!(price >= 0) || price > 99999999)) { report.gifts.skipped.push({ item: label, reason: 'bad price' }); continue; }
    if ((g.link || '').length > 1000 || (g.notes || '').length > 1000) { report.gifts.skipped.push({ item: label, reason: 'link or notes too long' }); continue; }
    const by = g.by && known(g.by) ? g.by : '';
    if (g.by && !by) report.warnings.push(`${label}: surprise-gift creator "${g.by}" not found; treated as a normal gift`);
    const base = `gift:${key(owner)}:${key(name)}:${g.link || ''}`, n = (seen.get(base) || 0) + 1; seen.set(base, n);
    const id = uuid5(base + ':' + n);
    const row = { id, owner_id: idOf(owner), created_by: idOf(by || owner), name, price, link: g.link || null, notes: g.notes || null };
    if (dry) { report.gifts.imported++; continue; }
    const r = await sb.from('gifts').upsert(row, { onConflict: 'id' });
    if (r.error) { report.gifts.failed.push({ item: label, reason: r.error.message }); continue; }
    report.gifts.imported++;
    if (g.bought && !by) {                                  // surprise gifts get their purchase from a database trigger
      const p = await sb.from('purchases').upsert({ gift_id: id, bought_by: null }, { onConflict: 'gift_id', ignoreDuplicates: true });
      if (p.error) report.purchases.failed.push({ item: label, reason: p.error.message }); else report.purchases.imported++;
    }
  }
}

// 3. Groups + members ------------------------------------------------------------------------------------------
for (const g of data.groups || []) {
  const code = String(g.code || '').toUpperCase();
  if (!/^[A-Z2-9]{6,8}$/.test(code) || !g.name) { report.groups.skipped.push({ group: g.name, reason: 'bad name or code' }); continue; }
  const gid = uuid5('group:' + code);
  const owner = g.members.find(known) || null;
  if (!dry) {
    const r = await sb.from('groups').upsert({ id: gid, name: String(g.name).slice(0, 40), invite_code: code, created_by: owner ? idOf(g.createdBy && known(g.createdBy) ? g.createdBy : owner) : null }, { onConflict: 'id' });
    if (r.error) { report.groups.skipped.push({ group: g.name, reason: r.error.message }); continue; }
  }
  report.groups.imported++;
  let first = true;
  for (const m of g.members) {
    if (!known(m)) { report.members.skipped.push({ group: g.name, member: m, reason: 'profile not imported' }); continue; }
    if (!dry) {
      const r = await sb.from('group_members').upsert({ group_id: gid, profile_id: idOf(m), role: (g.createdBy ? key(g.createdBy) === key(m) : first) ? 'owner' : 'member' }, { onConflict: 'group_id,profile_id', ignoreDuplicates: true });
      if (r.error) { report.members.skipped.push({ group: g.name, member: m, reason: r.error.message }); continue; }
    }
    report.members.imported++; first = false;
  }
}

// 4. Output (claim codes are secrets: written to a private file, never printed) --------------------------------
mkdirSync('migration/out', { recursive: true });
writeFileSync('migration/out/report.json', JSON.stringify(report, null, 2));
if (claimRows.length && !dry) {
  writeFileSync('migration/out/claim-codes.csv', 'username,claim_code\n' + claimRows.map(r => r.join(',')).join('\n') + '\n');
  try { chmodSync('migration/out/claim-codes.csv', 0o600); } catch {}
}
const c = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]));
console.log(dry ? 'DRY RUN (nothing written)' : 'Import finished', '\n', JSON.stringify({ profiles: c(report.profiles), gifts: c(report.gifts), groups: c(report.groups), members: c(report.members), purchases: c(report.purchases), warnings: report.warnings.length }, null, 1));
console.log('Details: migration/out/report.json' + (claimRows.length && !dry ? '   Claim codes: migration/out/claim-codes.csv (keep private, delete after handing them out)' : ''));
