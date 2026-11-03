# Themes

Every look of the site lives in this folder. Each theme is one small CSS file, and `themes.js` lists which ones appear in the dropdown.

## Change a theme

Open its file (for example `ocean.css`) and change the colors. Save, upload, and refresh the page.

## Add a theme

1. Copy a file, for example `ocean.css`, and rename it, such as `forest.css`.
2. Inside the file, change `html[data-theme=ocean]` to `html[data-theme=forest]`, then edit the colors.
3. Add one line to `themes.js`:
   ```js
   { id: 'forest', name: 'Forest', title: 'Gift List' },
   ```
   The `id` must match the file name. `name` is what shows in the dropdown. `title` is the big heading on the page (for example "Birthday List").

The first theme in `themes.js` is the default for new visitors.

## What each variable does

| Variable | What it controls |
|---|---|
| `--bg` | Page background color (behind everything) |
| `--card` | Input boxes, dialogs and buttons |
| `--ink` | Main text |
| `--mute` | Lighter secondary text |
| `--line` | Borders and dividers |
| `--pine` | Main accent: heading, links, selected buttons |
| `--berry` | Second accent: the Add gift and Save buttons |
| `--on-pine` | Text color on top of `--pine` |
| `--on-berry` | Text color on top of `--berry` (defaults to white) |
| `--done` | Background of gifts that are bought |

Optional extras for fancier themes (see `christmas.css` and `birthday.css`):

| Variable | What it controls |
|---|---|
| `--bgimg` | Background layers (images or gradients) drawn behind the page |
| `--panel` | Color of the box that holds the list. Use a see-through white over busy backgrounds |
| `--pad` | Padding inside that box (for example `20px`) |
| `--gap` | Extra space above the page, to leave room for decorations at the top |
| `--display` | Font for headings and gift names |

## Tips

- Pick text colors with good contrast against their background. If `--pine` is light, make `--on-pine` dark.
- Images are written as inline SVG, so no extra files are needed. You can also use `url(your-image.png)` if you put the image in this folder and write `url(themes/your-image.png)`.
- A theme can load its own font by starting the file with an `@import` line. `birthday.css` shows how.
- A theme can follow the device's dark mode with `@media (prefers-color-scheme: dark) { ... }`. `legacy.css` shows how.
