# Christmas Gift List

A private wish-list site for families and friends. Everyone has their own list. People in the same group can see each other's lists and tick off what they've bought, and the list's owner never sees those ticks. Anyone can also add a **surprise gift** to someone else's list, which is hidden from that person and shown as already bought to everyone else.

The website is plain HTML on GitHub Pages. Accounts, data and security rules run on **Supabase** (PostgreSQL, Supabase Auth, Row Level Security and one small Edge Function).

> **Status: not yet tested against a live Supabase project.** The SQL, the Edge Function, the website and the scripts were written and syntax-checked, but nothing has been run against a real project. Follow the test procedure in [SETUP.md](SETUP.md) on a development project before using this with real people. See [Testing](#testing).

## Features

- **Accounts with just a username and password.** No email address is needed. A recovery question lets people reset a forgotten password.
- **Your own list:** add, edit and delete gifts with a price, link and notes. You can't see what's been bought.
- **Other people's lists:** tick gifts as bought, so nobody buys the same thing twice.
- **Surprise gifts:** add a gift that wasn't on someone's list. It's hidden from that person and shown as bought to others.
- **Groups:** create or join several groups with an invite code. One list is shared across all your groups.
- **People bar scrolls sideways** and gets a search box once there are many people.
- **Export and import:** download your list as a CSV file that opens in Google Sheets or Excel, and import a CSV back (including your old Google Sheet, downloaded as CSV).
- **Account tools:** change your username (everything moves with you), change your password, change your recovery question, and **delete your account**.
- **Themes:** Christmas Legacy, Christmas, Birthday, Ocean, Sunset, Rose and Midnight, each in its own file.

## Is it ready for hundreds of users?

Postgres handles hundreds of users easily, and the design avoids the usual traps:

- The website loads a directory of people and groups (in pages of 1,000), then **only the gifts of the person you're viewing**. A big group never downloads everyone's gifts at once.
- Lookups are indexed, lists are capped at 1,000 gifts, groups at 100 members, and sign-in, sign-up, recovery and invite-code guessing are rate-limited.
- Everything is enforced in the database, so more users means more rows, not more risk.

Things to watch, none of which has been load-tested:

- **Plan limits.** Free Supabase projects have limits on database size, bandwidth, monthly active users and function calls, and may pause after inactivity. Check Supabase's current pricing before a public launch.
- **One shared network.** Sign-up allows 5 new accounts per hour from one network address by default (a school or office counts as one). Change it with the `SIGNUP_LIMIT_PER_HOUR` secret.
- **Huge groups.** In a group of hundreds, everyone can see everyone's list. Smaller groups give better privacy. Raise the 100-member cap in `join_group` only if you need to.
- **More than a few thousand users:** add paging to the people bar and consider Supabase Realtime for live updates.

## What changed from the Google Sheets version

| | Before (Google Sheets + Apps Script) | Now (Supabase) |
|---|---|---|
| Data | One sheet tab per person, hidden tabs for logins and groups | PostgreSQL tables with foreign keys and constraints |
| Login | Username and password checked by script code | Username and password through **Supabase Auth**, via a small Edge Function so no email is needed |
| Forgot password | Recovery question | Recovery question, now checked with bcrypt and strict rate limits |
| Privacy | Script code decided what each person could see | **Row Level Security** inside the database, so direct API calls can't bypass it |
| Purchase ticks | A column on the gift row, hidden by the script | A separate table the gift's owner has no right to read |
| Speed | Several seconds per request | Direct database queries; edits show immediately |
| Hosting | GitHub Pages + Apps Script | GitHub Pages + Supabase |

Existing users keep their usernames. Old passwords can't be moved (they were stored as one-way hashes Supabase can't import), so each person creates their login again and enters a one-time claim code to get their old list back. See [docs/MIGRATION.md](docs/MIGRATION.md).

## How privacy is enforced

All rules live in `supabase/migrations/`, not in the browser:

- **Gifts:** you see your own list, minus surprise gifts others added. You see a group-mate's list including surprise gifts. Nobody else sees anything.
- **Purchases:** the `purchases` table has no read rule for the owner of the gift. A direct API query for your own gifts' purchases returns nothing.
- **Surprise gifts:** the database records who created each gift and refuses to let browsers fake it. A surprise gift is marked bought automatically and can't be un-marked.
- **Groups:** nobody can insert into group tables directly. Creating, joining, leaving and removing go through database functions that check who is asking.
- **Secrets:** the browser holds only the project URL and publishable key. The one secret key lives inside Supabase, where the Edge Function runs.

## Project layout

```
index.html              The website
config.js               Your Supabase URL + publishable key (public values)
themes/                 Colors and backgrounds (one CSS file each), see themes/README.md
icons/                  Site icon
supabase/migrations/    SQL that builds everything on a fresh project (run in order)
supabase/functions/     The "account" Edge Function (sign-in without email, recovery, deletion)
supabase/tests/         SQL checks to run in the dashboard
tests/                  Automated security and behaviour tests for a DEV project
migration/              Export from the old sheet + repeatable import into Supabase
scripts/                Admin helper: reset a password for someone who lost everything
legacy/                 The old Google Apps Script backend, kept for reference and rollback
docs/MIGRATION.md       Backup, migration, cutover and rollback
SETUP.md                Step-by-step setup and deployment
```

## Quick start

1. Create a Supabase project and run the four SQL files in `supabase/migrations/` in order.
2. Deploy the Edge Function and set Auth to disable public sign-up.
3. Put your project URL and publishable key in `config.js`.
4. Push to GitHub Pages.

Details, with every setting, are in **[SETUP.md](SETUP.md)**.

## Testing

| Check | Status |
|---|---|
| JavaScript syntax of the website, import script, admin script and tests | Passed (`node --check`) |
| SQL migrations | **Not run.** No PostgreSQL was available when this was written. Run them on a new project and fix anything the SQL editor reports |
| Edge Function (TypeScript, Deno) | **Not run or type-checked** |
| Website in a browser | **Not run** |
| `tests/security.test.mjs` (about 50 checks: permissions, surprise-gift privacy, sign-in, recovery, deletion, throttling, concurrency) | **Not run.** Run on a dev project |
| Data import | **Not run** (needs your export file) |
| CSV export and import | **Not run** in a browser. Try it with a small file first |

Unverified assumptions to check first: that Supabase accepts the placeholder login addresses the Edge Function creates (if not, set the `EMAIL_DOMAIN` secret), that the pinned `supabase-js` version works with the newer publishable keys, and that the `purchases(gift_id)` embedded lookup behaves as expected.

## Known limitations

- A recovery question is only as strong as its answer. Choose one others can't guess. If someone forgets both, use `scripts/admin-reset-password.mjs`.
- Resetting a password doesn't sign out devices that are already logged in.
- Usernames are unique and visible to people you share a group with. Choosing a taken username reveals that it exists.
- CAPTCHA on sign-up is not wired in. Rate limits apply.
- Each person has one list, shared across all their groups.
- If a surprise gift's creator deletes their account, the gift stays hidden from the owner and keeps its "bought" mark.

## License

GPL3
