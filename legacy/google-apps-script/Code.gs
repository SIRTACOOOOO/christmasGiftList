/**
 * Gift list backend with accounts. Paste into Extensions > Apps Script in your Google Sheet.
 * Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 * (Updating later: Deploy > Manage deployments > pencil > New version > Deploy.)
 *
 * Each person has a tab named after them (row 1 = headers):
 * A Gift names | B Approx. price | C Links | D notes | E (unused) | F Check if bought | G Surprise gift from
 * _users columns: A name | B salt | C password hash | D-G (old, unused) | H question | I answer salt | J answer hash | K wrong tries | L locked until
 * Tabs starting with an underscore (_users, _sessions, _groups, _members) are created automatically.
 * People only see lists of people who share a group with them. A person can be in many groups.
 */
const SIGNUP_CODE = 'change-me';  // family code needed to create an account. Leave '' for open sign-up.

function ss_() { return SpreadsheetApp.getActiveSpreadsheet(); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function people_() { return ss_().getSheets().map(s => s.getName()).filter(n => n.charAt(0) !== '_'); }
function tab_(name) { let s = ss_().getSheetByName(name); if (!s) { s = ss_().insertSheet(name); s.hideSheet(); } return s; }
function same_(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }

function hash_(salt, pw) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pw)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function findUser_(name) {
  const v = tab_('_users').getDataRange().getValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] && same_(v[i][0], name)) {
    return { row: i + 1, name: v[i][0], salt: v[i][1], hash: v[i][2], question: String(v[i][7] || ''),
             asalt: String(v[i][8] || ''), ahash: String(v[i][9] || ''), tries: Number(v[i][10]) || 0, lock: Number(v[i][11]) || 0 };
  }
  return null;
}
function checkName_(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9 '.\-]{0,29}$/.test(name)) throw new Error('Names can use letters, numbers, spaces and - . \' (30 max)');
}
function itemsOf_(s, mine) {
  const n = s.getLastRow(), items = [];
  if (n < 2) return items;
  s.getRange(2, 1, n - 1, 7).getValues().forEach((r, i) => {
    const name = String(r[0]).trim(), by = String(r[6]).trim();
    if (!name || name.charAt(0) === '~') return;
    if (mine && by) return;                      // surprise gifts are hidden from the receiver
    items.push({
      row: i + 2, name: name, price: r[1], link: String(r[2] || ''), notes: String(r[3] || ''),
      bought: mine ? false : (by ? true : (r[5] === true || /^(true|yes|x)$/i.test(String(r[5]).trim()))),
      by: mine ? '' : by
    });
  });
  return items;
}
function norm_(a) { return String(a || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function checkPw_(pw) { if (String(pw || '').length < 6) throw new Error('Password must be at least 6 characters'); }
function setPassword_(u, pw) {
  const salt = Utilities.getUuid();
  tab_('_users').getRange(u.row, 2, 1, 2).setValues([[salt, hash_(salt, pw)]]);
}
function dropSessions_(name, keepToken) {
  const t = tab_('_sessions'), v = t.getDataRange().getValues();
  for (let i = v.length - 1; i >= 0; i--) if (v[i][0] && same_(v[i][1], name) && v[i][0] !== keepToken) { CacheService.getScriptCache().remove('s' + v[i][0]); t.deleteRow(i + 1); }
}
function newSession_(name) {
  const t = Utilities.getUuid() + Utilities.getUuid();
  tab_('_sessions').appendRow([t, name, new Date()]);
  return t;
}
function who_(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache(), hit = cache.get('s' + token);
  if (hit) return hit;
  const v = tab_('_sessions').getDataRange().getValues();
  for (let i = 0; i < v.length; i++) if (v[i][0] === token) { cache.put('s' + token, String(v[i][1]), 21600); return v[i][1]; }
  return null;
}
function makeList_(name) {
  const ns = ss_().insertSheet(name);
  ns.getRange(1, 1, 1, 7).setValues([['Gift names', 'Approx. price', 'Links', 'notes', '', 'Check if bought', 'Surprise gift from']]).setFontWeight('bold');
  ns.getRange(2, 6, 200, 1).insertCheckboxes();
  ns.setFrozenRows(1);
}

function groupsOf_(user) {
  const mem = tab_('_members').getDataRange().getValues().filter(r => r[0]);
  const mine = new Set(mem.filter(r => same_(r[1], user)).map(r => String(r[0])));
  if (!mine.size) return [];
  return tab_('_groups').getDataRange().getValues().filter(r => r[0] && mine.has(String(r[0])))
    .map(r => ({ code: String(r[0]), name: String(r[1]), members: mem.filter(m => String(m[0]) === String(r[0])).map(m => String(m[1])) }));
}
function newCode_() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', used = tab_('_groups').getDataRange().getValues().map(r => String(r[0]));
  let c;
  do { c = ''; for (let i = 0; i < 6; i++) c += chars.charAt(Math.floor(Math.random() * chars.length)); } while (used.indexOf(c) !== -1);
  return c;
}
function setBought_(s, row, val) { const c = s.getRange(row, 6); c.insertCheckboxes(); c.setValue(!!val); }
function rowCheck_(s, row, was) {
  row = Number(row);
  if (!(row >= 2) || row > s.getLastRow()) throw new Error('The list changed. Refreshing...');
  const r = s.getRange(row, 1, 1, 7).getValues()[0];
  if (String(r[0]).trim() !== String(was || '').trim()) throw new Error('The list changed. Refreshing...');
  return r;
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.payload) return out_({ error: 'Gift list backend is running.' });
  return handle_(JSON.parse(p.payload));
}
function doPost(e) { return handle_(JSON.parse(e.postData.contents)); }

function handle_(d) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return out_(act_(d)); }
  catch (err) { return out_({ error: String(err.message || err) }); }
  finally { lock.releaseLock(); }
}

function act_(d) {
  if (d.action === 'signup') {
    if (SIGNUP_CODE && d.code !== SIGNUP_CODE) throw new Error('Wrong family code');
    const name = String(d.name || '').trim();
    checkName_(name);
    checkPw_(d.password);
    if (findUser_(name)) throw new Error('That name is taken');
    let tab = ss_().getSheets().find(s => same_(s.getName(), name));
    const final = tab ? tab.getName() : name;
    if (!tab) makeList_(final);
    const salt = Utilities.getUuid();
    tab_('_users').appendRow([final, salt, hash_(salt, d.password)]);
    return { ok: true, token: newSession_(final), name: final };
  }
  if (d.action === 'getQuestion') {
    const u = findUser_(String(d.name || ''));
    if (!u || !u.question) throw new Error('No recovery question is set for that name. Ask the person who runs the site to reset it.');
    return { ok: true, question: u.question };
  }
  if (d.action === 'resetPassword') {
    const u = findUser_(String(d.name || '')), bad = new Error('That answer is not right');
    if (!u || !u.question) throw bad;
    if (u.lock > Date.now()) throw new Error('Too many tries. Try again in 15 minutes.');
    if (hash_(u.asalt, norm_(d.answer)) !== u.ahash) {
      const t = tab_('_users');
      if (u.tries + 1 >= 5) t.getRange(u.row, 11, 1, 2).setValues([[0, Date.now() + 15 * 60 * 1000]]);
      else t.getRange(u.row, 11).setValue(u.tries + 1);
      throw bad;
    }
    checkPw_(d.newPassword);
    setPassword_(u, String(d.newPassword));
    tab_('_users').getRange(u.row, 11, 1, 2).clearContent();
    dropSessions_(u.name, '');
    return { ok: true };
  }
  if (d.action === 'login') {
    const u = findUser_(String(d.name || ''));
    if (!u || u.hash !== hash_(u.salt, String(d.password || ''))) throw new Error('Wrong name or password');
    return { ok: true, token: newSession_(u.name), name: u.name };
  }

  const me = who_(d.token);
  if (!me) throw new Error('Please sign in');

  if (d.action === 'logout') {
    const t = tab_('_sessions'), v = t.getDataRange().getValues();
    for (let i = v.length - 1; i >= 0; i--) if (v[i][0] === d.token) t.deleteRow(i + 1);
    CacheService.getScriptCache().remove('s' + d.token);
    return { ok: true };
  }


  if (d.action === 'createGroup') {
    const name = String(d.name || '').trim().slice(0, 40);
    if (!name) throw new Error('Enter a group name');
    const code = newCode_();
    tab_('_groups').appendRow([code, name, me]);
    tab_('_members').appendRow([code, me]);
    return { ok: true, code: code };
  }
  if (d.action === 'joinGroup') {
    const code = String(d.code || '').trim().toUpperCase();
    const g = tab_('_groups').getDataRange().getValues().find(r => String(r[0]) === code);
    if (!code || !g) throw new Error('No group with that code');
    if (groupsOf_(me).some(x => x.code === code)) throw new Error('You are already in that group');
    tab_('_members').appendRow([code, me]);
    return { ok: true, name: String(g[1]) };
  }
  if (d.action === 'leaveGroup') {
    const code = String(d.code || '').trim().toUpperCase(), mt = tab_('_members'), v = mt.getDataRange().getValues();
    for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]) === code && same_(v[i][1], me)) mt.deleteRow(i + 1);
    if (!mt.getDataRange().getValues().some(r => String(r[0]) === code)) {
      const gt = tab_('_groups'), gv = gt.getDataRange().getValues();
      for (let i = gv.length - 1; i >= 0; i--) if (String(gv[i][0]) === code) gt.deleteRow(i + 1);
    }
    return { ok: true };
  }

  if (d.action === 'account') { const u = findUser_(me); return { name: me, question: u ? u.question : '' }; }
  if (d.action === 'changePassword' || d.action === 'setQuestion') {
    const u = findUser_(me);
    if (!u || u.hash !== hash_(u.salt, String(d.password || ''))) throw new Error('Current password is wrong');
    if (d.action === 'changePassword') {
      checkPw_(d.newPassword);
      setPassword_(u, String(d.newPassword));
      dropSessions_(me, d.token);   // signs out other devices
    } else {
      const q = String(d.question || '').trim().slice(0, 120), a = norm_(d.answer);
      const t = tab_('_users');
      if (!q && !a) t.getRange(u.row, 8, 1, 5).clearContent();
      else {
        if (q.length < 5) throw new Error('Write a longer question');
        if (a.length < 2) throw new Error('The answer is too short');
        const salt = Utilities.getUuid();
        t.getRange(u.row, 8, 1, 5).setValues([[q, salt, hash_(salt, a), 0, '']]);
      }
    }
    return { ok: true };
  }

  if (d.action === 'renameUser') {
    const u = findUser_(me);
    if (!u || u.hash !== hash_(u.salt, String(d.password || ''))) throw new Error('Current password is wrong');
    const nn = String(d.newName || '').trim();
    checkName_(nn);
    if (nn === u.name) return { ok: true, name: nn };
    const clash = findUser_(nn);
    if (clash && !same_(clash.name, me)) throw new Error('That name is taken');
    const own = ss_().getSheetByName(u.name);
    const other = ss_().getSheets().find(t => same_(t.getName(), nn));
    if (other && (!own || other.getSheetId() !== own.getSheetId())) throw new Error('That name is taken');
    const old = u.name;
    tab_('_sessions').getDataRange().getValues().forEach(r => { if (r[0] && same_(r[1], old)) CacheService.getScriptCache().remove('s' + r[0]); });
    const ut = tab_('_users');
    ut.getRange(u.row, 1).setValue(nn);
    if (own) own.setName(nn);
    [['_sessions', 2], ['_members', 2], ['_groups', 3]].forEach(([tab, col]) => {
      const t = tab_(tab), n = t.getLastRow();
      if (n < 1) return;
      const r = t.getRange(1, col, n, 1), v = r.getValues();
      r.setValues(v.map(x => [same_(x[0], old) ? nn : x[0]]));
    });
    people_().forEach(name => {            // surprise gifts this person added on other lists
      const t = ss_().getSheetByName(name), n = t.getLastRow();
      if (n < 2) return;
      const r = t.getRange(2, 7, n - 1, 1), v = r.getValues();
      if (v.some(x => same_(x[0], old))) r.setValues(v.map(x => [same_(x[0], old) ? nn : x[0]]));
    });
    return { ok: true, name: nn };
  }

  const groups = groupsOf_(me);
  const visible = {};
  visible[me.toLowerCase()] = true;
  groups.forEach(g => g.members.forEach(m => { visible[m.toLowerCase()] = true; }));
  const people = people_().filter(n => visible[n.toLowerCase()]);
  let tabName = people.find(n => same_(n, d.person || me));
  if (!tabName && (d.action === 'list' || d.action === 'listAll')) tabName = people.find(n => same_(n, me));
  if (!tabName) throw new Error('No such list');
  const s = ss_().getSheetByName(tabName);
  const mine = same_(tabName, me);

  if (d.action === 'list') {
    return { me: me, people: people, person: tabName, items: itemsOf_(s, mine), groups: groups };
  }
  if (d.action === 'listAll') {   // every visible list in one request, so switching people is instant
    const lists = {};
    people.forEach(n => { lists[n] = itemsOf_(ss_().getSheetByName(n), same_(n, me)); });
    return { me: me, people: people, person: tabName, lists: lists, groups: groups };
  }

  if (d.action === 'toggle') {
    if (mine) throw new Error('You can\'t tick items on your own list');
    const r = rowCheck_(s, d.row, d.was);
    if (String(r[6]).trim()) throw new Error('Surprise gifts are already marked bought');
    setBought_(s, Number(d.row), d.bought);
    return { ok: true };
  }

  if (d.action === 'delete' || d.action === 'save') {
    let row = d.row ? Number(d.row) : 0;
    if (row) {
      const by = String(rowCheck_(s, row, d.was)[6]).trim();
      if (mine && by) throw new Error('Not allowed');
      if (!mine && !same_(by, me)) throw new Error('You can only change your own surprise gifts');
    }
    if (d.action === 'delete') { s.deleteRow(row); return { ok: true }; }

    const name = String(d.name || '').trim().slice(0, 200);
    if (!name) throw new Error('Enter a gift name');
    if (!row) {
      const col = s.getRange(2, 1, Math.max(s.getLastRow() - 1, 1), 1).getValues();
      const i = col.findIndex(r => !String(r[0]).trim());
      row = i === -1 ? s.getLastRow() + 1 : i + 2;
      s.getRange(row, 7).setValue(mine ? '' : me);
      setBought_(s, row, !mine);
    }
    const price = parseFloat(String(d.price).replace(/[^0-9.]/g, ''));
    s.getRange(row, 1, 1, 4).setValues([[name, isNaN(price) ? '' : price, String(d.link || '').slice(0, 1000), String(d.notes || '').slice(0, 1000)]]);
    return { ok: true };
  }
  throw new Error('Unknown action');
}

// Optional: run once to turn existing "Check if bought" cells into checkboxes on every list tab.
function fixCheckboxes() {
  people_().forEach(name => {
    const s = ss_().getSheetByName(name), n = s.getLastRow();
    if (n < 2) return;
    const names = s.getRange(2, 1, n - 1, 1).getValues(), b = s.getRange(2, 6, n - 1, 1).getValues();
    names.forEach((r, i) => {
      const t = String(r[0]).trim();
      if (t && t.charAt(0) !== '~') setBought_(s, i + 2, b[i][0] === true || /^(true|yes|x)$/i.test(String(b[i][0]).trim()));
    });
  });
}

// If someone forgot their password and cannot answer their question, set their name and a new password
// below, select adminResetPassword > Run, then tell them the new password.
function adminResetPassword() {
  const NAME = '', NEW_PASSWORD = '';
  const u = findUser_(NAME);
  if (!u) throw new Error('No such user: ' + NAME);
  checkPw_(NEW_PASSWORD);
  setPassword_(u, NEW_PASSWORD);
  dropSessions_(u.name, '');
}

// Optional: run once to erase any old recovery emails saved by an earlier version of this script.
function clearOldEmails() {
  const t = tab_('_users'), n = t.getLastRow();
  if (n >= 1) t.getRange(1, 4, n, 4).clearContent();
}
