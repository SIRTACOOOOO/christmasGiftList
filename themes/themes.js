// The list of themes. To add one:
//   1. Copy any file in this folder (for example ocean.css) and rename it, e.g. forest.css
//   2. Change "ocean" to "forest" inside the file and edit the colors
//   3. Add one line below. The id must match the file name.
// The first theme in the list (Green) is the default.
// color = the app icon's background. The themed app icons are icons/<id>-*.png and manifest-<id>.webmanifest;
//         Green keeps the original icon files and manifest.webmanifest.
// icon  = the symbol on the theme button in the menu (it cycles through these in order).
// scene: true = the theme paints a picture behind a box that holds the list. On phones that box and picture are left out
//          so the list can use the whole screen (see the "phones" rule in index.html).
window.THEMES = [
  { id: 'legacy',    name: 'Green',     title: 'Christmas List', icon: '\u{1F332}', color: '#013e24' },
  { id: 'christmas', name: 'Christmas', title: 'Christmas List', icon: '\u{1F384}', color: '#004f40', scene: true },
  { id: 'birthday',  name: 'Birthday',  title: 'Birthday List',  icon: '\u{1F382}', color: '#1745c2', scene: true },
  { id: 'ocean',     name: 'Ocean',     title: 'Gift List',      icon: '\u{1F30A}', color: '#0b5f8a' },
  { id: 'sunset',    name: 'Sunset',    title: 'Gift List',      icon: '\u{1F305}', color: '#9a330a' },
  { id: 'rose',      name: 'Rose',      title: 'Gift List',      icon: '\u{1F339}', color: '#7a1d3d' },
  { id: 'midnight',  name: 'Midnight',  title: 'Gift List',      icon: '\u{1F319}', color: '#0e1420' }
];
