# Setup guide

You need a free [Supabase](https://supabase.com) account, a GitHub repository with GitHub Pages turned on, Node.js (for the CLI and tests), and about 30 minutes. Use a **separate development project** first.

## 1. Create the Supabase project

1. In Supabase, click **New project**. Pick a name, a region near your users and a strong database password. Save the password in a password manager.
2. Open **Project Settings → API Keys** and note the **Project URL** and the **publishable key** (starts with `sb_publishable_`). If your project only shows the older "anon" key, use that.

## 2. Build the database

In **SQL Editor → New query**, paste each file below **in this order** and click **Run**. Each must finish without errors.

1. `supabase/migrations/20261103000001_schema.sql`
2. `supabase/migrations/20261103000002_security.sql`
3. `supabase/migrations/20261103000003_rpc.sql`
4. `supabase/migrations/20261104000004_username_auth.sql`

(Or with the Supabase CLI: `supabase link --project-ref YOUR-REF` then `supabase db push`.)

These files have not yet been run on a real project. If one fails, copy the error and fix it before continuing. Then run `supabase/tests/rls_check.sql` and confirm: every table has `rls_enabled = true`, the `anon` queries return no rows, and `authenticated` can read only `id`, `username` and `created_at` on `profiles`.

## 3. Deploy the Edge Function

The function lets people sign in with a username instead of an email. It holds the only privileged key, inside Supabase.

```
npm install -g supabase            # or: npx supabase ...
supabase login
supabase link --project-ref YOUR-REF
supabase functions deploy account --no-verify-jwt
supabase secrets set ALLOWED_ORIGINS=https://sirtacooooo.github.io,http://localhost:8000
```

Optional secrets (set with `supabase secrets set NAME=value`):

| Secret | Purpose |
|---|---|
| `SIGNUP_CODE` | If set, new accounts must enter this code. Good for private family sites. Leave unset for open sign-up |
| `SIGNUP_LIMIT_PER_HOUR` | New accounts allowed per network address per hour (default 5) |
| `EMAIL_DOMAIN` | Domain for the placeholder login addresses (default `users.giftlist.invalid`). Nothing is ever emailed. If Supabase rejects the default, use a domain you own |

`ALLOWED_ORIGINS` takes website origins only (scheme and host, no path).

## 4. Configure sign-in (Authentication)

| Where in the dashboard | Setting |
|---|---|
| **Sign In / Providers → User Signups** | Turn **off** "Allow new users to sign up". Accounts are created only through the Edge Function, so nobody can bypass its sign-up code and limits. The Email provider itself must stay enabled |
| **Sign In / Providers → Anonymous sign-ins** | Off |
| **Password requirements** | Minimum length 8 |
| **URL Configuration → Site URL** | Your live address, e.g. `https://sirtacooooo.github.io/christmasGiftList/` |
| **Redirect URLs** | Not used by sign-in. You may add your site and `http://localhost:8000/**` anyway |

You do **not** need to set up email sending: no emails are sent.

## 5. Connect the website

Fill in `config.js`:

```js
window.GIFT_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_KEY: 'sb_publishable_...'
};
```

### What is public and what is secret

| Value | Where it may live |
|---|---|
| Project URL | Public. In `config.js` |
| Publishable (or anon) key | Public. In `config.js`. Security comes from the database rules, not from hiding this key |
| `service_role` / secret key (`sb_secret_…`) | **Secret.** Never in the website or git. Supabase gives it to the Edge Function automatically. You only use it yourself for `migration/import.mjs` and `scripts/admin-reset-password.mjs`, in your own terminal |
| Database password, `SIGNUP_CODE` | **Secret.** Never in git |

The website refuses to start if `config.js` contains a secret key. GitHub Pages serves static files and Actions variables don't reach them, so the public values go straight in `config.js`.

## 6. Try it locally

```
python3 -m http.server 8000
```

Open `http://localhost:8000`, create an account (username, password, recovery question), create a group, add a gift, then try Export and Import in the Account area.

## 7. Run the tests (development project only)

```
npm install
DEV_PROJECT_CONFIRM=yes SUPABASE_URL=https://YOUR-REF.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... npm test
```

If you set `SIGNUP_CODE`, also set it in your shell. The tests create four throwaway users through the real sign-up, check permissions and surprise-gift privacy through the real API, test sign-in, recovery and deletion, then delete the users. They sign up from one network address, so on a dev project you may need `supabase secrets set SIGNUP_LIMIT_PER_HOUR=50`. They refuse to run without `DEV_PROJECT_CONFIRM=yes`. **Never run them against production.**

Also check by hand with two browsers: tick a gift in one and confirm the owner's browser never shows it. Add a surprise gift and confirm the owner can't see it.

## 8. Deploy to GitHub Pages

1. Commit and push the project to the branch Pages serves.
2. **Settings → Pages → Build and deployment:** *Deploy from a branch*, branch *main*, folder */ (root)*. There is no build step.
3. Open your site once it's deployed.

## 9. Move existing data

Follow [docs/MIGRATION.md](docs/MIGRATION.md).

## Someone forgot their password and their answer

```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/admin-reset-password.mjs "Username" "TemporaryPassword1"
```

Tell them the temporary password privately and ask them to change it in Account.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Add your Supabase URL and publishable key" | `config.js` is empty or not uploaded |
| "Network problem" when signing in | The Edge Function isn't deployed, or `ALLOWED_ORIGINS` doesn't include your site's origin |
| "Could not create the account" | Check the function logs in the dashboard. If it mentions an invalid email, set the `EMAIL_DOMAIN` secret |
| "That sign-up code is not right" | Match the `SIGNUP_CODE` secret exactly |
| "Too many attempts" | Rate limits. Wait 15 minutes (or an hour for sign-ups) |
| Lists are empty | Join or create a group. People only see lists of group-mates |
| An SQL file fails | Run files in order on a fresh project and send me the error message |
| Changed `config.js` but nothing changes | Hard refresh (Ctrl+Shift+R or Cmd+Shift+R) |
