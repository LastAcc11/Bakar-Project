import { db, uid, exportBackup, parseBackup, useDatabase, takeLegacyData, dropLegacyData } from './db.js';
import * as cloud from './cloud.js';
import {
  REPORT_TYPES, ROLES, VISIT_REASONS, MANDATORY_STAGES, MAX_DAYS_BETWEEN_VISITS, VISIT_SECTION_DEFS,
  SIGNER_TITLES, DECLARATION, DEFAULT_SUMMARY, STATUS_ICONS, LEVEL_INFO, SEVERITY, LIKELIHOOD, finalRisk,
  newReportData, migrateVisitData, newCustomForm, defaultItemsText, rid,
} from './templates.js';
import { buildModel, formatDate, contactOf } from './model.js';
import { renderPaper, matrixTable, esc } from './render-html.js';
import { exportDocx } from './export-docx.js';
import { exportPdf } from './export-pdf.js';
import { SignaturePad } from './signature.js';

// ---------------- state ----------------
// עבודה "מקומית קודם": כל שמירה נכתבת מיד למכשיר (IndexedDB) ובמקביל נשלחת לענן (Firebase).
// שינויים שמגיעים מהענן (ממכשיר אחר) ממוזגים לפי זמן העדכון האחרון.
const state = { settings: null, sites: [], reports: [], user: undefined, online: navigator.onLine, access: { admin: false, status: 'open' } };
// מצב תצוגה זמני (לא נשמר)
const ui = { editList: null, openNotes: new Set(), askSent: null, reportsMode: 'all', addRecipient: false, admin: null };
const $view = document.getElementById('view');
const today = () => new Date().toISOString().slice(0, 10);
const DAY = 86400000;
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY);
const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const arr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

const DEFAULT_SETTINGS = {
  inspector: { name: '', title: SIGNER_TITLES[0], phone: '', email: '', signature: '' },
  company: { name: '', slogan: '', logo: '' },
  defaultSummary: DEFAULT_SUMMARY,
  // תפוצה: נמענים קבועים לכל סוג דוח. אם ריק — נלקחים הנמענים האחרונים ששלחת אליהם
  distribution: { includeSelf: true, visit: [], risk: [], custom: [] },
  lastRecipients: { visit: [], risk: [], custom: [] },
  templates: {}, // רשימות בדיקה מותאמות לדוח ביקור, לפי מפתח סעיף
  customForms: [],
  printDefaults: { hideUnmarked: false, hideEmptySections: false }, // נזכר מהבחירה האחרונה
  updatedAt: 0,
};

function normalizeSettings(saved) {
  const s = saved || {};
  const dist = s.distribution || {};
  const last = s.lastRecipients || {};
  return {
    ...DEFAULT_SETTINGS, ...s,
    inspector: { ...DEFAULT_SETTINGS.inspector, ...s.inspector },
    company: { ...DEFAULT_SETTINGS.company, ...s.company },
    distribution: { includeSelf: dist.includeSelf !== false, visit: arr(dist.visit), risk: arr(dist.risk), custom: arr(dist.custom) },
    lastRecipients: { visit: arr(last.visit), risk: arr(last.risk), custom: arr(last.custom) },
    templates: s.templates || {},
    customForms: arr(s.customForms).map((f) => ({ ...f, sections: arr(f.sections).map((x) => ({ ...x, labels: { ...x.labels } })) })),
    printDefaults: { ...DEFAULT_SETTINGS.printDefaults, ...s.printDefaults },
  };
}

// Realtime Database לא שומר מערכים/אובייקטים ריקים — משלימים ברירות מחדל לדוח שהגיע מהענן
function normalizeSections(sections) {
  return arr(sections).map((sec) => ({
    ...sec,
    labels: { ok: 'תקין', bad: 'לא תקין', na: 'לא רלוונטי', ...sec.labels },
    rows: arr(sec.rows).map((row) => ({ status: '', note: '', level: 0, ...row, id: row.id || rid() })),
    text: sec.text || '',
  }));
}
function normalizeReport(r) {
  let data = { ...r.data };
  if (r.type === 'visit') {
    data = migrateVisitData(data);
    data = { ...newReportData('visit'), ...data, sections: normalizeSections(data.sections), reasons: arr(data.reasons) };
  } else if (r.type === 'custom') {
    data = { ...newReportData('custom', { form: { sections: [] } }), ...data, sections: normalizeSections(data.sections) };
  } else {
    data = { ...newReportData('risk'), ...data };
  }
  const recipients = r.recipients ? arr(r.recipients) : undefined;
  return { ...r, data, photos: arr(r.photos), inspector: r.inspector || {}, recipients };
}

async function load() {
  state.settings = normalizeSettings(await db.getKV('settings', null));
  state.sites = await db.all('sites');
  state.reports = (await db.all('reports')).map(normalizeReport);
}
const site = (id) => state.sites.find((s) => s.id === id);
const report = (id) => state.reports.find((r) => r.id === id);
// טיוטה שנפתחה ועוד לא נערכה לא נחשבת דוח (סעיף 18) — היא נמחקת אם יוצאים בלי לשנות דבר
const savedReports = () => state.reports.filter((r) => !r._draft);
const reportTitle = (r) => (r.type === 'custom' ? r.data.formTitle || 'טופס' : REPORT_TYPES[r.type].name);

// ---------------- cloud on/off (נשמר במכשיר) ----------------
const cloudEnabled = () => {
  try { return localStorage.getItem('bakar-cloud') !== 'off'; } catch { return true; }
};

// כתיבה לענן "ברקע": אם אין רשת, ה-SDK של Firebase שומר בתור ושולח כשהחיבור חוזר
function toCloud(promise) {
  promise?.catch?.((err) => {
    console.error(err);
    if (err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message)) toast('אין הרשאה לשמור בענן — בדוק את כללי ה-Database', 'danger');
  });
}

async function saveSettings() {
  state.settings.updatedAt = Date.now();
  await db.setKV('settings', state.settings);
  toCloud(cloud.pushSettings(state.settings));
}
// _synced = השרת אישר שהפריט קיים בענן. פריט כזה שנעלם מהענן — נמחק ממכשיר אחר.
// מסמנים _synced רק אם באמת נשלח (הסנכרון פעיל) — אחרת פריט שנשמר לפני ההתחברות לענן היה נחשב "נמחק במכשיר אחר"
function pushSiteNow(s) {
  if (!cloud.isSyncing()) return Promise.resolve();
  return cloud.pushSite(s).then(() => {
    if (!s._synced) return db.put('sites', Object.assign(s, { _synced: true }));
  });
}
function pushReportNow(r) {
  if (!cloud.isSyncing()) return Promise.resolve();
  return cloud.pushReport(r).then((uploadedPhotos) => {
    if (uploadedPhotos || !r._synced) return db.put('reports', Object.assign(r, { _synced: true }));
  });
}
async function saveSite(s) {
  s.updatedAt = Date.now();
  if (!state.sites.includes(s)) state.sites.push(s);
  await db.put('sites', s);
  toCloud(pushSiteNow(s));
  reportUsage();
}
async function saveReport(r, { keepTime = false } = {}) {
  if (!keepTime) r.updatedAt = Date.now();
  delete r._draft;
  if (!state.reports.includes(r)) state.reports.push(r);
  await db.put('reports', r);
  toCloud(pushReportNow(r));
  reportUsage();
}
// ייבוא נתונים (משחזור גיבוי או מהגרסה המקומית הישנה) — נשמרים במכשיר ונשלחים לענן
async function importData(data) {
  for (const s of data.sites || []) {
    const cur = site(s.id);
    if (cur) Object.assign(cur, s);
    await saveSite(cur || { ...s, _synced: false });
  }
  for (const r of data.reports || []) {
    const item = normalizeReport({ ...r, _synced: false });
    item.photos.forEach((p) => delete p._up);
    const i = state.reports.findIndex((x) => x.id === r.id);
    if (i >= 0) state.reports[i] = item;
    await saveReport(item);
  }
  for (const f of data.files || []) {
    await db.put('files', f);
    if (cloud.isSyncing()) toCloud(cloud.pushFile(f.id, f.data));
  }
  const settings = (data.kv || []).find((k) => k.key === 'settings')?.value;
  if (settings) {
    state.settings = normalizeSettings(settings);
    await saveSettings();
  }
}

async function deleteReport(r) {
  state.reports = state.reports.filter((x) => x.id !== r.id);
  if (r._draft) return;
  if (r.shareToken && cloud.isSyncing()) toCloud(cloud.removeShared(r.shareToken));
  await db.del('reports', r.id);
  toCloud(cloud.removeReport(r));
}
async function deleteSite(id) {
  for (const r of state.reports.filter((x) => x.siteId === id)) await deleteReport(r);
  state.sites = state.sites.filter((x) => x.id !== id);
  await db.del('sites', id);
  toCloud(cloud.removeSite(id));
}

// ---------------- sync from cloud ----------------
const userIsTyping = () => document.activeElement?.matches?.('input, textarea, select');
const scheduleRender = debounce(() => {
  if (state.user && !userIsTyping()) rerender();
}, 150);

async function mergeCollection(store, list, remoteMap, { onApply, push }) {
  let changed = false;
  for (const [id, remote] of Object.entries(remoteMap)) {
    const i = list.findIndex((x) => x.id === id);
    const local = list[i];
    if (!local || (remote.updatedAt || 0) > (local.updatedAt || 0)) {
      const item = await onApply({ ...remote, id, _synced: true }, local);
      if (i >= 0) list[i] = item;
      else list.push(item);
      await db.put(store, item);
      changed = true;
    } else if ((local.updatedAt || 0) > (remote.updatedAt || 0) && !local._draft) {
      toCloud(push(local)); // שינוי מקומי שנעשה בלי רשת
    }
  }
  for (const local of [...list]) {
    if (remoteMap[local.id] || local._draft) continue;
    if (local._synced) {
      // נמחק ממכשיר אחר
      list.splice(list.indexOf(local), 1);
      await db.del(store, local.id);
      changed = true;
    } else {
      toCloud(push(local)); // נוצר במכשיר הזה כשלא היה חיבור
    }
  }
  return changed;
}

async function withPhotos(remote, local) {
  const r = normalizeReport(remote);
  const localSrc = new Map((local?.photos || []).map((p) => [p.id, p.src]));
  for (const p of r.photos) {
    p._up = true;
    p.src = localSrc.get(p.id) || (await cloud.fetchPhoto(p.id).catch(() => null)) || '';
  }
  r.photos = r.photos.filter((p) => p.src);
  return r;
}

function startCloudSync(user) {
  cloud.startSync(user.uid, {
    async settings(remote) {
      if (remote && (remote.updatedAt || 0) > (state.settings.updatedAt || 0)) {
        state.settings = normalizeSettings(remote);
        await db.setKV('settings', state.settings);
        scheduleRender();
      } else if (!remote || (state.settings.updatedAt || 0) > (remote.updatedAt || 0)) {
        toCloud(cloud.pushSettings(state.settings));
      }
    },
    async sites(map) {
      const changed = await mergeCollection('sites', state.sites, map, { onApply: (x) => x, push: pushSiteNow });
      if (changed) scheduleRender();
    },
    async reports(map) {
      const changed = await mergeCollection('reports', state.reports, map, { onApply: withPhotos, push: pushReportNow });
      if (changed) scheduleRender();
    },
    connection(online) {
      state.online = online;
      updateSyncBadge();
    },
    error(err) {
      console.error(err);
      toast('אין הרשאת גישה לנתונים בענן — בדוק את כללי ה-Database', 'danger');
    },
  });
}

function updateSyncBadge() {
  const el = document.getElementById('sync');
  if (!el) return;
  el.hidden = !state.user;
  const local = !cloudEnabled();
  el.className = `sync ${local ? 'local' : state.online ? 'on' : 'off'}`;
  el.title = local ? 'שמירה בענן כבויה — הנתונים נשמרים רק במכשיר הזה'
    : state.online ? 'מחובר — הנתונים נשמרים בענן' : 'אין חיבור — הנתונים נשמרים במכשיר ויסונכרנו כשהחיבור יחזור';
  el.querySelector('span').textContent = local ? 'במכשיר בלבד' : state.online ? 'מסונכרן' : 'לא מקוון';
}

// ---------------- utils ----------------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = val;
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}

async function compressImage(file, max = 1400, type = 'image/jpeg', quality = 0.78) {
  const url = await readFileAsDataURL(file);
  const img = new Image();
  await new Promise((r, j) => ((img.onload = r), (img.onerror = j), (img.src = url)));
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k);
  const h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  return { src: c.toDataURL(type, quality), w, h };
}

function pickFiles({ multiple = true, capture = false } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = multiple;
    if (capture) inp.capture = 'environment';
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

// מספר טלפון ישראלי → פורמט בינלאומי לוואטסאפ (050-1234567 → 972501234567)
function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `972${d.slice(1)}`;
  return d;
}
const isMobile = () => matchMedia('(pointer: coarse)').matches;

// ---------------- site analytics ----------------
function siteStats(s) {
  const reps = savedReports().filter((r) => r.siteId === s.id);
  const visits = reps.filter((r) => r.type === 'visit' && r.visitDate);
  const risks = reps.filter((r) => r.type === 'risk');
  const stages = new Set(visits.flatMap((v) => v.data.reasons || []));
  const last = visits.map((v) => v.visitDate).sort().pop() || null;
  // תדירות שסוכמה עם המזמין (אם הוגדרה) — אבל לא יותר מ-3 חודשים לפי החוק
  const interval = Math.min(MAX_DAYS_BETWEEN_VISITS, parseInt(s.internal?.frequencyDays, 10) || MAX_DAYS_BETWEEN_VISITS);
  const due = last ? addDays(last, interval) : null;
  const left = due ? daysBetween(today(), due) : null;
  return { reps, visits, risks, stages, last, due, left, interval };
}

function dueChip(st) {
  if (!st.last) return '<span class="chip">טרם בוצע ביקור</span>';
  if (st.left < 0) return `<span class="chip danger">באיחור של ${-st.left} ימים</span>`;
  if (st.left <= 14) return `<span class="chip warn">ביקור הבא בעוד ${st.left} ימים</span>`;
  return `<span class="chip ok">ביקור הבא עד ${formatDate(st.due)}</span>`;
}

function stageDots(st) {
  return `<div class="stages">${VISIT_REASONS.filter((r) => MANDATORY_STAGES.includes(r.id))
    .map((r) => `<span class="stage ${st.stages.has(r.id) ? 'done' : ''}" title="${esc(r.label)}">${st.stages.has(r.id) ? '✓' : '○'} ${esc(r.short)}</span>`)
    .join('')}</div>`;
}

function reportDeadline(r) {
  if (r.status === 'sent') return null;
  if (r.type === 'risk') return { label: 'להפצה מיידית', kind: 'danger' };
  if (r.type !== 'visit' || !r.visitDate) return null;
  // 48 שעות ממועד הביקור — שעת הביקור לא נשמרת, לכן מחשבים לפי תאריך: עד יומיים אחרי יום הביקור
  const due = addDays(r.visitDate, REPORT_TYPES.visit.deadlineHours / 24);
  const left = daysBetween(today(), due);
  if (left < 0) return { label: `עבר מועד ההפצה (${formatDate(due)})`, kind: 'danger' };
  return { label: left === 0 ? 'להפצה עד היום' : `להפצה עד ${formatDate(due)}`, kind: left === 0 ? 'warn' : '' };
}

const typeIcon = (r) => (r.type === 'risk' ? '⚠' : r.type === 'custom' ? '☑' : '▤');
function reportRow(r, { showClient = false } = {}) {
  const s = site(r.siteId);
  const dl = reportDeadline(r);
  const client = showClient ? contactOf(s, 'client').name : '';
  return `<a class="row" href="#/r/${r.id}/${r.status === 'sent' ? 'preview' : '0'}">
    <span class="row-ico ${r.type}">${typeIcon(r)}</span>
    <span class="row-main"><b>${esc(s?.name || 'אתר ללא שם')}</b><small>${esc(reportTitle(r))}${r.number ? ` #${esc(r.number)}` : ''} · ${formatDate(r.visitDate)}${client ? ` · ${esc(client)}` : ''}</small></span>
    <span class="row-end">${r.status === 'sent' ? `<span class="chip ok">הופץ${r.sentAt ? ` ${formatDate(new Date(r.sentAt).toISOString())}` : ''}</span>` : dl ? `<span class="chip ${dl.kind}">${dl.label}</span>` : '<span class="chip">טיוטה</span>'}</span>
  </a>`;
}

// ---------------- views ----------------
function viewHome() {
  const name = state.settings.inspector.name;
  const reps = savedReports();
  const pending = reps.filter((r) => r.status !== 'sent').sort((a, b) => b.updatedAt - a.updatedAt);
  const sent = reps.filter((r) => r.status === 'sent').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const sites = [...state.sites].map((s) => ({ s, st: siteStats(s) }));
  const overdue = sites.filter(({ st }) => st.last && st.left <= 14);
  sites.sort((a, b) => (a.st.left ?? 1e9) - (b.st.left ?? 1e9));
  const forms = state.settings.customForms;

  return `
  <section class="hero">
    <div class="prompt"><span class="caret">❯</span> שלום${name ? `, ${esc(name)}` : ''}</div>
    <p class="muted">מה מתעדים היום?</p>
    <div class="actions">
      <a class="action" href="#/new/visit"><span class="action-ico">▤</span><span><b>דו"ח ביקור</b><small>ביקורת שלב / רבעונית · הפצה תוך 48 ש'</small></span></a>
      <a class="action danger" href="#/new/risk"><span class="action-ico">⚠</span><span><b>סיכון בלתי קביל</b><small>הודעה מיידית לכל המכותבים</small></span></a>
    </div>
    <div class="form-chips">${forms.map((f) => `<a class="chip-btn" href="#/new/custom/${f.id}">☑ ${esc(f.name)}</a>`).join('')}
      <a class="chip-btn ghost" href="#/forms">${forms.length ? '⚙ טפסים מותאמים' : '+ טופס מותאם (צ\'ק ליסט משלך)'}</a></div>
  </section>
  ${!name || !state.settings.inspector.signature ? `<a class="banner" href="#/settings">⚙ השלם את פרופיל הבקר (שם, תואר וחתימה) — הם ייכנסו אוטומטית לכל דוח ←</a>` : ''}
  ${overdue.length ? `<section class="panel"><h2 class="panel-h">⏱ תזכורות ביקור <small>לפחות אחת ל-3 חודשים</small></h2>
    ${overdue.map(({ s, st }) => `<a class="row" href="#/sites/${s.id}"><span class="row-main"><b>${esc(s.name)}</b><small>ביקור אחרון ${formatDate(st.last)}</small></span><span class="row-end">${dueChip(st)}</span></a>`).join('')}
  </section>` : ''}
  <section class="panel"><h2 class="panel-h">טיוטות וממתינים להפצה <small>${pending.length}</small></h2>
    ${pending.length ? pending.map((r) => reportRow(r)).join('') : '<p class="empty">אין דוחות פתוחים 🎉</p>'}
  </section>
  <section class="panel"><h2 class="panel-h">אתרים <a class="link" href="#/sites">כל האתרים ←</a></h2>
    ${sites.length ? sites.slice(0, 6).map(({ s, st }) => `<a class="site-card" href="#/sites/${s.id}">
        <div class="site-top"><b>${esc(s.name || 'ללא שם')}</b>${dueChip(st)}</div>
        <small class="muted">${esc(s.address || '')}</small>${stageDots(st)}</a>`).join('')
      : '<p class="empty">עוד לא נוספו אתרים. אתר נוצר אוטומטית כשפותחים דוח ראשון.</p>'}
  </section>
  ${sent.length ? `<section class="panel"><h2 class="panel-h">הופצו לאחרונה <a class="link" href="#/reports">כל הדוחות ←</a></h2>${sent.map((r) => reportRow(r)).join('')}</section>` : ''}`;
}

function viewNew(type, formId) {
  const form = type === 'custom' ? state.settings.customForms.find((f) => f.id === formId) : null;
  if (type === 'custom' && !form) return notFound();
  const name = form ? form.name : REPORT_TYPES[type].name;
  const sites = [...state.sites].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const attrs = `data-type="${type}"${form ? ` data-form="${form.id}"` : ''}`;
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>${esc(name)} — חדש</h1></div>
  <section class="panel">
    <h2 class="panel-h">באיזה אתר?</h2>
    <form class="inline-form" data-action="new-site-report" ${attrs}>
      <input name="name" placeholder="שם אתר חדש…" required autocomplete="off">
      <button class="btn primary">צור ←</button>
    </form>
    ${sites.map((s) => {
      const st = siteStats(s);
      const client = contactOf(s, 'client').name;
      return `<button class="row" data-action="new-report" ${attrs} data-site="${s.id}">
        <span class="row-main"><b>${esc(s.name)}</b><small>${esc([s.address, client].filter(Boolean).join(' · '))}${st.last ? ` · ביקור אחרון ${formatDate(st.last)}` : ''}</small></span>
        <span class="row-end">←</span></button>`;
    }).join('')}
  </section>`;
}

function viewSites() {
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>אתרים</h1><button class="btn" data-action="add-site">+ אתר חדש</button></div>
  <section class="panel">
  ${state.sites.length ? state.sites.map((s) => {
    const st = siteStats(s);
    return `<a class="site-card" href="#/sites/${s.id}"><div class="site-top"><b>${esc(s.name || 'ללא שם')}</b>${dueChip(st)}</div>
      <small class="muted">${esc([s.address, contactOf(s, 'client').name].filter(Boolean).join(' · '))} · ${st.visits.length} ביקורים · ${st.risks.length} הודעות סיכון</small>${stageDots(st)}</a>`;
  }).join('') : '<p class="empty">אין אתרים עדיין</p>'}
  </section>`;
}

function contactFields(s, role) {
  const c = contactOf(s, role);
  return `<fieldset class="contact"><legend>${ROLES[role]}</legend>
    <div class="two">
      <input data-sbind="${role}.name" value="${esc(c.name)}" placeholder="שם / חברה">
      <input data-sbind="${role}.idNumber" value="${esc(c.idNumber || '')}" placeholder="ח.פ. / ת.ז." inputmode="numeric" dir="ltr">
    </div>
    <div class="two">
      <input data-sbind="${role}.phone" value="${esc(c.phone || '')}" placeholder="נייד (וואטסאפ)" type="tel" dir="ltr" inputmode="tel">
      <input data-sbind="${role}.email" value="${esc(c.email || '')}" placeholder="אימייל" type="email" dir="ltr" inputmode="email">
    </div></fieldset>`;
}

function siteForm(s) {
  return `
    <label class="field"><span>שם האתר</span><input data-sbind="name" value="${esc(s.name || '')}" placeholder="לדוגמה: מגדלי הים, בניין B"></label>
    <label class="field"><span>מען / מיקום האתר</span><input data-sbind="address" value="${esc(s.address || '')}" placeholder="רחוב, עיר / גוש-חלקה"></label>
    <div class="contacts">${Object.keys(ROLES).map((r) => contactFields(s, r)).join('')}</div>`;
}

function newReportButtons(s) {
  return `<div class="actions compact">
      <button class="action" data-action="new-report" data-type="visit" data-site="${s.id}"><span class="action-ico">▤</span><b>דו"ח ביקור</b></button>
      <button class="action danger" data-action="new-report" data-type="risk" data-site="${s.id}"><span class="action-ico">⚠</span><b>סיכון בלתי קביל</b></button>
    </div>
    ${state.settings.customForms.length ? `<div class="form-chips">${state.settings.customForms.map((f) => `<button class="chip-btn" data-action="new-report" data-type="custom" data-form="${f.id}" data-site="${s.id}">☑ ${esc(f.name)}</button>`).join('')}</div>` : ''}`;
}

// לשונית "כללי" פנימית לאתר — לא מודפסת בדוחות (רמת בקרה שסוכמה, הערות, חוזה בקר)
const CONTROL_LEVELS = [
  'בקרה מינימלית — לפי הנדרש בחוק',
  'בקרה מוגברת — מעבר לנדרש בחוק, לפי תיאום',
  'בקרה מקסימלית — ביקורים תכופים',
];
function fileSize(n) {
  return n > 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`;
}
function siteInternal(s) {
  const it = s.internal || {};
  const custom = it.controlLevel && !CONTROL_LEVELS.includes(it.controlLevel);
  const files = arr(s.files);
  return `<section class="panel internal" data-site-id="${s.id}">
    <h2 class="panel-h">🔒 כללי — פנימי <small>לא מודפס בדוחות</small></h2>
    <div class="grid2">
      <label class="field"><span>רמת הבקרה שסוכמה עם המזמין</span>
        <select data-sbind="internal.controlLevel" data-rerender-site="1">
          <option value="" ${!it.controlLevel ? 'selected' : ''}>— לא הוגדר —</option>
          ${CONTROL_LEVELS.map((l) => `<option ${it.controlLevel === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          <option value="__custom" ${custom ? 'selected' : ''}>אחר…</option>
        </select></label>
      <label class="field"><span>תדירות ביקורים מוסכמת (ימים) <small class="muted">— התזכורת תתאים את עצמה</small></span>
        <input data-sbind="internal.frequencyDays" value="${esc(it.frequencyDays || '')}" inputmode="numeric" placeholder="למשל 30"></label>
    </div>
    ${custom || it.controlLevel === '__custom' ? `<label class="field"><span>תיאור רמת הבקרה</span><input data-sbind="internal.controlLevelText" value="${esc(it.controlLevelText || (custom ? it.controlLevel : ''))}"></label>` : ''}
    <label class="field"><span>הערות פנימיות</span><textarea data-sbind="internal.notes" rows="4" placeholder="סיכומים עם המזמין, תנאים מיוחדים, שכר טרחה…">${esc(it.notes || '')}</textarea></label>
    <div class="field"><span>קבצים מצורפים לאתר <small class="muted">(חוזה בקר, תוכנית בטיחות… עד 8MB לקובץ)</small></span>
      ${files.length ? files.map((f) => `<div class="file-row"><span class="file-ico">📄</span><span class="row-main"><b>${esc(f.name)}</b><small>${fileSize(f.size)} · ${formatDate(new Date(f.at).toISOString())}</small></span>
        <button class="btn small" data-action="file-open" data-site="${s.id}" data-id="${f.id}">פתח</button>
        <button class="icon-btn2" data-action="file-remove" data-site="${s.id}" data-id="${f.id}" aria-label="מחק">✕</button></div>`).join('') : '<p class="muted tiny">אין קבצים</p>'}
      <button class="btn small" data-action="file-add" data-site="${s.id}">📎 צרף קובץ</button>
    </div>
  </section>`;
}

function viewSite(id) {
  const s = site(id);
  if (!s) return notFound();
  const st = siteStats(s);
  const reps = st.reps.sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
  return `
  <div class="page-h"><a class="back" href="#/sites">→</a><h1>${esc(s.name || 'אתר')}</h1></div>
  <section class="panel">
    <div class="site-top">${stageDots(st)}${dueChip(st)}</div>
    ${newReportButtons(s)}
  </section>
  <section class="panel" data-site-id="${s.id}"><h2 class="panel-h">פרטי האתר ואנשי קשר <small class="saved" id="saved"></small></h2>${siteForm(s)}</section>
  ${siteInternal(s)}
  <section class="panel"><h2 class="panel-h">דוחות <small>${reps.length}</small></h2>${reps.length ? reps.map((r) => reportRow(r)).join('') : '<p class="empty">אין דוחות לאתר זה</p>'}</section>
  <button class="btn ghost danger-text" data-action="delete-site" data-site="${s.id}">מחק אתר</button>`;
}

// כל הדוחות — רשימה רגילה, או מקובצים לפי מזמין העבודה מכל האתרים שלו (סעיף 5)
function reportListHTML(q = '') {
  const match = (r) => {
    if (!q) return true;
    const s = site(r.siteId);
    return [s?.name, contactOf(s, 'client').name, reportTitle(r)].some((x) => (x || '').includes(q));
  };
  const reps = savedReports().filter(match).sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
  if (!reps.length) return '<p class="empty">לא נמצאו דוחות</p>';
  if (ui.reportsMode !== 'client') return reps.map((r) => reportRow(r, { showClient: true })).join('');
  const groups = new Map();
  for (const r of reps) {
    const c = contactOf(site(r.siteId), 'client');
    const key = (c.name || '').trim() || 'ללא מזמין';
    if (!groups.has(key)) groups.set(key, { c, reps: [], sites: new Set() });
    groups.get(key).reps.push(r);
    groups.get(key).sites.add(r.siteId);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'he')).map(([name, g]) => `
    <div class="group">
      <div class="group-h"><b>${esc(name)}</b>${g.c.idNumber ? `<small>ח.פ./ת.ז. ${esc(g.c.idNumber)}</small>` : ''}<span class="chip">${g.sites.size} אתרים · ${g.reps.length} דוחות</span></div>
      ${g.reps.map((r) => reportRow(r)).join('')}
    </div>`).join('');
}

function viewReports() {
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>כל הדוחות</h1></div>
  <section class="panel">
    <div class="tabs" role="tablist">
      <button class="tab ${ui.reportsMode === 'all' ? 'on' : ''}" data-action="reports-mode" data-mode="all">כל הדוחות</button>
      <button class="tab ${ui.reportsMode === 'client' ? 'on' : ''}" data-action="reports-mode" data-mode="client">לפי מזמין</button>
    </div>
    <input class="search" placeholder="חיפוש לפי אתר / מזמין…" data-action="filter-reports">
    <div id="report-list">${reportListHTML()}</div>
  </section>`;
}

// ---------- report editor ----------
function getSteps(r) {
  if (r.type === 'risk') {
    return [{ id: 'details', name: 'פרטים' }, { id: 'matrix', name: 'הערכת סיכון' }, { id: 'actions', name: 'מענה ופעולות' },
      { id: 'sign', name: 'חתימה' }, { id: 'photos', name: 'תמונות' }];
  }
  if (r.type === 'visit') {
    return [{ id: 'details', name: 'פרטים' }, { id: 'sec', keys: ['docs', 'checks'], name: 'טרום עבודה' }, { id: 'reason', name: 'סיבת הביקור' },
      { id: 'sec', keys: ['risks'], name: 'מענים לסיכונים' }, { id: 'sec', keys: ['ppe'], name: 'ציוד מגן' },
      { id: 'sec', keys: ['training'], name: 'הדרכות' }, { id: 'sign', name: 'סיכום וחתימה' }, { id: 'photos', name: 'תמונות' }];
  }
  const short = (t) => (t.length > 18 ? `${t.slice(0, 17)}…` : t);
  return [{ id: 'details', name: 'פרטים' }, ...r.data.sections.map((s) => ({ id: 'sec', keys: [s.key], name: short(s.title || 'סעיף') })),
    { id: 'sign', name: 'סיכום וחתימה' }, { id: 'photos', name: 'תמונות' }];
}
const STATUS_LABEL_NAMES = { ok: 'חיובי', bad: 'שלילי', na: 'שלישי' };
const secIndex = (r, key) => r.data.sections.findIndex((s) => s.key === key);
const activeRows = (sec) => sec.rows.filter((x) => !x.hidden && !x.header);

function stepProgress(r, step) {
  const d = r.data;
  switch (step.id) {
    case 'details': return !!site(r.siteId)?.name && !!r.visitDate;
    case 'sec': return step.keys.every((k) => {
      const sec = d.sections[secIndex(r, k)];
      const rows = sec ? activeRows(sec) : [];
      return rows.length > 0 && rows.every((x) => x.status);
    });
    case 'reason': return d.reasons.length > 0;
    case 'matrix': return !!((d.severity && d.likelihood) || d.levelOverride) && !!d.riskText.trim();
    case 'actions': return !!(d.requiredResponse.trim() || d.correctiveActions.trim());
    case 'sign': return !!(r.inspector?.name && r.inspector?.signature);
    case 'photos': return (r.photos || []).length > 0;
  }
  return false;
}

function photoActions(ref, caption, small = true) {
  const cls = small ? 'link-btn' : 'btn small';
  return `<button class="${cls}" data-action="add-photo" data-capture="1" data-ref="${esc(ref)}" data-caption="${esc(caption)}">📷 צלם</button>
    <button class="${cls}" data-action="add-photo" data-ref="${esc(ref)}" data-caption="${esc(caption)}">🖼 מהגלריה</button>`;
}
function thumbs(r, ref) {
  const pics = r.photos.filter((p) => p.ref === ref);
  if (!pics.length) return '';
  return `<div class="thumbs">${pics.map((p) => `<span class="thumb"><img src="${p.src}" alt=""><button data-action="del-photo" data-id="${p.id}" aria-label="מחק תמונה">✕</button></span>`).join('')}</div>`;
}

function triRow(r, si, j, x, sec) {
  const p = `data.sections.${si}.rows.${j}`;
  const ref = `${sec.key}:${x.id}`;
  const open = x.status === 'bad' || (x.note || '').trim() || ui.openNotes.has(x.id);
  return `<div class="tri-row ${x.status ? `is-${x.status}` : ''} lvl${x.level || 0}" role="listitem">
    <div class="tri-label">${esc(x.label)}</div>
    <div class="seg" role="radiogroup">${['ok', 'bad', 'na'].map((k) => `<button class="seg-${k} ${x.status === k ? 'on' : ''}" data-action="tri" data-path="${p}" data-val="${k}" role="radio" aria-checked="${x.status === k}">${STATUS_ICONS[k]}<span>${esc(sec.labels[k])}</span></button>`).join('')}</div>
    <div class="tri-extra">
      ${open ? `<textarea data-bind="${p}.note" rows="2" placeholder="${x.status === 'bad' ? 'פירוט הליקוי / מה חסר…' : 'הערה — למשל מה לא מושלם…'}">${esc(x.note)}</textarea>` : ''}
      ${thumbs(r, ref)}
      <div class="tri-note-actions">
        ${!open ? `<button class="link-btn" data-action="open-note" data-id="${x.id}" data-path="${p}">💬 הערה</button>` : ''}
        ${photoActions(ref, x.label)}
        ${r.type === 'visit' && x.status === 'bad' ? `<button class="link-btn danger" data-action="escalate" data-path="${p}">⚠ הודעת סיכון בלתי קביל</button>` : ''}
      </div>
    </div>
  </div>`;
}

function editRow(si, j, x) {
  const p = `data.sections.${si}.rows.${j}`;
  return `<div class="edit-row ${x.hidden ? 'is-hidden' : ''} ${x.header ? 'is-header' : ''} lvl${x.level || 0}">
    <input data-bind="${p}.label" value="${esc(x.label)}" ${x.hidden ? 'disabled' : ''} placeholder="${x.header ? 'כותרת קבוצה' : 'נוסח השורה'}">
    ${x.hidden
      ? `<button class="btn small" data-action="row-restore" data-path="${p}">↺ החזר</button>`
      : `<button class="icon-btn2" data-action="row-hide" data-path="${p}" data-si="${si}" data-j="${j}" title="הסר מהדוח" aria-label="הסר שורה">✕</button>`}
  </div>`;
}

function sectionEditor(r, si, { showTitle }) {
  const sec = r.data.sections[si];
  const editing = ui.editList === `${r.id}:${sec.key}`;
  const rows = activeRows(sec);
  const count = (k) => rows.filter((x) => x.status === k).length;
  const hiddenN = sec.rows.filter((x) => x.hidden).length;
  return `<div class="sec">
    ${showTitle ? `<h3 class="step-sub">${esc(sec.title)}</h3>` : ''}
    <div class="tri-tools">
      <span class="tri-count"><span class="ok">✓ ${count('ok')}</span><span class="bad">✗ ${count('bad')}</span><span class="na">— ${count('na')}</span></span>
      <span class="row-btns tight">
        ${!editing ? `<button class="btn small" data-action="tri-fill" data-si="${si}">סמן נותרים "${esc(sec.labels.ok)}"</button>` : ''}
        <button class="btn small ${editing ? 'primary' : ''}" data-action="edit-list" data-key="${sec.key}">${editing ? '✓ סיום עריכה' : `✎ ערוך רשימה${hiddenN ? ` (${hiddenN} הוסרו)` : ''}`}</button>
      </span>
    </div>
    ${editing ? `<p class="muted tiny">שנה את נוסח הסעיף והשורות, הסר שורות שלא רלוונטיות או הוסף שורות. השינוי חל על הדוח הזה בלבד. את רשימת ברירת המחדל לדוחות הבאים קובעים ב<a class="link" href="#/settings">הגדרות</a>.</p>
    <div class="sec-edit">
      <label class="field"><span>נוסח כותרת הסעיף</span><textarea data-bind="data.sections.${si}.title" rows="2">${esc(sec.title)}</textarea></label>
      ${sec.ref !== undefined ? `<label class="field"><span>הפניה לתקנה</span><input data-bind="data.sections.${si}.ref" value="${esc(sec.ref || '')}"></label>` : ''}
      <div class="grid2">
        <label class="field"><span>כותרת עמודת הפריטים</span><input data-bind="data.sections.${si}.head" value="${esc(sec.head || '')}"></label>
        <label class="field"><span>כותרת שדה הפירוט</span><input data-bind="data.sections.${si}.textLabel" value="${esc(sec.textLabel || '')}"></label>
      </div>
      <div class="grid3">${['ok', 'bad', 'na'].map((k) => `<label class="field"><span>סימון "${esc(STATUS_LABEL_NAMES[k])}"</span><input data-bind="data.sections.${si}.labels.${k}" value="${esc(sec.labels[k])}"></label>`).join('')}</div>
    </div>` : ''}
    <div class="tri-list" role="list">
      ${sec.rows.map((x, j) => (editing ? editRow(si, j, x) : x.hidden ? '' : x.header ? `<div class="tri-group">${esc(x.label)}</div>` : triRow(r, si, j, x, sec))).join('')}
    </div>
    ${editing ? `<div class="row-btns"><button class="btn small" data-action="add-row" data-si="${si}">+ הוסף שורה</button><button class="btn small" data-action="add-row" data-si="${si}" data-header="1">+ הוסף כותרת</button></div>` : ''}
    <label class="field"><span>${esc(sec.textLabel)} <small class="muted">(הערות שנכתבו בשורות נכנסות אוטומטית)</small></span>
      <textarea data-bind="data.sections.${si}.text" rows="3" placeholder="פירוט נוסף…">${esc(sec.text)}</textarea></label>
    <div class="row-btns">${photoActions(sec.key, sec.title, false)}</div>
    ${thumbs(r, sec.key)}
  </div>`;
}

function signStep(r) {
  const ins = r.inspector || {};
  const d = r.data;
  let top = '';
  if (r.type === 'visit') {
    const summary = d.summary ?? state.settings.defaultSummary;
    top = `<div class="decl"><b>הצהרה</b><p>${esc(DECLARATION)}</p></div>
      <label class="field"><span>סיכום מקצועי <small class="muted">(ברירת המחדל נקבעת בהגדרות)</small></span>
      <textarea data-bind="data.summary" rows="6">${esc(summary)}</textarea></label>`;
  } else if (r.type === 'custom') {
    top = `<label class="field"><span>${esc(d.summaryLabel)}</span><textarea data-bind="data.summary" rows="5">${esc(d.summary)}</textarea></label>`;
  }
  return `${top}
  <div class="grid2">
    <label class="field"><span>שם מלא</span><input data-bind="inspector.name" value="${esc(ins.name || '')}"></label>
    <label class="field"><span>תואר</span><select data-bind="inspector.title">${SIGNER_TITLES.map((t) => `<option ${t === ins.title ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
  </div>
  <div class="field"><span>חתימה</span>
    <div class="sig-box">${ins.signature ? `<img src="${ins.signature}" alt="חתימה">` : '<span class="muted">אין חתימה</span>'}</div>
    <div class="row-btns">
      <button class="btn small" data-action="sign-here">✍ חתום עכשיו</button>
      <button class="btn small" data-action="inspector-from-profile">↻ טען מהפרופיל</button>
    </div>
  </div>`;
}

function photoPlace(r, ref) {
  if (!ref) return 'נספח';
  if (ref === 'risk') return 'פירוט הסיכון';
  const [key, rowId] = ref.split(':');
  const sec = r.data.sections?.find((s) => s.key === key);
  if (!sec) return 'נספח';
  const row = rowId && sec.rows.find((x) => x.id === rowId);
  return row ? `${sec.title} › ${row.label}` : sec.title;
}

function photosStep(r) {
  const photos = r.photos || [];
  return `
  <p class="muted">תמונה שמצלמים מתוך שורה או סעיף בטופס נכנסת לדוח ליד אותו סעיף. כאן אפשר להוסיף תמונות כלליות, שיופיעו כנספח בסוף הדוח.</p>
  <div class="row-btns">
    <button class="btn primary" data-action="add-photo" data-capture="1">📷 צלם</button>
    <button class="btn" data-action="add-photo">🖼 בחר מהגלריה</button>
  </div>
  <div class="photo-grid">
  ${photos.map((p, i) => `<figure class="photo">
      <img src="${p.src}" alt="">
      <small class="photo-place">📍 ${esc(photoPlace(r, p.ref))}${p.ref ? ` · <button class="link-btn" data-action="photo-to-appendix" data-id="${p.id}">העבר לנספח</button>` : ''}</small>
      <input data-bind="photos.${i}.caption" value="${esc(p.caption || '')}" placeholder="כיתוב לתמונה…">
      <button class="icon-btn" data-action="del-photo" data-id="${p.id}" aria-label="מחק תמונה">✕</button>
    </figure>`).join('')}
  </div>`;
}

function stepBody(r, step) {
  const s = site(r.siteId) || {};
  const d = r.data;
  switch (step.id) {
    case 'details': {
      const st = siteStats(s);
      const T = REPORT_TYPES[r.type];
      const from = d.fromReport && report(d.fromReport);
      const linked = savedReports().filter((x) => x.data?.fromReport === r.id);
      return `
      <div class="grid3">
        <label class="field"><span>תאריך הביקור</span><input type="date" data-bind="visitDate" value="${r.visitDate || ''}"></label>
        <label class="field"><span>תאריך הדו"ח</span><input type="date" data-bind="reportDate" value="${r.reportDate || ''}"></label>
        <label class="field"><span>מס' דו"ח <small class="muted">(מספור אוטומטי לאתר)</small></span><input data-bind="number" value="${esc(r.number || '')}" inputmode="numeric"></label>
      </div>
      ${r.type !== 'custom' ? `<div class="callout ${r.type === 'risk' ? 'danger' : ''}">
        <b>${esc(T.distribution)}</b><br>
        <small>מכותבים: ${T.recipients.map((x) => ROLES[x]).join(' · ')}</small>
        ${st.last && r.type === 'visit' ? `<br><small>ביקור קודם באתר: ${formatDate(st.last)} · ביקור הבא נדרש עד ${formatDate(st.due)}</small>` : ''}
        ${from ? `<br><small>נפתח מתוך <a class="link" href="#/r/${from.id}/0">${esc(reportTitle(from))} מ-${formatDate(from.visitDate)}</a></small>` : ''}
        ${linked.length ? `<br><small>הודעות סיכון שנפתחו מדוח זה: ${linked.map((x) => `<a class="link" href="#/r/${x.id}/0">${formatDate(x.visitDate)}</a>`).join(', ')}</small>` : ''}
      </div>` : ''}
      <label class="field"><span>אופן ההפצה <small class="muted">(מופיע בנתונים הכלליים בדוח)</small></span><input data-bind="data.distMethod" value="${esc(d.distMethod || '')}" placeholder='וואטסאפ / דוא"ל'></label>
      <h3 class="step-sub">נתונים כלליים <small class="muted">— נשמרים באתר ומתמלאים אוטומטית בדוחות הבאים</small></h3>
      <div data-site-id="${s.id}">${siteForm(s)}</div>`;
    }
    case 'sec':
      return step.keys.map((k) => secIndex(r, k)).filter((i) => i >= 0)
        .map((i) => sectionEditor(r, i, { showTitle: step.keys.length > 1 || r.type === 'custom' })).join('');
    case 'reason': {
      const st = siteStats(s);
      const prev = new Set(st.visits.filter((v) => v.id !== r.id).flatMap((v) => v.data.reasons));
      return `
      <p class="muted">סמן את סיבת הביקור [סעיף 2א'(ב)(1)]. ביקורת נדרשת לפחות בכל אחד מהשלבים, ולפחות אחת ל-3 חודשים.</p>
      <div class="chips-select">${VISIT_REASONS.map((x) => `<button class="pick ${d.reasons.includes(x.id) ? 'on' : ''}" data-action="toggle-reason" data-id="${x.id}" aria-pressed="${d.reasons.includes(x.id)}">
        <span class="pick-box">${d.reasons.includes(x.id) ? '✓' : ''}</span><span>${esc(x.label)}${prev.has(x.id) ? '<small>בוצע בעבר באתר זה</small>' : ''}</span></button>`).join('')}</div>`;
    }
    case 'matrix': {
      const res = finalRisk(d);
      return `
      <label class="check"><input type="checkbox" data-bind="data.showMatrix" data-rerender="1" ${d.showMatrix !== false ? 'checked' : ''}><span>הצג את לוח ההחלטה בדוח</span></label>
      ${d.showMatrix !== false ? `<p class="muted">הקש על התא המתאים בלוח ההחלטה (חומרת פגיעה × הסתברות).</p>
      <div class="mx-wrap">${matrixTable({ sev: d.severity, lik: d.likelihood }, { interactive: true })}</div>` : ''}
      <label class="field"><span>דירוג הסיכון בדוח</span>
        <select data-bind="data.levelOverride" data-rerender="1">
          <option value="" ${!d.levelOverride ? 'selected' : ''}>לפי לוח ההחלטה (אוטומטי)</option>
          ${Object.entries(LEVEL_INFO).map(([k, v]) => `<option value="${k}" ${d.levelOverride === k ? 'selected' : ''}>ידני: ${esc(v.label)}</option>`).join('')}
        </select></label>
      ${res ? `<div class="mx-result mx-${res.level}"><b>${res.score && !res.manual ? res.score : '✎'}</b><span>${esc(LEVEL_INFO[res.level].label)}</span>
        <small>${res.manual ? 'דירוג ידני' : `חומרה: ${esc(SEVERITY.find((x) => x.v === d.severity).name)} · הסתברות: ${esc(LIKELIHOOD.find((x) => x.v === d.likelihood).name)}`}</small></div>
        ${res.level !== 'red' ? '<p class="warn-text">⚠ הדירוג שנבחר אינו "בלתי קביל". אפשר עדיין להפיץ את הטופס כ"ממצא אחר".</p>' : ''}` : ''}
      <label class="field"><span>פירוט הסיכון הבלתי קביל שנמצא</span><textarea data-bind="data.riskText" rows="5" placeholder="מה נמצא, היכן באתר, מי חשוף…">${esc(d.riskText)}</textarea></label>
      <div class="row-btns">${photoActions('risk', 'הסיכון שנמצא', false)}</div>
      ${thumbs(r, 'risk')}`;
    }
    case 'actions':
      return `
      <label class="field"><span>המענה הנדרש למימוש</span><textarea data-bind="data.requiredResponse" rows="4">${esc(d.requiredResponse)}</textarea></label>
      <label class="field"><span>פעולות מתקנות מיידיות שבוצעו</span><textarea data-bind="data.correctiveActions" rows="4" placeholder="לדוגמה: הופסקה העבודה באזור, גודר המפגע…">${esc(d.correctiveActions)}</textarea></label>
      <label class="field"><span>ממצאים/ליקויים נוספים לדיווח</span><textarea data-bind="data.otherFindings" rows="4">${esc(d.otherFindings)}</textarea></label>`;
    case 'sign':
      return signStep(r);
    case 'photos':
      return photosStep(r);
  }
  return '';
}

function viewReport(id, stepArg) {
  const r = report(id);
  if (!r) return notFound();
  if (stepArg === 'preview') return viewPreview(r);
  const steps = getSteps(r);
  const idx = Math.min(Math.max(parseInt(stepArg, 10) || 0, 0), steps.length - 1);
  const step = steps[idx];
  const s = site(r.siteId);
  const status = r._draft ? 'חדש — יישמר עם השינוי הראשון' : r.status === 'sent' ? 'הופץ' : 'טיוטה';
  return `
  <div class="page-h"><a class="back" href="#/">→</a>
    <h1><span class="type-tag ${r.type}">${typeIcon(r)} ${esc(reportTitle(r))}${r.number ? ` #${esc(r.number)}` : ''}</span> ${esc(s?.name || '')}</h1>
    <small class="saved" id="saved">${status}</small>
  </div>
  <div class="editor">
    <nav class="steps" aria-label="שלבי הטופס">
      ${steps.map((x, i) => `<a href="#/r/${r.id}/${i}" class="step ${i === idx ? 'on' : ''} ${stepProgress(r, x) ? 'done' : ''}" ${i === idx ? 'aria-current="step"' : ''}>
        <span class="step-n">${stepProgress(r, x) ? '✓' : i + 1}</span><span>${esc(x.name)}</span></a>`).join('')}
      <a href="#/r/${r.id}/preview" class="step preview"><span class="step-n">⎙</span><span>תצוגה והפקה</span></a>
    </nav>
    <section class="step-panel" data-report-id="${r.id}">
      <h2 class="step-h"><span class="mono muted">${idx + 1}/${steps.length}</span> ${esc(step.name)}</h2>
      ${stepBody(r, step)}
      <div class="step-nav">
        ${idx > 0 ? `<a class="btn" href="#/r/${r.id}/${idx - 1}">→ הקודם</a>` : '<span></span>'}
        ${idx < steps.length - 1 ? `<a class="btn primary" href="#/r/${r.id}/${idx + 1}">הבא ←</a>` : `<a class="btn primary" href="#/r/${r.id}/preview">לתצוגה והפקה ←</a>`}
      </div>
    </section>
  </div>`;
}

function validate(r) {
  const s = site(r.siteId) || {};
  const issues = [];
  if (!s.name) issues.push('חסר שם אתר');
  if (!r.visitDate) issues.push('חסר תאריך ביקור');
  if (!r.inspector?.name) issues.push('חסר שם הבקר');
  if (!r.inspector?.signature) issues.push('חסרה חתימה');
  const d = r.data;
  if (r.type === 'risk') {
    if (!(d.severity && d.likelihood) && !d.levelOverride) issues.push('לא נבחר דירוג סיכון');
    if (!d.riskText.trim()) issues.push('חסר פירוט הסיכון');
    if (!d.requiredResponse.trim()) issues.push('חסר המענה הנדרש');
    return issues;
  }
  if (r.type === 'visit' && !d.reasons.length) issues.push('לא סומנה סיבת ביקור');
  for (const sec of d.sections) {
    if (['docs', 'checks'].includes(sec.key)) continue;
    const rows = activeRows(sec);
    const open = rows.filter((x) => !x.status).length;
    if (open) issues.push(`${sec.title.slice(0, 30)}: ${open} פריטים לא סומנו`);
    if (rows.some((x) => x.status === 'bad' && !(x.note || '').trim()) && !sec.text.trim()) issues.push(`${sec.title.slice(0, 30)}: ליקוי ללא פירוט`);
  }
  return issues;
}

// ---------- תפוצה (סעיף 1) ----------
const recipKey = (x) => (x.email || '').toLowerCase() || waNumber(x.phone) || (x.name || '').trim();
function defaultRecipients(r) {
  const s = site(r.siteId) || {};
  const list = [];
  for (const role of REPORT_TYPES[r.type].recipients) {
    const c = contactOf(s, role);
    if (c.name || c.phone || c.email) list.push({ id: uid(), name: c.name || '', role: ROLES[role], phone: c.phone || '', email: c.email || '', on: true, src: 'site' });
  }
  const dist = state.settings.distribution;
  if (dist.includeSelf !== false) {
    const ins = state.settings.inspector;
    list.push({ id: uid(), name: ins.name || 'אני', role: 'עורך הדו"ח', phone: ins.phone || '', email: ins.email || state.user?.email || '', on: true, src: 'self' });
  }
  const extras = dist[r.type]?.length ? dist[r.type] : state.settings.lastRecipients[r.type] || [];
  for (const e of extras) {
    if (!list.some((x) => recipKey(x) && recipKey(x) === recipKey(e))) list.push({ name: '', role: '', phone: '', email: '', ...e, id: uid(), on: true, src: 'extra' });
  }
  return list;
}
const recipients = (r) => (r.recipients?.length ? r.recipients : defaultRecipients(r));
const ownRecipients = (r) => {
  if (!r.recipients?.length) r.recipients = defaultRecipients(r);
  return r.recipients;
};
function shareMessage(r, name, link) {
  const s = site(r.siteId) || {};
  return `שלום${name ? ` ${name}` : ''},\n${link ? 'להלן' : 'מצורף'} ${reportTitle(r)}${r.number ? ` מס' ${r.number}` : ''} – ${s.name || ''} מתאריך ${formatDate(r.visitDate)}.${link ? `\n\nלצפייה והורדת הדוח (PDF):\n${link}` : ''}\n\n${state.settings.inspector.name || ''}${state.settings.company.name ? `\n${state.settings.company.name}` : ''}`;
}
async function rememberRecipients(r) {
  const extras = ownRecipients(r).filter((x) => x.src === 'extra' || x.src === 'added').map(({ name, role, phone, email }) => ({ name, role, phone, email }));
  state.settings.lastRecipients[r.type] = extras;
  await saveSettings();
  if (r.status !== 'sent') ui.askSent = r.id;
}

function viewPreview(r) {
  const s = site(r.siteId);
  const model = buildModel(r, s, state.settings);
  const issues = validate(r);
  const recips = recipients(r);
  const dl = reportDeadline(r);
  const linked = savedReports().filter((x) => x.data?.fromReport === r.id);
  const on = recips.filter((x) => x.on);
  return `
  <div class="page-h"><a class="back" href="#/r/${r.id}/0">→</a><h1>תצוגה והפקה</h1>
    ${dl ? `<span class="chip ${dl.kind}">${dl.label}</span>` : r.status === 'sent' ? '<span class="chip ok">הופץ</span>' : ''}
    <a class="btn small" href="#/r/${r.id}/0">✎ עריכת הדוח</a></div>
  <div class="preview-layout">
    <aside class="preview-side" data-report-id="${r.id}">
      <div class="panel">
        <div class="export-btns">
          <button class="btn primary" data-action="export-pdf">⬇ PDF</button>
          <button class="btn primary" data-action="export-docx">⬇ Word</button>
          <button class="btn" data-action="share">↗ שיתוף קובץ</button>
          <button class="btn" data-action="print">⎙ הדפסה</button>
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-h">הגדרות הדפסה</h2>
        <label class="check"><input type="checkbox" data-bind="print.hideUnmarked" data-rerender="1" data-print-default="hideUnmarked" ${r.print?.hideUnmarked ? 'checked' : ''}><span>הסתר שורות שלא סומנו</span></label>
        <label class="check"><input type="checkbox" data-bind="print.hideEmptySections" data-rerender="1" data-print-default="hideEmptySections" ${r.print?.hideEmptySections ? 'checked' : ''}><span>הסתר סעיפים ופרקים שלא מולאו כלל (וקווי מילוי ריקים)</span></label>
        <p class="muted tiny">חל על התצוגה, ה-PDF, ה-Word וההדפסה. הבחירה נזכרת לדוחות הבאים.</p>
      </div>
      ${issues.length ? `<div class="panel issues"><h2 class="panel-h">לפני הפצה <small>${issues.length}</small></h2><ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '<div class="panel ok-panel">✓ הדוח מלא ומוכן להפצה</div>'}
      <div class="panel dist">
        <h2 class="panel-h">תפוצה <small>${on.length} נבחרו</small>${r.recipients?.length ? '<button class="link-btn" data-action="recip-reset" title="חזרה לרשימת ברירת המחדל">↺ ברירת מחדל</button>' : ''}</h2>
        ${recips.map((x, i) => `<div class="recip2 ${x.on ? '' : 'off'}">
          <label class="recip-check"><input type="checkbox" data-action="recip-toggle" data-i="${i}" ${x.on ? 'checked' : ''}>
            <span><b>${esc(x.name || '—')}</b><small>${esc(x.role || '')}</small></span></label>
          <span class="recip-btns">
            ${x.phone ? `<button class="mini wa" data-action="send-wa" data-i="${i}" title="וואטסאפ ${esc(x.phone)}">וואטסאפ</button>` : ''}
            ${x.email ? `<button class="mini gm" data-action="send-gmail" data-i="${i}" title="${esc(x.email)}">Gmail</button>` : ''}
            ${x.src !== 'site' ? `<button class="mini x" data-action="recip-remove" data-i="${i}" aria-label="הסר">✕</button>` : ''}
          </span>
          ${x.phone || x.email ? `<small class="recip-reach" dir="ltr">${esc([x.phone, x.email].filter(Boolean).join(' · '))}</small>` : '<small class="recip-reach muted">אין טלפון/מייל — הוסף בפרטי האתר</small>'}
        </div>`).join('')}
        ${ui.addRecipient ? `<form class="add-recip" data-action="recip-add">
          <input name="name" placeholder="שם" required><input name="role" placeholder="תפקיד (רשות)">
          <input name="phone" placeholder="נייד" type="tel" dir="ltr"><input name="email" placeholder="אימייל" type="email" dir="ltr">
          <div class="row-btns"><button class="btn small primary">הוסף</button><button class="btn small ghost" type="button" data-action="recip-add-toggle">ביטול</button></div>
        </form>` : '<button class="link-btn" data-action="recip-add-toggle">+ הוסף נמען</button>'}
        <div class="row-btns">
          <button class="btn small" data-action="send-gmail-all" ${on.some((x) => x.email) ? '' : 'disabled'}>${isMobile() ? '✉ מייל לכל הנבחרים' : 'Gmail לכל הנבחרים'}</button>
          ${isMobile() ? '' : `<button class="btn small" data-action="send-mail-all" ${on.some((x) => x.email) ? '' : 'disabled'}>✉ אפליקציית מייל</button>`}
          <button class="btn small" data-action="copy-link">🔗 העתק קישור לדוח</button>
        </div>
        <p class="muted tiny">וואטסאפ ומייל נפתחים ישר מול הנמען, עם הודעה מוכנה ו<b>קישור לדוח</b>. הנמען לוחץ על הקישור ופותח או מוריד את ה-PDF, גם בלי חשבון. ${r.shareToken ? `<a class="link" href="#/v/${r.shareToken}" target="_blank">פתח את הקישור</a>` : ''}
        לשליחת הקובץ עצמו כצרופה, השתמש ב"שיתוף קובץ". נמענים קבועים נקבעים ב<a class="link" href="#/settings">הגדרות</a>.</p>
        ${ui.askSent === r.id && r.status !== 'sent' ? '<div class="ask-sent">שלחת את הדוח? סמן אותו כהופץ כדי להוריד אותו מרשימת הממתינים.</div>' : ''}
        <button class="btn ${r.status === 'sent' ? '' : 'primary'} full" data-action="mark-sent">${r.status === 'sent' ? '↺ החזר לטיוטה' : '✓ סמן כהופץ'}</button>
        <p class="muted tiny">"הופץ" רק מסמן שהדוח נשלח: הוא יוצא מרשימת "ממתינים להפצה" ומתזכורות המועד, ונשמר תאריך ההפצה. אפשר להמשיך לערוך גם אחרי זה.</p>
      </div>
      ${linked.length ? `<div class="panel"><h2 class="panel-h">הודעות סיכון שנפתחו מדוח זה</h2>${linked.map((x) => reportRow(x)).join('')}</div>` : ''}
      <button class="btn ghost danger-text" data-action="delete-report">מחק דוח</button>
    </aside>
    <div class="paper-scroller"><div class="paper-scale" id="paper-scale">${renderPaper(model)}</div></div>
  </div>`;
}

// ---------- settings ----------
function peopleEditor(type, label) {
  const list = state.settings.distribution[type];
  return `<div class="people">
    <h3 class="step-sub">${esc(label)} <button class="btn small" data-action="dist-add" data-type="${type}">+ הוסף</button></h3>
    ${list.length ? list.map((p, i) => `<div class="person">
      <input data-setbind="distribution.${type}.${i}.name" value="${esc(p.name || '')}" placeholder="שם">
      <input data-setbind="distribution.${type}.${i}.role" value="${esc(p.role || '')}" placeholder="תפקיד">
      <input data-setbind="distribution.${type}.${i}.phone" value="${esc(p.phone || '')}" placeholder="נייד" type="tel" dir="ltr">
      <input data-setbind="distribution.${type}.${i}.email" value="${esc(p.email || '')}" placeholder="אימייל" type="email" dir="ltr">
      <button class="icon-btn2" data-action="dist-remove" data-type="${type}" data-i="${i}" aria-label="הסר">✕</button>
    </div>`).join('') : `<p class="muted tiny">לא הוגדרו — ${state.settings.lastRecipients[type]?.length ? `ישמשו הנמענים האחרונים (${state.settings.lastRecipients[type].map((x) => esc(x.name)).join(', ')})` : 'יישמרו הנמענים האחרונים שתשלח אליהם'}.</p>`}
  </div>`;
}

function templatesEditor() {
  const t = state.settings.templates;
  return VISIT_SECTION_DEFS.map((def) => `
    <details class="tpl" ${t[def.key] ? 'open' : ''}>
      <summary>${esc(def.title.length > 60 ? `${def.title.slice(0, 58)}…` : def.title)} ${t[def.key] ? '<span class="chip warn">מותאם</span>' : ''}</summary>
      <textarea data-template="${def.key}" rows="${Math.min(14, def.items.length + 2)}">${esc(t[def.key] ?? defaultItemsText(def.key))}</textarea>
      ${t[def.key] ? `<button class="btn small" data-action="template-reset" data-key="${def.key}">↺ שחזר נוסח מקורי</button>` : ''}
    </details>`).join('');
}

function viewSettings() {
  const st = state.settings;
  const ins = st.inspector;
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>הגדרות</h1><small class="saved" id="saved"></small></div>
  ${state.access.admin ? '<a class="banner admin-banner" href="#/admin">🛡 ניהול מערכת — משתמשים, שימוש והרשאות ←</a>' : ''}
  ${!state.access.admin && (state.user.email || '').toLowerCase() === cloud.SUPER_ADMIN && !state.user.emailVerified ? `<div class="banner">כדי לקבל הרשאות מנהל צריך לאמת את כתובת המייל (או להתחבר עם Google).
    <div class="row-btns"><button class="btn small primary" data-action="verify-email">שלח מייל אימות</button><button class="btn small" data-action="access-recheck">בדוק שוב</button></div></div>` : ''}
  <section class="panel">
    <h2 class="panel-h">פרופיל הבקר <small>ייכנס אוטומטית לכל דוח חדש</small></h2>
    <div class="grid2">
      <label class="field"><span>שם מלא</span><input data-setbind="inspector.name" value="${esc(ins.name)}"></label>
      <label class="field"><span>תואר</span><select data-setbind="inspector.title">${SIGNER_TITLES.map((t) => `<option ${t === ins.title ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field"><span>נייד (וואטסאפ)</span><input data-setbind="inspector.phone" value="${esc(ins.phone)}" type="tel" dir="ltr"></label>
      <label class="field"><span>אימייל</span><input data-setbind="inspector.email" value="${esc(ins.email)}" type="email" dir="ltr"></label>
    </div>
    <div class="field"><span>חתימה</span>
      <div class="sig-box">${ins.signature ? `<img src="${ins.signature}" alt="חתימה">` : '<span class="muted">אין חתימה שמורה</span>'}</div>
      <div class="row-btns"><button class="btn small" data-action="sign-profile">✍ ${ins.signature ? 'חתום מחדש' : 'הוסף חתימה'}</button>
      <button class="btn small" data-action="upload-signature">🖼 העלה תמונת חתימה</button></div>
    </div>
  </section>
  <section class="panel">
    <h2 class="panel-h">חברה, לוגו וסלוגן <small>מופיעים בראש כל דוח</small></h2>
    <div class="grid2">
      <label class="field"><span>שם החברה</span><input data-setbind="company.name" value="${esc(st.company.name)}"></label>
      <label class="field"><span>סלוגן</span><input data-setbind="company.slogan" value="${esc(st.company.slogan)}" placeholder="לדוגמה: בטיחות מתחילה בתכנון"></label>
    </div>
    <div class="field"><span>לוגו</span>
      <div class="logo-box">${st.company.logo ? `<img src="${st.company.logo}" alt="לוגו">` : '<span class="muted">אין לוגו</span>'}</div>
      <div class="row-btns"><button class="btn small" data-action="upload-logo">העלה לוגו</button>${st.company.logo ? '<button class="btn small" data-action="remove-logo">הסר</button>' : ''}</div>
    </div>
  </section>
  <section class="panel">
    <h2 class="panel-h">תפוצה קבועה <small>מי מקבל כל סוג דוח</small></h2>
    <p class="muted tiny">אנשי הקשר של האתר (מזמין, מבצע, ובסיכון בלתי קביל גם מנהל אתר ומנהל עבודה) נכנסים לתפוצה אוטומטית. כאן מוסיפים אנשים קבועים נוספים.</p>
    <label class="check"><input type="checkbox" data-setbind="distribution.includeSelf" ${st.distribution.includeSelf !== false ? 'checked' : ''}><span>לשלוח עותק גם לעצמי (עורך הדו"ח)</span></label>
    ${peopleEditor('visit', 'דו"ח ביקור (סיכון קביל)')}
    ${peopleEditor('risk', 'הודעת סיכון בלתי קביל')}
  </section>
  <section class="panel">
    <h2 class="panel-h">רשימות הבדיקה בדו"ח ביקור <small>לדוחות חדשים</small></h2>
    <p class="muted tiny">שורה לכל פריט. "-" בתחילת שורה = תת-פריט, ":" בסוף שורה = כותרת קבוצה. אפשר גם לערוך רשימה בתוך דוח ספציפי בלבד, עם "✎ ערוך רשימה".</p>
    ${templatesEditor()}
  </section>
  <section class="panel">
    <h2 class="panel-h">טפסים מותאמים <small>צ'ק ליסט משלך לתחומים אחרים</small></h2>
    ${st.customForms.map((f) => `<a class="row" href="#/forms/${f.id}"><span class="row-ico custom">☑</span><span class="row-main"><b>${esc(f.name)}</b><small>${f.sections.length} סעיפים</small></span><span class="row-end">←</span></a>`).join('')}
    <button class="btn small" data-action="form-new">+ טופס חדש</button>
  </section>
  <section class="panel">
    <h2 class="panel-h">נוסח קבוע</h2>
    <label class="field"><span>סיכום מקצועי (ברירת מחדל לדוח ביקור)</span><textarea data-setbind="defaultSummary" rows="6">${esc(st.defaultSummary)}</textarea></label>
  </section>
  <section class="panel">
    <h2 class="panel-h">חשבון ושמירה</h2>
    <div class="account">
      <span class="avatar">${esc((state.user.displayName || state.user.email || '?').trim()[0].toUpperCase())}</span>
      <span class="row-main"><b>${esc(state.user.displayName || '')}</b><small dir="ltr">${esc(state.user.email || '')}</small></span>
      <button class="btn small" data-action="logout">התנתק</button>
    </div>
    <label class="check"><input type="checkbox" data-action="toggle-cloud" ${cloudEnabled() ? 'checked' : ''}><span><b>שמירה בענן</b> (חינם) — גיבוי אוטומטי וסנכרון בין הטלפון למחשב. כשכבוי, הנתונים נשמרים רק במכשיר הזה.</span></label>
    <p class="muted tiny">בכל מקרה נשמר עותק במכשיר, לעבודה בלי קליטה. ההגדרה הזו חלה על המכשיר הנוכחי.</p>
  </section>
  <section class="panel">
    <h2 class="panel-h">גיבוי ונתונים</h2>
    <p class="muted">אפשר להוריד עותק של כל הנתונים לקובץ, לשמירה או להעברה לחשבון אחר.</p>
    <div class="row-btns">
      <button class="btn" data-action="backup">⬇ הורד גיבוי</button>
      <button class="btn" data-action="restore">⬆ שחזר מגיבוי</button>
      <button class="btn" data-action="theme">◐ ערכת צבעים</button>
    </div>
    <p class="muted tiny mono">${state.sites.length} אתרים · ${savedReports().length} דוחות</p>
  </section>`;
}

// ---------- custom forms (סעיף 20) ----------
function viewForms() {
  const forms = state.settings.customForms;
  return `
  <div class="page-h"><a class="back" href="#/settings">→</a><h1>טפסים מותאמים</h1><button class="btn" data-action="form-new">+ טופס חדש</button></div>
  <section class="panel">
    <p class="muted">טופס מותאם הוא צ'ק ליסט ריק שאתה קובע בו את הכותרת, הסעיפים והפריטים, לשימוש בתחומים אחרים. הוא עובד כמו הדוחות הרגילים: אתר ופרטים כלליים, סימון לכל שורה, הערות, תמונות, חתימה והפקה ל-PDF ול-Word.</p>
    ${forms.length ? forms.map((f) => `<a class="row" href="#/forms/${f.id}"><span class="row-ico custom">☑</span><span class="row-main"><b>${esc(f.name)}</b><small>${esc(f.title)} · ${f.sections.length} סעיפים</small></span><span class="row-end">←</span></a>`).join('') : '<p class="empty">עוד אין טפסים מותאמים</p>'}
  </section>`;
}

function viewForm(id) {
  const i = state.settings.customForms.findIndex((f) => f.id === id);
  if (i < 0) return notFound();
  const f = state.settings.customForms[i];
  const p = `customForms.${i}`;
  return `
  <div class="page-h"><a class="back" href="#/forms">→</a><h1>${esc(f.name)}</h1><small class="saved" id="saved"></small>
    <a class="btn small primary" href="#/new/custom/${f.id}">☑ דוח חדש מהטופס</a></div>
  <section class="panel">
    <div class="grid2">
      <label class="field"><span>שם הטופס (לרשימות)</span><input data-setbind="${p}.name" value="${esc(f.name)}"></label>
      <label class="field"><span>כותרת הדוח</span><input data-setbind="${p}.title" value="${esc(f.title)}" placeholder='לדוגמה: דו"ח ביקורת בטיחות אש'></label>
    </div>
    <label class="field"><span>שורת משנה מתחת לכותרת <small class="muted">(רשות, למשל בסיס חוקי)</small></span><input data-setbind="${p}.subtitle" value="${esc(f.subtitle || '')}"></label>
    <label class="field"><span>כותרת שדה הסיכום</span><input data-setbind="${p}.summaryLabel" value="${esc(f.summaryLabel || '')}"></label>
  </section>
  ${f.sections.map((s, j) => `<section class="panel">
    <h2 class="panel-h">סעיף ${j + 2} <button class="link-btn danger" data-action="form-section-remove" data-i="${i}" data-j="${j}">מחק סעיף</button></h2>
    <div class="grid2">
      <label class="field"><span>כותרת הסעיף</span><input data-setbind="${p}.sections.${j}.title" value="${esc(s.title)}"></label>
      <label class="field"><span>כותרת עמודת הפריטים</span><input data-setbind="${p}.sections.${j}.head" value="${esc(s.head || '')}"></label>
    </div>
    <div class="grid3">
      <label class="field"><span>סימון חיובי</span><input data-setbind="${p}.sections.${j}.labels.ok" value="${esc(s.labels?.ok || 'תקין')}"></label>
      <label class="field"><span>סימון שלילי</span><input data-setbind="${p}.sections.${j}.labels.bad" value="${esc(s.labels?.bad || 'לא תקין')}"></label>
      <label class="field"><span>סימון שלישי</span><input data-setbind="${p}.sections.${j}.labels.na" value="${esc(s.labels?.na || 'לא רלוונטי')}"></label>
    </div>
    <label class="field"><span>פריטים — שורה לכל פריט <small class="muted">("-" בהתחלה = תת-פריט, ":" בסוף = כותרת)</small></span>
      <textarea data-setbind="${p}.sections.${j}.items" rows="7">${esc(s.items || '')}</textarea></label>
    <label class="field"><span>כותרת שדה הפירוט</span><input data-setbind="${p}.sections.${j}.textLabel" value="${esc(s.textLabel || '')}"></label>
  </section>`).join('')}
  <div class="row-btns">
    <button class="btn" data-action="form-section-add" data-i="${i}">+ הוסף סעיף</button>
    <button class="btn" data-action="form-duplicate" data-i="${i}">⧉ שכפל טופס</button>
    <button class="btn ghost danger-text" data-action="form-delete" data-i="${i}">מחק טופס</button>
  </div>`;
}

// ---------- ניהול מערכת (סעיפים 5–6) ----------
const fmtDay = (ms) => (ms ? formatDate(new Date(ms).toISOString()) : '—');
async function loadAdmin() {
  try {
    ui.admin = await cloud.adminData();
  } catch (err) {
    console.error(err);
    ui.admin = { error: true };
  }
  if (current.route === 'admin') rerender();
}

function viewAdmin() {
  if (!state.access.admin) return notFound();
  if (!ui.admin) {
    loadAdmin();
    return '<div class="page-h"><a class="back" href="#/settings">→</a><h1>ניהול מערכת</h1></div><section class="panel"><p class="empty">טוען…</p></section>';
  }
  if (ui.admin.error) {
    return `<div class="page-h"><a class="back" href="#/settings">→</a><h1>ניהול מערכת</h1></div>
      <section class="panel issues"><p>אין הרשאה לקרוא את נתוני הניהול. ודא שכללי ה-Database עודכנו (database.rules.json) ושהתחברת עם Google או אימתת את המייל.</p>
      <button class="btn" data-action="admin-refresh">נסה שוב</button></section>`;
  }
  const { users, access, admins, config } = ui.admin;
  const list = Object.entries(users).map(([id, u]) => ({ id, ...u, st: u.stats || {}, acc: access[id] || '' }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  const totalBytes = list.reduce((a, u) => a + (u.st.bytes || 0), 0);
  const pct = Math.min(100, (totalBytes / 1073741824) * 100);
  const req = config.requireApproval === true;
  const statusChip = (u) => {
    const isAdm = u.email && (u.email.toLowerCase() === cloud.SUPER_ADMIN || admins[cloud.emailKey(u.email)]);
    if (u.acc === 'blocked') return '<span class="chip danger">חסום</span>';
    if (isAdm) return '<span class="chip ok">מנהל</span>';
    if (u.acc === 'approved') return '<span class="chip ok">מאושר</span>';
    return req ? '<span class="chip warn">ממתין לאישור</span>' : '<span class="chip">פעיל</span>';
  };
  const pending = list.filter((u) => !u.acc).length;
  return `
  <div class="page-h"><a class="back" href="#/settings">→</a><h1>ניהול מערכת</h1><button class="btn small" data-action="admin-refresh">↻ רענן</button></div>
  <section class="panel">
    <div class="stats">
      <div><b>${list.length}</b><small>משתמשים</small></div>
      <div><b>${list.filter((u) => Date.now() - (u.lastSeen || 0) < 30 * DAY).length}</b><small>פעילים ב-30 יום</small></div>
      <div><b>${list.reduce((a, u) => a + (u.st.reports || 0), 0)}</b><small>דוחות</small></div>
      <div><b>${fileSize(totalBytes)}</b><small>מתוך 1GB חינם</small></div>
    </div>
    <div class="meter"><span style="width:${pct.toFixed(1)}%"></span></div>
  </section>
  <section class="panel">
    <h2 class="panel-h">הרשאות שימוש</h2>
    <label class="check"><input type="checkbox" data-action="admin-approval" ${req ? 'checked' : ''}><span><b>משתמשים חדשים צריכים אישור מנהל</b> — עד שתאשר, הם יראו מסך "ממתין לאישור" ולא יוכלו לשמור.</span></label>
    ${req && pending ? `<button class="btn small" data-action="approve-all">אשר את כל ${pending} הממתינים</button>` : ''}
  </section>
  <section class="panel">
    <h2 class="panel-h">משתמשים <small>${list.length}</small></h2>
    <div class="users">
      ${list.map((u) => `<div class="user">
        <div class="user-main"><b>${esc(u.name || u.email || u.id)}</b><small dir="ltr">${esc(u.email || '')}</small></div>
        ${statusChip(u)}
        <div class="user-stats">
          <span>הצטרף <b>${fmtDay(u.createdAt)}</b></span><span>כניסה אחרונה <b>${fmtDay(u.lastSeen)}</b></span>
          <span>אתרים <b>${u.st.sites ?? 0}</b></span><span>דוחות <b>${u.st.reports ?? 0}</b> (החודש ${u.st.reportsMonth ?? 0})</span>
          <span>תמונות <b>${u.st.photos ?? 0}</b></span><span>נפח <b>${fileSize(u.st.bytes || 0)}</b></span>
        </div>
        <div class="row-btns tight">
          ${u.acc !== 'approved' && u.acc !== 'blocked' && req ? `<button class="btn small primary" data-action="admin-access" data-uid="${u.id}" data-status="approved">✓ אשר</button>` : ''}
          ${u.acc === 'blocked'
            ? `<button class="btn small" data-action="admin-access" data-uid="${u.id}" data-status="">בטל חסימה</button>`
            : u.id !== state.user.uid ? `<button class="btn small danger" data-action="admin-access" data-uid="${u.id}" data-status="blocked">חסום</button>` : ''}
        </div>
      </div>`).join('') || '<p class="empty">אין עדיין משתמשים רשומים</p>'}
    </div>
    <p class="muted tiny">משתמש מופיע כאן מהכניסה הראשונה שלו אחרי העדכון. הנתונים מתעדכנים בכל פעם שהוא עובד באפליקציה. רשימה מלאה של כל החשבונות יש גם ב-<a class="link" href="https://console.firebase.google.com/project/bakar-project/authentication/users" target="_blank">Firebase → Authentication</a>.</p>
  </section>
  <section class="panel">
    <h2 class="panel-h">מנהלים</h2>
    <div class="file-row"><span class="row-main"><b dir="ltr">${cloud.SUPER_ADMIN}</b><small>מנהל ראשי (קבוע)</small></span></div>
    ${Object.values(admins).map((a) => `<div class="file-row"><span class="row-main"><b dir="ltr">${esc(a.email)}</b><small>נוסף ע"י ${esc(a.addedBy || '')} · ${fmtDay(a.at)}</small></span>
      <button class="icon-btn2" data-action="admin-remove" data-email="${esc(a.email)}" aria-label="הסר מנהל">✕</button></div>`).join('')}
    <form class="inline-form" data-action="admin-add">
      <input name="email" type="email" dir="ltr" placeholder="המייל של המנהל החדש" required>
      <button class="btn primary">הפוך למנהל</button>
    </form>
    <p class="muted tiny">מנהל רואה את כל המשתמשים ואת השימוש שלהם, מאשר וחוסם משתמשים ומוסיף מנהלים. כדי שההרשאה תעבוד, המנהל צריך להתחבר עם Google, או לאמת את כתובת המייל שלו. מנהלים לא רואים את תוכן הדוחות של משתמשים אחרים.</p>
  </section>`;
}

function viewGate() {
  const blocked = state.access.status === 'blocked';
  return `<section class="auth">
    <div class="auth-brand"><span class="brand-mark">◆</span> בקר</div>
    <h1>${blocked ? 'הגישה נחסמה' : 'ממתין לאישור'}</h1>
    <p class="muted">${blocked ? 'החשבון שלך נחסם על ידי מנהל המערכת. לבירור פנה למנהל.' : 'החשבון נוצר בהצלחה. מנהל המערכת צריך לאשר אותו לפני שאפשר להתחיל לעבוד. נשלחה אליו הודעה ברשימת המשתמשים.'}</p>
    <p class="muted tiny" dir="ltr">${esc(state.user.email || '')}</p>
    ${blocked ? '' : '<button class="btn primary full" data-action="access-recheck">בדוק שוב</button>'}
    <button class="btn ghost full" data-action="logout">התנתק</button>
  </section>`;
}

// עמוד ציבורי לנמען: פתיחת הדוח מהקישור, בלי צורך בחשבון
function viewShared(token) {
  setTimeout(async () => {
    const box = document.getElementById('shared');
    let d = null;
    try { d = await cloud.fetchShared(token); } catch (err) { console.error(err); }
    if (!box) return;
    if (!d?.pdf) {
      box.innerHTML = '<p class="empty">הדוח לא נמצא. ייתכן שהקישור שגוי או שהדוח נמחק.</p>';
      return;
    }
    const blob = await (await fetch(d.pdf)).blob();
    const url = URL.createObjectURL(blob);
    box.innerHTML = `
      <div class="shared-head">
        <span class="action-ico">▤</span>
        <span><b>${esc(d.title)}</b><small>${esc(d.site)}${d.date ? ` · ${formatDate(d.date)}` : ''}</small>
        ${d.company || d.inspector ? `<small>מאת: ${esc([d.inspector, d.company].filter(Boolean).join(' · '))}</small>` : ''}</span>
      </div>
      <div class="row-btns">
        <a class="btn primary" href="${url}" download="${esc(d.filename || 'report.pdf')}">⬇ הורד PDF</a>
        <a class="btn" href="${url}" target="_blank">פתח בחלון חדש</a>
      </div>
      ${isMobile() ? '' : `<iframe class="shared-frame" src="${url}" title="הדוח"></iframe>`}`;
  });
  return `<section class="panel shared" id="shared"><p class="empty">טוען את הדוח…</p></section>`;
}

function notFound() {
  return '<section class="panel"><p class="empty">לא נמצא. <a class="link" href="#/">חזרה לדף הבית</a></p></section>';
}

// ---------------- router ----------------
let current = { route: '', args: [] };
let authMode = 'login';
function viewLogin() {
  const signup = authMode === 'signup';
  return `
  <section class="auth">
    <div class="auth-brand"><span class="brand-mark">◆</span> בקר</div>
    <h1>${signup ? 'יצירת חשבון' : 'התחברות'}</h1>
    <p class="muted">מערכת דוחות לבקר בטיחות באתרי בנייה. הדוחות נשמרים בחשבון שלך וזמינים מכל מכשיר.</p>
    <button class="btn google full" data-action="google-login"><span class="g">G</span> המשך עם Google</button>
    <div class="or"><span>או עם אימייל</span></div>
    <form class="auth-form" data-action="${signup ? 'signup' : 'login'}">
      ${signup ? '<label class="field"><span>שם מלא</span><input name="name" autocomplete="name" required></label>' : ''}
      <label class="field"><span>אימייל</span><input name="email" type="email" dir="ltr" autocomplete="email" inputmode="email" required></label>
      <label class="field"><span>סיסמה</span><input name="password" type="password" dir="ltr" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6" required></label>
      <p class="auth-error" id="auth-error" role="alert"></p>
      <button class="btn primary full">${signup ? 'צור חשבון' : 'התחבר'}</button>
    </form>
    <div class="auth-links">
      ${signup ? '<button class="link" data-action="auth-mode" data-mode="login">כבר יש לי חשבון — התחברות</button>'
        : '<button class="link" data-action="auth-mode" data-mode="signup">אין לך חשבון? הרשמה</button><button class="link" data-action="reset-password">שכחתי סיסמה</button>'}
    </div>
  </section>`;
}

function render() {
  const hashParts = location.hash.replace(/^#\/?/, '').split('/');
  if (hashParts[0] === 'v' && hashParts[1]) {
    document.body.classList.add('logged-out', 'viewer');
    $view.innerHTML = viewShared(hashParts[1]);
    return;
  }
  document.body.classList.remove('viewer');
  if (!state.user) {
    $view.innerHTML = state.user === undefined ? '<div class="splash"><span class="brand-mark">◆</span></div>' : viewLogin();
    document.body.classList.add('logged-out');
    updateSyncBadge();
    return;
  }
  if (state.access.status === 'blocked' || state.access.status === 'pending') {
    $view.innerHTML = viewGate();
    document.body.classList.add('logged-out');
    return;
  }
  document.body.classList.remove('logged-out');
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route = '', ...args] = parts;
  current = { route, args };
  let html;
  switch (route) {
    case '': html = viewHome(); break;
    case 'new': html = viewNew(['risk', 'custom'].includes(args[0]) ? args[0] : 'visit', args[1]); break;
    case 'sites': html = args[0] ? viewSite(args[0]) : viewSites(); break;
    case 'reports': html = viewReports(); break;
    case 'r': html = viewReport(args[0], args[1]); break;
    case 'settings': html = viewSettings(); break;
    case 'forms': html = args[0] ? viewForm(args[0]) : viewForms(); break;
    case 'admin': html = viewAdmin(); break;
    default: html = notFound();
  }
  $view.innerHTML = html;
  const navRoute = route === 'new' ? 'new' : ['forms', 'admin'].includes(route) ? 'settings' : route || 'home';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === navRoute));
  if (route === 'r' && args[1] === 'preview') fitPaper();
  updateCrumb();
  updateSyncBadge();
}

function rerender() {
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function updateCrumb() {
  const { route, args } = current;
  const map = { '': '~', new: '~/חדש', sites: '~/אתרים', reports: '~/דוחות', settings: '~/הגדרות', forms: '~/טפסים', admin: '~/ניהול', r: '~/דוח' };
  let c = map[route] ?? '~';
  if (route === 'sites' && args[0]) c += `/${site(args[0])?.name || ''}`;
  if (route === 'r') {
    const r = report(args[0]);
    if (r) c = `~/${site(r.siteId)?.name || 'אתר'}/${reportTitle(r)}`;
  }
  document.getElementById('crumb').textContent = c;
}

function fitPaper() {
  const scale = document.getElementById('paper-scale');
  if (!scale) return;
  const avail = scale.parentElement.clientWidth;
  const k = Math.min(1, avail / 794);
  scale.style.transform = `scale(${k})`;
  scale.style.height = `${scale.firstElementChild.offsetHeight * k}px`;
}
window.addEventListener('resize', debounce(fitPaper, 100));

// ---------------- autosave bindings ----------------
const flashSaved = () => {
  const el = document.getElementById('saved');
  if (el) {
    el.textContent = 'נשמר ✓';
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 800);
  }
};
const persistReport = debounce(async (r) => (await saveReport(r), flashSaved()), 400);
const persistSite = debounce(async (s) => (await saveSite(s), flashSaved()), 400);
const persistSettings = debounce(async () => (await saveSettings(), flashSaved()), 400);

function inputValue(el) {
  return el.type === 'checkbox' ? el.checked : el.value;
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    const r = report(el.closest('[data-report-id]')?.dataset.reportId);
    if (!r) return;
    setPath(r, el.dataset.bind, inputValue(el));
    persistReport(r);
    if (el.dataset.printDefault) {
      state.settings.printDefaults[el.dataset.printDefault] = inputValue(el);
      persistSettings();
    }
    if (el.dataset.rerender) {
      saveReport(r).then(rerender);
    } else if (el.type === 'checkbox' || el.tagName === 'SELECT') refreshSteps(r);
  } else if (el.dataset.sbind) {
    const s = site(el.closest('[data-site-id]')?.dataset.siteId);
    if (!s) return;
    const [role, field] = el.dataset.sbind.split('.');
    if (field && typeof s[role] !== 'object') s[role] = { name: s[role] || '' };
    setPath(s, el.dataset.sbind, el.value);
    if (el.dataset.rerenderSite) saveSite(s).then(rerender);
    else persistSite(s);
  } else if (el.dataset.setbind) {
    setPath(state.settings, el.dataset.setbind, inputValue(el));
    persistSettings();
  } else if (el.dataset.template) {
    state.settings.templates[el.dataset.template] = el.value;
    persistSettings();
  } else if (el.dataset.action === 'filter-reports') {
    document.getElementById('report-list').innerHTML = reportListHTML(el.value.trim());
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if ((el.dataset.bind || el.dataset.setbind) && el.tagName === 'SELECT') el.dispatchEvent(new Event('input', { bubbles: true }));
  if (el.dataset.action === 'recip-toggle') actions['recip-toggle'](el);
  if (el.dataset.action === 'toggle-cloud') actions['toggle-cloud'](el);
  if (el.dataset.action === 'admin-approval') {
    cloud.setRequireApproval(el.checked).then(loadAdmin).catch(() => toast('אין הרשאה', 'danger'));
  }
});

function refreshSteps(r) {
  const steps = getSteps(r);
  document.querySelectorAll('.steps .step:not(.preview)').forEach((a, i) => {
    const done = stepProgress(r, steps[i]);
    a.classList.toggle('done', done);
    a.querySelector('.step-n').textContent = done ? '✓' : i + 1;
  });
}

// ---------------- actions ----------------
function nextNumber(siteId) {
  const nums = savedReports().filter((r) => r.siteId === siteId).map((r) => parseInt(r.number, 10)).filter((n) => n > 0);
  return String((nums.length ? Math.max(...nums) : 0) + 1);
}

// דוח חדש נוצר כטיוטה בזיכרון בלבד, ונשמר רק עם השינוי הראשון (סעיף 18)
function createReport(type, siteId, extra = {}, { save = false } = {}) {
  const ins = state.settings.inspector;
  const r = normalizeReport({
    id: uid(), type, siteId, status: 'draft', number: nextNumber(siteId),
    visitDate: today(), reportDate: today(),
    data: newReportData(type, { templates: state.settings.templates }), photos: [],
    inspector: { name: ins.name, title: ins.title, signature: ins.signature },
    createdAt: Date.now(), updatedAt: Date.now(),
    print: { ...state.settings.printDefaults },
    ...extra,
  });
  r._draft = true;
  state.reports.push(r);
  if (save) saveReport(r);
  location.hash = `#/r/${r.id}/0`;
  return r;
}

function startReport(type, siteId, formId) {
  const open = savedReports()
    .filter((r) => r.siteId === siteId && r.type === type && r.status !== 'sent' && (type !== 'custom' || r.data.formId === formId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (open && confirm(`יש כבר טיוטה פתוחה לאתר הזה: ${reportTitle(open)}${open.number ? ` #${open.number}` : ''} מ-${formatDate(open.visitDate)}.\n\nלהמשיך לערוך אותה?\n(אישור = להמשיך בטיוטה · ביטול = לפתוח דוח חדש)`)) {
    location.hash = `#/r/${open.id}/0`;
    return;
  }
  const extra = {};
  if (type === 'custom') {
    const form = state.settings.customForms.find((f) => f.id === formId);
    if (!form) return toast('הטופס לא נמצא', 'danger');
    extra.data = newReportData('custom', { form });
  }
  createReport(type, siteId, extra);
}

function openSignature(onSave) {
  const dlg = document.getElementById('sig-dialog');
  const pad = new SignaturePad(dlg.querySelector('canvas'));
  dlg.showModal();
  requestAnimationFrame(() => pad.resize());
  dlg.onclick = (e) => {
    const a = e.target.closest('[data-sig]')?.dataset.sig;
    if (a === 'clear') pad.clear();
    if (a === 'cancel') dlg.close();
    if (a === 'save') {
      if (pad.isEmpty()) return toast('החתימה ריקה');
      onSave(pad.toDataURL());
      dlg.close();
    }
  };
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

async function makeFile(r, kind) {
  const model = buildModel(r, site(r.siteId), state.settings);
  if (kind === 'pdf') return new File([await exportPdf(model)], `${model.filename}.pdf`, { type: 'application/pdf' });
  return new File([await exportDocx(model)], `${model.filename}.docx`, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

// שיתוף קובץ ה-PDF דרך חלון השיתוף של המכשיר (וואטסאפ, מייל, דרייב...). מחזיר false אם לא נתמך
async function shareFile(r, text) {
  const f = await makeFile(r, 'pdf');
  if (navigator.canShare?.({ files: [f] })) {
    try {
      await navigator.share({ files: [f], title: f.name, text });
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return 'cancel';
    }
  }
  download(f, f.name);
  return false;
}

const actions = {
  'new-report'(el) {
    startReport(el.dataset.type, el.dataset.site, el.dataset.form);
  },
  async 'add-site'() {
    const s = { id: uid(), name: '', createdAt: Date.now() };
    await saveSite(s);
    location.hash = `#/sites/${s.id}`;
  },
  async 'delete-site'(el) {
    const n = savedReports().filter((r) => r.siteId === el.dataset.site).length;
    if (!confirm(n ? `למחוק את האתר ואת ${n} הדוחות שלו?` : 'למחוק את האתר?')) return;
    await deleteSite(el.dataset.site);
    location.hash = '#/sites';
  },
  async 'delete-report'() {
    const r = report(current.args[0]);
    if (!confirm('למחוק את הדוח לצמיתות?')) return;
    await deleteReport(r);
    location.hash = '#/';
  },
  'reports-mode'(el) {
    ui.reportsMode = el.dataset.mode;
    rerender();
  },
  tri(el) {
    const r = report(current.args[0]);
    const row = getPath(r, el.dataset.path);
    row.status = row.status === el.dataset.val ? '' : el.dataset.val;
    persistReport(r);
    rerender();
    if (row.status === 'bad') document.querySelector(`[data-bind="${el.dataset.path}.note"]`)?.focus({ preventScroll: true });
  },
  'open-note'(el) {
    ui.openNotes.add(el.dataset.id);
    rerender();
    document.querySelector(`[data-bind="${el.dataset.path}.note"]`)?.focus({ preventScroll: true });
  },
  'tri-fill'(el) {
    const r = report(current.args[0]);
    r.data.sections[+el.dataset.si].rows.forEach((x) => {
      if (!x.status && !x.hidden && !x.header) x.status = 'ok';
    });
    persistReport(r);
    rerender();
  },
  'edit-list'(el) {
    const r = report(current.args[0]);
    const key = `${r.id}:${el.dataset.key}`;
    ui.editList = ui.editList === key ? null : key;
    rerender();
  },
  'row-hide'(el) {
    const r = report(current.args[0]);
    const sec = r.data.sections[+el.dataset.si];
    const row = sec.rows[+el.dataset.j];
    // שורה שהוספת ידנית נמחקת; שורה מהתבנית מוסתרת (ואפשר להחזיר אותה)
    if (row.custom) sec.rows.splice(+el.dataset.j, 1);
    else row.hidden = true;
    r.photos = r.photos.map((p) => (p.ref === `${sec.key}:${row.id}` ? { ...p, ref: sec.key } : p));
    persistReport(r);
    rerender();
  },
  'row-restore'(el) {
    const r = report(current.args[0]);
    delete getPath(r, el.dataset.path).hidden;
    persistReport(r);
    rerender();
  },
  'add-row'(el) {
    const r = report(current.args[0]);
    const rows = r.data.sections[+el.dataset.si].rows;
    rows.push({ id: rid(), label: '', status: '', note: '', level: 0, header: !!el.dataset.header, custom: true });
    persistReport(r);
    rerender();
    const inputs = document.querySelectorAll('.edit-row input');
    inputs[inputs.length - 1]?.focus();
  },
  'toggle-reason'(el) {
    const r = report(current.args[0]);
    const set = new Set(r.data.reasons);
    set.has(el.dataset.id) ? set.delete(el.dataset.id) : set.add(el.dataset.id);
    r.data.reasons = VISIT_REASONS.map((x) => x.id).filter((id) => set.has(id));
    persistReport(r);
    rerender();
  },
  async escalate(el) {
    const r = report(current.args[0]);
    const row = getPath(r, el.dataset.path);
    await saveReport(r);
    const data = newReportData('risk');
    data.riskText = `${row.label}${row.note ? `: ${row.note}` : ''}`;
    data.fromReport = r.id;
    // התמונות של השורה עוברות גם להודעה
    const [key] = el.dataset.path.split('.rows.');
    const sec = getPath(r, key);
    const photos = r.photos.filter((p) => p.ref === `${sec.key}:${row.id}`).map((p) => ({ ...p, id: uid(), ref: 'risk', _up: false }));
    createReport('risk', r.siteId, { data, visitDate: r.visitDate, photos }, { save: true });
    toast('נפתחה הודעת סיכון בלתי קביל (מסמך נפרד) — יש להפיץ מיידית', 'danger');
  },
  'mx-cell'(el) {
    const r = report(current.args[0]);
    r.data.severity = +el.dataset.sev;
    r.data.likelihood = +el.dataset.lik;
    persistReport(r);
    rerender();
  },
  async 'add-photo'(el) {
    const r = report(current.args[0]);
    const files = await pickFiles({ capture: !!el.dataset.capture, multiple: !el.dataset.capture });
    if (!files.length) return;
    for (const f of files) {
      const img = await compressImage(f);
      r.photos.push({ id: uid(), ...img, caption: el.dataset.caption || '', ref: el.dataset.ref || '' });
    }
    await saveReport(r);
    toast(el.dataset.ref ? `📷 נוספה לדוח ליד: ${photoPlace(r, el.dataset.ref).split(' › ').pop().slice(0, 40)}` : `נוספו ${files.length} תמונות לנספח`);
    rerender();
  },
  async 'del-photo'(el) {
    const r = report(current.args[0]);
    const i = r.photos.findIndex((p) => p.id === el.dataset.id);
    if (i < 0) return;
    const [removed] = r.photos.splice(i, 1);
    await saveReport(r);
    toCloud(cloud.removePhoto(removed.id));
    rerender();
  },
  async 'photo-to-appendix'(el) {
    const r = report(current.args[0]);
    const p = r.photos.find((x) => x.id === el.dataset.id);
    if (p) p.ref = '';
    await saveReport(r);
    rerender();
  },
  'sign-here'() {
    const r = report(current.args[0]);
    openSignature(async (sig) => {
      r.inspector.signature = sig;
      if (!state.settings.inspector.signature) {
        state.settings.inspector.signature = sig;
        await saveSettings();
      }
      await saveReport(r);
      rerender();
    });
  },
  async 'inspector-from-profile'() {
    const r = report(current.args[0]);
    const ins = state.settings.inspector;
    r.inspector = { name: ins.name, title: ins.title, signature: ins.signature };
    await saveReport(r);
    rerender();
  },
  'sign-profile'() {
    openSignature(async (sig) => {
      state.settings.inspector.signature = sig;
      await saveSettings();
      rerender();
    });
  },
  async 'upload-signature'() {
    const [f] = await pickFiles({ multiple: false });
    if (!f) return;
    state.settings.inspector.signature = (await compressImage(f, 600, 'image/png')).src;
    await saveSettings();
    rerender();
  },
  async 'upload-logo'() {
    const [f] = await pickFiles({ multiple: false });
    if (!f) return;
    state.settings.company.logo = (await compressImage(f, 600, 'image/png')).src;
    await saveSettings();
    rerender();
  },
  async 'remove-logo'() {
    state.settings.company.logo = '';
    await saveSettings();
    rerender();
  },
  async 'export-pdf'(el) {
    busy(el, true);
    try {
      const f = await makeFile(report(current.args[0]), 'pdf');
      download(f, f.name);
    } catch (err) {
      console.error(err);
      toast('שגיאה בהפקת PDF', 'danger');
    } finally {
      busy(el, false);
    }
  },
  async 'export-docx'(el) {
    busy(el, true);
    try {
      const f = await makeFile(report(current.args[0]), 'docx');
      download(f, f.name);
    } catch (err) {
      console.error(err);
      toast('שגיאה בהפקת Word', 'danger');
    } finally {
      busy(el, false);
    }
  },
  async share(el) {
    const r = report(current.args[0]);
    busy(el, true);
    try {
      const res = await shareFile(r, shareMessage(r));
      if (res === false) toast('השיתוף אינו נתמך בדפדפן זה — הקובץ הורד');
      if (res !== 'cancel') await rememberRecipients(r);
    } catch (err) {
      console.error(err);
      toast('השיתוף נכשל', 'danger');
    } finally {
      busy(el, false);
      rerender();
    }
  },
  // ---- תפוצה ----
  async 'recip-toggle'(el) {
    const r = report(current.args[0]);
    ownRecipients(r)[+el.dataset.i].on = el.checked;
    await saveReport(r);
    rerender();
  },
  async 'recip-remove'(el) {
    const r = report(current.args[0]);
    ownRecipients(r).splice(+el.dataset.i, 1);
    await saveReport(r);
    rerender();
  },
  async 'recip-reset'() {
    const r = report(current.args[0]);
    r.recipients = undefined;
    await saveReport(r);
    rerender();
  },
  'recip-add-toggle'() {
    ui.addRecipient = !ui.addRecipient;
    rerender();
    document.querySelector('.add-recip input')?.focus();
  },
  async 'send-wa'(el) {
    const r = report(current.args[0]);
    const x = recipients(r)[+el.dataset.i];
    // פותחים את החלון מיד (בתוך הלחיצה), אחרת הדפדפן חוסם אותו אחרי ההמתנה להעלאה
    const win = window.open('', '_blank');
    busy(el, true);
    try {
      const link = await shareLink(r);
      const url = `https://wa.me/${waNumber(x.phone)}?text=${encodeURIComponent(shareMessage(r, x.name, link))}`;
      if (win) win.location.href = url;
      else location.href = url;
      if (!link) await fallbackFile(r);
      await rememberRecipients(r);
    } catch (err) {
      win?.close();
      console.error(err);
      toast('השליחה נכשלה', 'danger');
    } finally {
      busy(el, false);
      rerender();
    }
  },
  async 'send-gmail'(el) {
    const r = report(current.args[0]);
    await openMail(r, [recipients(r)[+el.dataset.i]], isMobile() ? 'mailto' : 'gmail', el);
  },
  async 'send-gmail-all'(el) {
    const r = report(current.args[0]);
    await openMail(r, recipients(r).filter((x) => x.on), isMobile() ? 'mailto' : 'gmail', el);
  },
  async 'send-mail-all'(el) {
    const r = report(current.args[0]);
    await openMail(r, recipients(r).filter((x) => x.on), 'mailto', el);
  },
  async 'copy-link'(el) {
    const r = report(current.args[0]);
    busy(el, true);
    try {
      const link = await shareLink(r);
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        toast('הקישור לדוח הועתק ✓');
      } catch {
        prompt('העתק את הקישור:', link);
      }
    } finally {
      busy(el, false);
      rerender();
    }
  },
  async 'mark-sent'() {
    const r = report(current.args[0]);
    r.status = r.status === 'sent' ? 'draft' : 'sent';
    r.sentAt = r.status === 'sent' ? Date.now() : null;
    ui.askSent = null;
    await saveReport(r);
    toast(r.status === 'sent' ? 'סומן כהופץ ✓' : 'הוחזר לטיוטה');
    rerender();
  },
  // ---- הגדרות ----
  async 'dist-add'(el) {
    state.settings.distribution[el.dataset.type].push({ name: '', role: '', phone: '', email: '' });
    await saveSettings();
    rerender();
  },
  async 'dist-remove'(el) {
    state.settings.distribution[el.dataset.type].splice(+el.dataset.i, 1);
    await saveSettings();
    rerender();
  },
  async 'template-reset'(el) {
    delete state.settings.templates[el.dataset.key];
    await saveSettings();
    rerender();
  },
  async 'form-new'() {
    const f = newCustomForm();
    state.settings.customForms.push(f);
    await saveSettings();
    location.hash = `#/forms/${f.id}`;
  },
  async 'form-section-add'(el) {
    const f = state.settings.customForms[+el.dataset.i];
    f.sections.push({ id: rid(), title: `סעיף ${f.sections.length + 1}`, head: 'הפריט', labels: { ok: 'תקין', bad: 'לא תקין', na: 'לא רלוונטי' }, textLabel: 'פירוט והערות', items: '' });
    await saveSettings();
    rerender();
  },
  async 'form-section-remove'(el) {
    if (!confirm('למחוק את הסעיף מהטופס?')) return;
    state.settings.customForms[+el.dataset.i].sections.splice(+el.dataset.j, 1);
    await saveSettings();
    rerender();
  },
  async 'form-duplicate'(el) {
    const f = JSON.parse(JSON.stringify(state.settings.customForms[+el.dataset.i]));
    Object.assign(f, { id: rid(), name: `${f.name} (עותק)` });
    f.sections.forEach((s) => (s.id = rid()));
    state.settings.customForms.push(f);
    await saveSettings();
    location.hash = `#/forms/${f.id}`;
  },
  async 'form-delete'(el) {
    if (!confirm('למחוק את הטופס? דוחות שכבר נוצרו ממנו יישארו.')) return;
    state.settings.customForms.splice(+el.dataset.i, 1);
    await saveSettings();
    location.hash = '#/forms';
  },
  // ---- קבצים מצורפים לאתר ----
  async 'file-add'(el) {
    const s = site(el.dataset.site);
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.pdf,.doc,.docx,.xls,.xlsx,image/*';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1048576) return toast('הקובץ גדול מ-8MB', 'danger');
      const id = uid();
      const data = await readFileAsDataURL(f);
      await db.put('files', { id, data });
      s.files = [...arr(s.files), { id, name: f.name, type: f.type, size: f.size, at: Date.now() }];
      await saveSite(s);
      if (cloud.isSyncing()) toCloud(cloud.pushFile(id, data));
      toast('הקובץ צורף לאתר ✓');
      rerender();
    };
    inp.click();
  },
  async 'file-open'(el) {
    const meta = arr(site(el.dataset.site).files).find((f) => f.id === el.dataset.id);
    busy(el, true);
    try {
      let row = await db.get('files', el.dataset.id);
      if (!row) {
        const data = await cloud.fetchFile(el.dataset.id);
        if (!data) return toast('הקובץ לא נמצא במכשיר או בענן', 'danger');
        row = { id: el.dataset.id, data };
        await db.put('files', row);
      }
      download(await (await fetch(row.data)).blob(), meta?.name || 'file');
    } finally {
      busy(el, false);
    }
  },
  async 'file-remove'(el) {
    if (!confirm('למחוק את הקובץ?')) return;
    const s = site(el.dataset.site);
    s.files = arr(s.files).filter((f) => f.id !== el.dataset.id);
    await saveSite(s);
    await db.del('files', el.dataset.id);
    if (cloud.isSyncing()) toCloud(cloud.removeFile(el.dataset.id));
    rerender();
  },
  // ---- ניהול ----
  async 'admin-refresh'() {
    ui.admin = null;
    await loadAdmin();
  },
  async 'admin-access'(el) {
    await cloud.setAccess(el.dataset.uid, el.dataset.status || null);
    toast(el.dataset.status === 'blocked' ? 'המשתמש נחסם' : el.dataset.status === 'approved' ? 'המשתמש אושר ✓' : 'עודכן');
    await loadAdmin();
  },
  async 'approve-all'() {
    const ids = Object.keys(ui.admin.users).filter((id) => !ui.admin.access[id]);
    for (const id of ids) await cloud.setAccess(id, 'approved');
    toast(`אושרו ${ids.length} משתמשים`);
    await loadAdmin();
  },
  async 'admin-remove'(el) {
    if (!confirm(`להסיר את ${el.dataset.email} מהמנהלים?`)) return;
    await cloud.removeAdmin(el.dataset.email);
    await loadAdmin();
  },
  async 'verify-email'(el) {
    busy(el, true);
    try {
      await cloud.sendVerification();
      toast('נשלח מייל אימות. אחרי האישור לחץ "בדוק שוב"');
    } catch (err) {
      toast(cloud.authError(err), 'danger');
    } finally {
      busy(el, false);
    }
  },
  async 'access-recheck'(el) {
    busy(el, true);
    await cloud.reloadUser().catch(() => {});
    await checkAccess();
    busy(el, false);
    if (!['blocked', 'pending'].includes(state.access.status) && cloudEnabled() && !cloud.isSyncing()) startCloudSync(state.user);
    render();
  },
  'toggle-cloud'(el) {
    const on = el.checked;
    try { localStorage.setItem('bakar-cloud', on ? 'on' : 'off'); } catch {}
    if (on) {
      startCloudSync(state.user);
      toast('שמירה בענן הופעלה — הנתונים מסונכרנים');
    } else {
      cloud.stopSync();
      toast('שמירה בענן כובתה — הנתונים נשמרים רק במכשיר הזה');
    }
    updateSyncBadge();
  },
  async backup() {
    const data = await exportBackup();
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `bakar-backup-${today()}.json`);
  },
  async restore() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      try {
        await importData(parseBackup(JSON.parse(await inp.files[0].text())));
        toast('הגיבוי שוחזר ✓');
        rerender();
      } catch (err) {
        toast(err.message || 'שחזור נכשל', 'danger');
      }
    };
    inp.click();
  },
  'auth-mode'(el) {
    authMode = el.dataset.mode;
    render();
  },
  async 'google-login'(el) {
    busy(el, true);
    try {
      await cloud.signInGoogle();
    } catch (err) {
      showAuthError(err);
    } finally {
      busy(el, false);
    }
  },
  async 'reset-password'() {
    const email = document.querySelector('.auth-form [name=email]')?.value.trim();
    if (!email) return showAuthError({ message: 'הזן את האימייל שלך בשדה למעלה ולחץ שוב' });
    try {
      await cloud.resetPassword(email);
      toast('נשלח מייל לאיפוס סיסמה ✓');
    } catch (err) {
      showAuthError(err);
    }
  },
  async logout() {
    if (!confirm('להתנתק מהחשבון? הנתונים שמורים בענן ויחכו לך בהתחברות הבאה.')) return;
    await cloud.logOut();
    location.hash = '#/';
  },
  theme() {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bakar-theme', next); } catch {}
  },
};

async function openMail(r, list, kind, el) {
  const to = list.map((x) => x.email).filter(Boolean);
  if (!to.length) return toast('אין כתובות מייל לנמענים שנבחרו');
  const win = kind === 'gmail' ? window.open('', '_blank') : null;
  busy(el, true);
  try {
    const link = await shareLink(r);
    const subject = `${reportTitle(r)}${r.number ? ` ${r.number}` : ''} – ${site(r.siteId)?.name || ''} – ${formatDate(r.visitDate)}`;
    const body = shareMessage(r, list.length === 1 ? list[0].name : '', link);
    const url = kind === 'gmail'
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to.join(','))}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
      : `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (win) win.location.href = url;
    else location.href = url;
    if (!link) await fallbackFile(r);
    await rememberRecipients(r);
  } catch (err) {
    win?.close();
    console.error(err);
    toast('השליחה נכשלה', 'danger');
  } finally {
    busy(el, false);
    rerender();
  }
}

// כשאין קישור (בלי ענן / בלי רשת) — מורידים את ה-PDF כדי לצרף אותו ידנית
async function fallbackFile(r) {
  const f = await makeFile(r, 'pdf');
  download(f, f.name);
  toast('אין חיבור לענן, ולכן לא נוצר קישור. ה-PDF הורד — צרף אותו להודעה');
}

// קישור לדוח: ה-PDF נשמר בענן תחת מזהה אקראי שאי אפשר לנחש. מתעדכן אוטומטית אם הדוח השתנה מאז
async function shareLink(r) {
  if (!cloudEnabled() || !navigator.onLine) return null;
  const url = (t) => `${location.origin}${location.pathname}#/v/${t}`;
  if (r.shareToken && r.sharedVersion === r.updatedAt) return url(r.shareToken);
  const model = buildModel(r, site(r.siteId), state.settings);
  const blob = await exportPdf(model);
  const pdf = await readFileAsDataURL(blob);
  const token = r.shareToken || (crypto.randomUUID?.() || `${uid()}${uid()}`).replaceAll('-', '');
  try {
    await cloud.pushShared(token, {
      pdf, filename: `${model.filename}.pdf`, title: reportTitle(r), site: site(r.siteId)?.name || '',
      date: r.visitDate || '', company: state.settings.company.name || '', inspector: state.settings.inspector.name || '',
    });
  } catch (err) {
    console.error(err);
    toast('לא הצלחתי ליצור קישור בענן', 'danger');
    return null;
  }
  r.shareToken = token;
  r.updatedAt = Date.now();
  r.sharedVersion = r.updatedAt;
  await saveReport(r, { keepTime: true });
  return url(token);
}

document.addEventListener('click', (e) => {
  const cell = e.target.closest('.mx-cell[data-sev]');
  if (cell) return actions['mx-cell'](cell);
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (fn) {
    e.preventDefault();
    fn(el);
  }
});
document.addEventListener('keydown', (e) => {
  const cell = e.target.closest?.('.mx-cell[data-sev]');
  if (cell && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    actions['mx-cell'](cell);
  }
});
function showAuthError(err) {
  const el = document.getElementById('auth-error');
  if (el) el.textContent = cloud.authError(err);
  else toast(cloud.authError(err), 'danger');
}

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const action = form.dataset.action;
  if (action === 'login' || action === 'signup') {
    e.preventDefault();
    const f = new FormData(form);
    const btn = form.querySelector('button');
    busy(btn, true);
    try {
      if (action === 'signup') await cloud.signUp(f.get('email').trim(), f.get('password'), f.get('name')?.trim());
      else await cloud.signIn(f.get('email').trim(), f.get('password'));
    } catch (err) {
      showAuthError(err);
    } finally {
      busy(btn, false);
    }
    return;
  }
  if (action === 'recip-add') {
    e.preventDefault();
    const r = report(current.args[0]);
    const f = Object.fromEntries(new FormData(form));
    ownRecipients(r).push({ id: uid(), name: f.name.trim(), role: f.role.trim(), phone: f.phone.trim(), email: f.email.trim(), on: true, src: 'added' });
    ui.addRecipient = false;
    await saveReport(r);
    rerender();
    return;
  }
  if (action === 'admin-add') {
    e.preventDefault();
    const email = new FormData(form).get('email').trim().toLowerCase();
    if (!email) return;
    try {
      await cloud.addAdmin(email);
      toast(`${email} הוא עכשיו מנהל ✓`);
      await loadAdmin();
    } catch (err) {
      console.error(err);
      toast('אין הרשאה להוסיף מנהל', 'danger');
    }
    return;
  }
  if (action !== 'new-site-report') return;
  e.preventDefault();
  const name = new FormData(form).get('name').trim();
  if (!name) return;
  const s = { id: uid(), name, createdAt: Date.now() };
  await saveSite(s);
  startReport(form.dataset.type, s.id, form.dataset.form);
});

// ---------------- access & usage ----------------
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout')), ms))]);
async function checkAccess() {
  try {
    state.access = await withTimeout(cloud.myAccess(), 7000);
    try { localStorage.setItem(`bakar-access-${state.user.uid}`, JSON.stringify(state.access)); } catch {}
  } catch {
    // בלי רשת — משתמשים במצב האחרון שנשמר (הכללים בשרת אוכפים בכל מקרה)
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(`bakar-access-${state.user.uid}`)); } catch {}
    state.access = cached || { admin: false, status: 'open' };
  }
}

// נתוני שימוש שהמנהל רואה (סעיף 6): כמות אתרים, דוחות, תמונות ונפח משוער
function usageStats() {
  const reps = savedReports();
  const month = today().slice(0, 7);
  let bytes = 0;
  for (const r of reps) bytes += JSON.stringify({ ...r, photos: r.photos.map(({ src, ...m }) => m) }).length + r.photos.reduce((a, p) => a + (p.src?.length || 0), 0);
  for (const st of state.sites) bytes += JSON.stringify(st).length + arr(st.files).reduce((a, f) => a + Math.round((f.size || 0) * 1.37), 0);
  return {
    stats: {
      sites: state.sites.length,
      reports: reps.length,
      reportsMonth: reps.filter((r) => new Date(r.createdAt || 0).toISOString().slice(0, 7) === month).length,
      photos: reps.reduce((a, r) => a + r.photos.length, 0),
      bytes,
    },
  };
}
const reportUsage = debounce(() => {
  if (state.user && cloudEnabled()) cloud.updateUserIndex(usageStats()).catch(() => {});
}, 8000);

// ---------------- boot ----------------
// יציאה מדוח חדש שלא נערך — הטיוטה נזרקת ולא נוצרת כפילות (סעיף 18)
let lastReportId = null;
window.addEventListener('hashchange', () => {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const nowId = parts[0] === 'r' ? parts[1] : null;
  if (lastReportId && lastReportId !== nowId) {
    const prev = report(lastReportId);
    if (prev?._draft) state.reports = state.reports.filter((x) => x !== prev);
    ui.askSent = null;
    ui.addRecipient = false;
  }
  lastReportId = nowId;
  render();
  window.scrollTo(0, 0);
});

window.addEventListener('online', () => ((state.online = true), updateSyncBadge()));
window.addEventListener('offline', () => ((state.online = false), updateSyncBadge()));

// כל שינוי במצב ההתחברות: טוענים את העותק המקומי של המשתמש מיד, ואז מתחברים לענן
cloud.onUser(async (user) => {
  cloud.stopSync();
  if (!user) {
    state.user = null;
    await useDatabase(null);
    Object.assign(state, { sites: [], reports: [], settings: normalizeSettings(null) });
    render();
    return;
  }
  await useDatabase(user.uid);
  await load();
  state.user = user;
  // משתמש חדש: ממלאים שם ואימייל מהחשבון, ומעבירים נתונים שנשמרו במכשיר לפני ההתחברות לענן
  const ins = state.settings.inspector;
  if (!ins.name && user.displayName) ins.name = user.displayName;
  if (!ins.email && user.email) ins.email = user.email;
  const legacy = await takeLegacyData().catch(() => null);
  if (legacy) {
    await importData(legacy);
    await dropLegacyData();
    toast(`הועברו לחשבון ${legacy.reports.length} דוחות ו-${legacy.sites.length} אתרים מהמכשיר`);
  }
  await checkAccess();
  render();
  cloud.updateUserIndex(usageStats()).catch(() => {});
  if (state.access.status === 'blocked' || state.access.status === 'pending') return;
  if (cloudEnabled()) startCloudSync(user);
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
render();
