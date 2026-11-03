# Gift List

A private, shareable wish list site for families and friends. Everyone has their own list, and the people they share a group with can tick off what they've bought without the list owner ever seeing. It runs for free: the website is plain HTML hosted on GitHub Pages, and the data lives in a Google Sheet.

## Features

- **Accounts:** name and password, with a family code to keep strangers out.
- **Your own list:** add, edit and delete gifts with a price, link and notes. You can't see what's been bought.
- **Other people's lists:** tick gifts as bought, so nobody buys the same thing twice.
- **Surprise gifts:** add a gift that wasn't on someone's list. It's hidden from that person and shown as already bought to everyone else.
- **Groups:** create or join several groups with an invite code. One list is shared across all your groups.
- **Account tools:** change your username (your list and groups come with you), change your password, and set a recovery question for forgotten passwords.
- **Themes:** Christmas Legacy, Christmas, Birthday, Ocean, Sunset, Rose and Midnight. Each lives in its own file, so they're easy to change or add.
- **Works on phones.** Totals, search and filters are included.

## How it's built

```
Browser (index.html)  <-->  Google Apps Script web app (backend/Code.gs)  <-->  Google Sheet
   hosted on GitHub Pages        runs on Google's servers                       one tab per person
```

The sheet is the database. Each person's list is a tab, and hidden tabs hold logins, groups and sessions. The page never reads the sheet directly; every request goes through the script, which decides who may see or change what.

## Project layout

```
gift-list/
├─ index.html          The website. Put your backend URL at the top.
├─ themes/             One CSS file per theme, plus themes.js (the list)
│  └─ README.md        How to edit or add a theme
├─ backend/
│  └─ Code.gs          Paste into Google Apps Script
├─ SETUP.md            Step-by-step hosting guide
└─ README.md
```

## Quick start

1. Create a Google Sheet and paste `backend/Code.gs` into **Extensions → Apps Script**.
2. Deploy it as a web app and copy the `/exec` URL.
3. Paste the URL into `SCRIPT_URL` at the top of `index.html`.
4. Upload `index.html` and the `themes` folder to a GitHub repository and turn on GitHub Pages.

The full walkthrough, with troubleshooting, is in **[SETUP.md](SETUP.md)**.

## Customizing

- **Colors and backgrounds:** edit or add files in `themes/`. See [themes/README.md](themes/README.md).
- **Heading text:** each theme's `title` is set in `themes/themes.js`.
- **Sign-up code and permissions:** at the top of `backend/Code.gs`.

## Security and privacy notes

- Passwords are salted and hashed, and recovery answers are hashed too. Sessions are random tokens kept in a hidden sheet tab.
- Requests are made over HTTPS, but the site sends them as web addresses, which Google may log. This suits a family gift list, not sensitive data.
- Whoever owns or can edit the Google Sheet can see everything in it, including purchases and surprise gifts.
- The recovery question shows on screen when someone asks to reset a password for a name. Choose questions whose answers can't be guessed.
- There is a 5-try lock on recovery answers, but no lock yet on wrong login passwords.
- Don't commit your real `SIGNUP_CODE` to a public repository.

## Limitations

- Built for small groups. Google Apps Script has daily limits that are far above family use but would matter for hundreds of active users.
- Deleting a gift deletes its sheet row. Two people editing the same list at the same moment may see a "list changed" message and a refresh.
- Each person has one list, shared across their groups. Separate lists for different occasions are not supported yet.

## License

Add a `LICENSE` file of your choice (for example MIT) before publishing.
