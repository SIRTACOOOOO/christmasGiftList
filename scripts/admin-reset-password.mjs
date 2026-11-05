// For someone who forgot BOTH their password and their recovery answer. Run on your own computer:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/admin-reset-password.mjs "Full name" "NewTemporaryPassword"
// Tell the person the temporary password privately and ask them to change it in Account. The service key never leaves your computer.
import { createClient } from '@supabase/supabase-js';
const [name, password] = process.argv.slice(2);
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!name || !password || password.length < 8 || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) { console.error('Usage: node scripts/admin-reset-password.mjs "Full name" "NewPassword(8+ chars)"  (with SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set)'); process.exit(1); }
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const p = await sb.from('profiles').select('auth_user_id').eq('username', name).maybeSingle();
if (!p.data?.auth_user_id) { console.error('No account with that name.'); process.exit(1); }
const r = await sb.auth.admin.updateUserById(p.data.auth_user_id, { password });
console.log(r.error ? 'Failed: ' + r.error.message : 'Password changed.');
