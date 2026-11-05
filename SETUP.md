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
5. `supabase/migrations/20261105000005_first_names.sql`
6. `supabase/migrations/20261106000006_profiles_priorities_avatars.sql`

(Or with the Supabase CLI: `npx supabase link --project-ref YOUR-REF` then `npx supabase db push`.)

These files have not yet been run on a real project. If one fails, copy the error and fix it before continuing. Then run `supabase/tests/rls_check.sql` and confirm: every table has `rls_enabled = true`, the `anon` queries return no rows, and `authenticated` can read only `id`, `username` and `created_at` on `profiles`.

## 3. Deploy the Edge Function

The function lets people sign in with a username instead of an email. It holds the only privileged key, inside Supabase.

Run these from the project folder (the one that contains the `supabase` folder). `npx` runs the Supabase CLI without installing it globally. Node.js is required.

```
npx supabase login
npx supabase link --project-ref YOUR-REF
npx supabase functions deploy account --no-verify-jwt
npx supabase secrets set ALLOWED_ORIGINS=https://yourname.github.io,http://localhost:8000
```

If the deploy asks for Docker, add `--use-api` to the deploy command.

**Without the command line:** in the dashboard open **Edge Functions → Deploy a new function → Via Editor**. Name it exactly `account`, paste in the whole of `supabase/functions/account/index.ts`, and deploy. Then open the function's settings and turn **off** "Verify JWT". Add the secrets under **Edge Functions → Secrets**.

Check it worked: `curl -i -X OPTIONS "https://YOUR-REF.supabase.co/functions/v1/account" -H "Origin: http://localhost:8000" -H "Access-Control-Request-Method: POST"` should answer `204` (a `404 NOT_FOUND` means the function isn't deployed under that name).

### What is the sign-up code?

The sign-up code is a short shared password that **you** choose, to keep strangers from creating accounts on your site. It works like a door code for a private party:

- **You set it once:** `npx supabase secrets set SIGNUP_CODE=SnowyPines24`.
- **You share it with the people you invite** (in the same message as the site link). They type it in the "Sign-up code" box when creating their account.
- **If you never set one,** anyone with the link can sign up, and the box doesn't appear on the sign-up form at all. When you do set one, the box appears and the code is required.
- It is only checked when an account is **created**. It does not affect logging in later, and it is not the same as a group's invite code (which controls who can join a group and see its lists).
- To change it, set a new value. Existing accounts keep working. To switch it off, run `npx supabase secrets unset SIGNUP_CODE`.

Optional secrets (set with `npx supabase secrets set NAME=value`):

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
| `service_role` / secret key (`sb_secret_…`) | **Secret.** Never in the website or git. Supabase gives it to the Edge Function automatically. You only use it yourself for `scripts/admin-reset-password.mjs`, in your own terminal |
| Database password, `SIGNUP_CODE` | **Secret.** Never in git |

The website refuses to start if `config.js` contains a secret key. GitHub Pages serves static files and Actions variables don't reach them, so the public values go straight in `config.js`.

## 6. Try it locally

```
python3 -m http.server 8000
```

Open `http://localhost:8000`, create an account (full name, password, recovery question), create a group, add a gift, then try Export and Import in the Account area.

## 7. Run the tests (development project only)

```
npm install
DEV_PROJECT_CONFIRM=yes SUPABASE_URL=https://YOUR-REF.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... npm test
```

If you set `SIGNUP_CODE`, also set it in your shell. The tests create four throwaway users through the real sign-up, check permissions and surprise-gift privacy through the real API, test sign-in, recovery and deletion, then delete the users. They sign up from one network address, so on a dev project you may need `npx supabase secrets set SIGNUP_LIMIT_PER_HOUR=50`. They refuse to run without `DEV_PROJECT_CONFIRM=yes`. **Never run them against production.**

Also check by hand with two browsers: tick a gift in one and confirm the owner's browser never shows it. Add a surprise gift and confirm the owner can't see it.

## 8. Deploy to GitHub Pages

1. Commit and push the project to the branch Pages serves.
2. **Settings → Pages → Build and deployment:** *Deploy from a branch*, branch *main*, folder */ (root)*. There is no build step.
3. Open your site once it's deployed.

## 9. Bring over a list from the old Google Sheet

Each person can bring their own list across in a minute: in the old sheet, open their tab and choose **File → Download → Comma Separated Values (.csv)**. Then they sign up on the new site and use **Import from CSV** under their own list. The import understands the old sheet's columns (Gift names, Approx. price, Links, notes), skips filler rows and duplicates, and shows a preview before adding anything.

## 10. Change the app icon

`icons/maskable-512.png` is the **master icon**. Every other icon (the 192 px app icon, the iPhone icon, the browser tab icon and `favicon.ico`) is generated from it. To use your own: replace that file with a 512 x 512 PNG that fills the whole square with a solid background and keeps the artwork inside the middle 80%, then run:

```
pip install pillow
python3 scripts/make-icons.py
```

Then bump `CACHE` in `sw.js` (for example `giftlist-v4`) so installed copies pick up the new icon.

## 11. Install it on a phone

The site is an installable app (PWA). It must be opened over `https` (GitHub Pages is) or on `localhost`.

- **Android (Chrome):** open the menu (top left) and tap **Install app on this device**. Or use Chrome's own menu, then "Install app".
- **iPhone / iPad (Safari):** tap the Share button, then **Add to Home Screen**.
- **Desktop Chrome or Edge:** use the install icon in the address bar.

The installed app opens full screen, uses your chosen theme's color for the status bar, and reopens straight to your lists. It needs a connection to load lists. Only the page itself is kept for offline, never your gifts or account data.

After you change files on GitHub, installed copies update the next time they open with a connection. If a phone seems stuck on an old version, close the app and reopen it once. To force every device to refresh, change `CACHE = 'giftlist-v1'` in `sw.js` to `giftlist-v2`.

## Someone forgot their password and their answer

```
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/admin-reset-password.mjs "Username" "TemporaryPassword1"
```

Tell them the temporary password privately and ask them to change it in Account.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Add your Supabase URL and publishable key" | `config.js` is empty or not uploaded |
| "Could not reach the sign-in service" | The browser could not complete the request. See "Sign-in service not reachable" below |
| "Could not create the account" | Check the function logs in the dashboard. If it mentions an invalid email, set the `EMAIL_DOMAIN` secret |
| "That sign-up code is not right" | Match the `SIGNUP_CODE` secret exactly |
| "Too many attempts" | Rate limits. Wait 15 minutes (or an hour for sign-ups) |
| Stuck on "Syncing..." | Open the browser console (F12) and the Network tab and look for a request that stays pending or red. Also check the function's logs under Edge Functions. An old service worker on `localhost:8000` can interfere: Application > Service Workers > Unregister, or use another port |
| Lists are empty | Join or create a group. People only see lists of group-mates |
| An SQL file fails | Run files in order on a fresh project and send me the error message |
| Changed `config.js` but nothing changes | Hard refresh (Ctrl+Shift+R or Cmd+Shift+R) |

## Sign-in service not reachable

1. **Is the function deployed?** Open `https://YOUR-REF.supabase.co/functions/v1/account` in a browser tab. Seeing `{"error":"Not found"}` means it is deployed. Seeing `Requested function was not found` means it is not: run `npx supabase functions deploy account --no-verify-jwt`.
2. **Is `SUPABASE_URL` right?** In `config.js` it must look like `https://abcdefghijklmnop.supabase.co`, with no path and no trailing slash.
3. **Does `ALLOWED_ORIGINS` match your site?** Run `npx supabase secrets list`. It should contain your site's address, such as `https://sirtacooooo.github.io`. Then redeploy the function once. If you are testing locally, include `http://localhost:8000`. Leaving the secret unset allows any website.
4. **Look at the browser console** (F12, then Console and Network). A red message about CORS means step 3. A 401 "Invalid JWT" means the function was deployed without `--no-verify-jwt`.
5. **Try a private window** with extensions off, since some ad blockers block requests to `*.supabase.co`.
