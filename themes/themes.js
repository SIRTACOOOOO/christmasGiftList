// The list of themes. To add one:
//   1. Copy any file in this folder (for example ocean.css) and rename it, e.g. forest.css
//   2. Change "ocean" to "forest" inside the file and edit the colors
//   3. Add one line below. The id must match the file name.
// The first theme in the list (Green) is the default.
// The gift app icon has a light and a dark version for each theme: icons/<id>-light-*.png and icons/<id>-dark-*.png, with matching
// manifest-<id>-light.webmanifest / manifest-<id>-dark.webmanifest. The page picks the one that fits the current mode (Midnight is dark only).
// icon  = the symbol on the theme button in the menu (it cycles through these in order).
// scene: true = the theme paints a picture behind a box that holds the list. On phones that box and picture are left out
//          so the list can use the whole screen (see the "phones" rule in index.html).
window.THEMES = [
  { id: 'legacy',    name: 'Green',     title: 'Christmas List', icon: '\u{1F332}' },
  { id: 'christmas', name: 'Christmas', title: 'Christmas List', icon: '\u{1F384}', scene: true },
  { id: 'birthday',  name: 'Birthday',  title: 'Birthday List',  icon: '\u{1F382}', scene: true },
  { id: 'ocean',     name: 'Ocean',     title: 'Gift List',      icon: '\u{1F30A}' },
  { id: 'sunset',    name: 'Sunset',    title: 'Gift List',      icon: '\u{1F305}' },
  { id: 'rose',      name: 'Rose',      title: 'Gift List',      icon: '\u{1F339}' },
  { id: 'midnight',  name: 'Midnight',  title: 'Gift List',      icon: '\u{1F319}' }
];
