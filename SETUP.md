# Setup guide

This takes about 15 minutes and costs nothing. You need a Google account and a GitHub account (or any other place that hosts simple web pages).

The site has two parts:

- **The website** (`index.html` and the `themes` folder) is what people see. You host it on GitHub Pages.
- **The backend** (`backend/Code.gs`) lives inside a Google Sheet and runs on Google's servers. It stores the gifts and checks logins.

Tip: use a Google account you don't mind other people seeing the name of. A dedicated free Gmail account just for this is a good idea.

---

## Part 1: Create the Google Sheet and backend

1. Go to [sheets.google.com](https://sheets.google.com) and create a **blank spreadsheet**. Name it anything, for example "Gift List".
2. Right-click the default tab at the bottom (usually "Sheet1") and **rename it to `_unused`**. Tabs starting with an underscore are ignored by the site. (You can delete it instead, but a sheet needs at least one tab.)
3. Open **Extensions → Apps Script**. A code editor opens.
4. Delete everything in the editor, then paste in the whole contents of `backend/Code.gs`.
5. Near the top, find this line and change the value to a family code of your own:
   ```js
   const SIGNUP_CODE = 'change-me';
   ```
   People need this code to create an account. Leave it as `''` (empty) if anyone with the link should be able to sign up.
6. Click the **Save** icon.

## Part 2: Publish the backend

1. Click the blue **Deploy** button (top right) and choose **New deployment**.
2. Click the gear icon next to "Select type" and pick **Web app**.
3. Set **Execute as** to **Me**, and **Who has access** to **Anyone**.
4. Click **Deploy** and then **Authorize access**. Choose your account. If Google says "hasn't verified this app", click **Advanced → Go to (project name)** and **Allow**. This is your own script asking to edit your own sheet.
5. Copy the **Web app URL**. It must start with `https://script.google.com/` and end in `/exec`.

## Part 3: Connect the website

1. Open `index.html` in a text editor (Notepad is fine).
2. Near the top, paste your URL between the quotes:
   ```js
   const SCRIPT_URL = 'https://script.google.com/macros/s/XXXXXXXX/exec';
   ```
3. Save the file.

## Part 4: Put the website online (GitHub Pages)

1. Create a free account at [github.com](https://github.com) and click **New repository**. Name it (for example `gift-list`) and choose **Public**.
2. On the repository page, click **uploading an existing file**. Drag in `index.html` **and the whole `themes` folder**. Keep the folder structure as it is.
3. Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Build and deployment*, set *Source* to **Deploy from a branch**, pick the **main** branch and **/ (root)**, and save.
5. After a minute or two, the Pages settings show your site's address, such as `https://yourname.github.io/gift-list/`.

Do **not** upload `backend/Code.gs` to a public repository if you've put your real family code in it. It already lives in your sheet.

## Part 5: First use

1. Open your site. Click **Create an account**, choose a name and password (6 or more characters), and enter your family code.
2. Click **Groups** (top right), type a group name such as "Family", and click **Create**. You get a 6-character invite code.
3. Send people the site link and the invite code. They create their own accounts, then click **Groups → Join** and enter the code.
4. In **Account**, each person can add a recovery question for forgotten passwords, change their password, or change their username (their list and groups move with them).

Each person gets their own list. People in the same group can see each other's lists, tick off gifts, and add surprise gifts that the list owner can't see.

---

## Updating later

- **Changed `Code.gs`?** Paste the new version into Apps Script, then **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. Saving alone does not update the live site. The `/exec` URL stays the same.
- **Changed the website or a theme?** Upload the changed files to GitHub again. If the page looks the same, do a hard refresh (Ctrl+Shift+R, or Cmd+Shift+R on Mac).

## Moving an existing list into the site

If you already have a list in a tab, rename that tab to the person's exact name (for example `Anthony`) **before** they sign up. When they create an account with that name, they take over the tab and keep the gifts. The columns are: A gift name, B price, C link, D notes, F "bought" checkbox, G surprise gift from. Row 1 holds the headers.

## Someone forgot their password and their recovery answer

In Apps Script, open `adminResetPassword`, fill in `NAME` and `NEW_PASSWORD` inside the function, choose `adminResetPassword` in the function dropdown, and click **Run**. Tell the person their new password, and ask them to change it in Account.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Could not load the sheet" | Check `SCRIPT_URL`: it must start with `script.google.com` and end in `/exec`. A link starting with `script.googleusercontent.com` is wrong. |
| "Failed to fetch" | **Who has access** must be **Anyone**, not "Anyone with Google account". Then redeploy with **New version**. Try a private window to rule out a browser extension. |
| Changes to `Code.gs` do nothing | You need **Deploy → Manage deployments → pencil → New version → Deploy**. |
| "Wrong family code" | The code typed must match `SIGNUP_CODE` exactly, including capitals. |
| Page looks unstyled or the theme won't change | The `themes` folder must be uploaded next to `index.html`. |
| You see everyone's old logins after updating | Everyone logs in again after the URL changes. Their accounts are kept. |

## Good to know

- Passwords are stored as salted hashes, but the site checks them through a normal web request. It's meant for family gift lists, not sensitive data. Don't reuse an important password.
- Anyone who can open the Google Sheet can see everything in it, including who bought what and every surprise gift. Don't share the sheet with the people it's a surprise for.
- Google's free limits are far above what a family needs.
