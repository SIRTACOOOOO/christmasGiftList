/**
 * One-time export from the OLD Google Sheet. Paste this into the old sheet's Apps Script project
 * (Extensions > Apps Script > + > Script), select exportForSupabase, and click Run.
 *
 * It writes ONE file named gift-list-export.json to your Google Drive containing usernames, gifts,
 * bought marks and groups. It deliberately leaves out password hashes, recovery answers and sessions.
 * Download the file, use it with migration/import.mjs, then delete it from Drive and your computer.
 */
function exportForSupabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const listTabs = sheets.filter(s => s.getName().charAt(0) !== '_');
  const out = { exportedAt: new Date().toISOString(), users: [], lists: {}, groups: [] };

  const users = ss.getSheetByName('_users');
  if (users) users.getDataRange().getValues().forEach(r => { if (r[0]) out.users.push(String(r[0]).trim()); });

  listTabs.forEach(s => {
    const n = s.getLastRow(), items = [];
    if (n >= 2) s.getRange(2, 1, n - 1, 7).getValues().forEach(r => {
      const name = String(r[0]).trim();
      if (!name || name.charAt(0) === '~') return;
      const price = parseFloat(String(r[1]).replace(/[^0-9.]/g, ''));
      items.push({
        name: name, price: isNaN(price) ? null : price, link: String(r[2] || '').trim(), notes: String(r[3] || '').trim(),
        bought: r[5] === true || /^(true|yes|x)$/i.test(String(r[5]).trim()), by: String(r[6] || '').trim()
      });
    });
    out.lists[s.getName()] = items;
  });

  const groups = ss.getSheetByName('_groups'), members = ss.getSheetByName('_members');
  if (groups) groups.getDataRange().getValues().forEach(g => {
    if (!g[0]) return;
    const code = String(g[0]).trim();
    out.groups.push({
      code: code, name: String(g[1]).trim(), createdBy: String(g[2] || '').trim(),
      members: members ? members.getDataRange().getValues().filter(m => String(m[0]).trim() === code).map(m => String(m[1]).trim()) : []
    });
  });

  const file = DriveApp.createFile('gift-list-export.json', JSON.stringify(out, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('Saved to Drive: ' + file.getUrl());
}
