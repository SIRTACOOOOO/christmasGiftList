# Moving from Google Sheets to Supabase

Nothing here deletes or changes your old sheet or Apps Script. The old site keeps working until you decide to switch.

## What moves and what does not

| Moves | Does not move |
|---|---|
| Usernames, each person's gifts (name, price, link, notes) | Passwords (stored as one-way hashes Supabase cannot import) |
| Bought marks | Recovery questions and answers (people choose a new one when they sign up) |
| Surprise gifts and who added them | Login sessions |
| Groups, members, invite codes | Who ticked a gift (the old sheet did not record it, so it imports as "bought by unknown") |

People claim their imported account by signing up with the **same username** and entering a **one-time claim code**. This is how ownership transfers safely: nobody can take over "Mom" just by typing the name.

## Step 1: Back up

1. In the old Google Sheet: **File → Download → Microsoft Excel (.xlsx)**. Keep it somewhere safe. This copy has everything.
2. Tag the current code in git so you can return to it: `git tag legacy-google-sheets && git push --tags`.

## Step 2: Export from the sheet

1. In the old sheet, open **Extensions → Apps Script**, add a new file, and paste in `migration/export-from-sheets.gs`.
2. Choose `exportForSupabase` and click **Run** (approve Drive access).
3. In Google Drive, download `gift-list-export.json`. It contains no passwords, hashes, answers or sessions. Delete it from Drive once the import is done.

## Step 3: Dry run

```
npm install
export SUPABASE_URL=https://YOUR-REF.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...          # secret: only in your own terminal
node migration/import.mjs path/to/gift-list-export.json --dry-run
```

Read `migration/out/report.json`. It lists what would be imported and what would be skipped, such as invalid usernames, bad prices, too-long text, and members with no profile. Fix the source data or accept the skips.

## Step 4: Import

```
node migration/import.mjs path/to/gift-list-export.json
```

- Safe to run again: every record has a stable ID derived from its content, so re-runs update rather than duplicate.
- Nothing is deleted. Existing Supabase profiles are left alone, and no new claim codes are made for them.
- `migration/out/report.json` shows imported, skipped and failed records. Claim codes are never printed; they go to `migration/out/claim-codes.csv`.

## Step 5: Hand out the claim codes

`migration/out/claim-codes.csv` lists one code per person. Each code works once and can't be recovered from the database (only its hash is stored). Send each person only their own code, over a private channel. Delete the CSV afterwards. If someone loses a code, delete their unclaimed profile row in the dashboard and re-run the import, or set a new `claim_hash` by hand.

Each person then:
1. Opens the new site and clicks **Create an account**.
2. Enters the **same username** they had before, a new password, a recovery question and answer, the **claim code**, and the sign-up code if you set one.
3. Sees their old list, groups and surprise gifts straight away.

Old invite codes are kept, so existing groups keep working. Because they are shorter than new ones, you may want to use **New invite code** in the Groups dialog once everyone has joined.

## Step 6: Check the result

- Compare gift counts per person with the old sheet.
- Spot-check surprise gifts: the receiver must not see them.
- Run `supabase/tests/rls_check.sql`.

## Step 7: Cut over

1. Merge the Supabase version to your Pages branch.
2. Tell everyone the new login process and send claim codes.
3. Leave the old Apps Script deployed for a few weeks as a safety net. Do not let people use both sites, because changes won't sync.
4. When you're sure, set the old script's access to **Only myself**, or delete the deployment.

## Rollback

- **Website:** revert the commit or check out the `legacy-google-sheets` tag and push. The old site works as long as its Apps Script deployment still exists.
- **Data:** the old sheet was never modified. To redo the import from scratch, delete the rows from `gifts`, `group_members`, `groups` and the unclaimed `profiles` in the SQL editor, then import again. Do not delete profiles people have already claimed.
- **Worst case:** restore the downloaded `.xlsx` into a new Google Sheet and re-deploy the legacy script from `legacy/google-apps-script/Code.gs`.
