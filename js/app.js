import { db, uid, exportBackup, importBackup } from './db.js';
import {
  REPORT_TYPES, ROLES, VISIT_REASONS, MANDATORY_STAGES, MAX_DAYS_BETWEEN_VISITS, PRESTART_DOCS, PRESTART_CHECKS,
  SIGNER_TITLES, DECLARATION, DEFAULT_SUMMARY, STATUS, LEVEL_INFO, SEVERITY, LIKELIHOOD, riskLevel, newReportData,
} from './templates.js';
import { buildModel, formatDate } from './model.js';
import { renderPaper, matrixTable, esc } from './render-html.js';
import { exportDocx } from './export-docx.js';
import { exportPdf } from './export-pdf.js';
import { SignaturePad } from './signature.js';

// ---------------- state ----------------
const state = { settings: null, sites: [], reports: [] };
const $view = document.getElementById('view');
const today = () => new Date().toISOString().slice(0, 10);
const DAY = 86400000;
const daysBetween = (a, b) => Math.floor((new Date(b) - new Date(a)) / DAY);
const addDays = (iso, n) => new Date(new Date(iso).getTime() + n * DAY).toISOString().slice(0, 10);

const DEFAULT_SETTINGS = {
  inspector: { name: '', title: SIGNER_TITLES[0], phone: '', email: '', signature: '' },
  company: { name: '', logo: '' },
  defaultSummary: DEFAULT_SUMMARY,
};

async function load() {
  const saved = await db.getKV('settings', null);
  state.settings = {
    ...DEFAULT_SETTINGS, ...saved,
    inspector: { ...DEFAULT_SETTINGS.inspector, ...saved?.inspector },
    company: { ...DEFAULT_SETTINGS.company, ...saved?.company },
  };
  state.sites = await db.all('sites');
  state.reports = await db.all('reports');
}
const saveSettings = () => db.setKV('settings', state.settings);
const site = (id) => state.sites.find((s) => s.id === id);
const report = (id) => state.reports.find((r) => r.id === id);

async function saveSite(s) {
  s.updatedAt = Date.now();
  if (!state.sites.includes(s)) state.sites.push(s);
  await db.put('sites', s);
}
async function saveReport(r) {
  r.updatedAt = Date.now();
  if (!state.reports.includes(r)) state.reports.push(r);
  await db.put('reports', r);
}

// ---------------- utils ----------------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
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

async function compressImage(file, max = 1600, type = 'image/jpeg', quality = 0.82) {
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

const contactName = (c) => (typeof c === 'string' ? c : c?.name || '');

// ---------------- site analytics ----------------
function siteStats(s) {
  const visits = state.reports.filter((r) => r.siteId === s.id && r.type === 'visit' && r.visitDate);
  const risks = state.reports.filter((r) => r.siteId === s.id && r.type === 'risk');
  const stages = new Set(visits.flatMap((v) => v.data.reasons || []));
  const last = visits.map((v) => v.visitDate).sort().pop() || null;
  const due = last ? addDays(last, MAX_DAYS_BETWEEN_VISITS) : null;
  const left = due ? daysBetween(today(), due) : null;
  return { visits, risks, stages, last, due, left };
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
  if (!r.visitDate) return null;
  // 48 שעות ממועד הביקור — שעת הביקור לא נשמרת, לכן מחשבים לפי תאריך: עד יומיים אחרי יום הביקור
  const due = addDays(r.visitDate, REPORT_TYPES.visit.deadlineHours / 24);
  const left = daysBetween(today(), due);
  if (left < 0) return { label: `עבר מועד ההפצה (${formatDate(due)})`, kind: 'danger' };
  return { label: left === 0 ? 'להפצה עד היום' : `להפצה עד ${formatDate(due)}`, kind: left === 0 ? 'warn' : '' };
}

function reportRow(r) {
  const s = site(r.siteId);
  const dl = reportDeadline(r);
  const T = REPORT_TYPES[r.type];
  return `<a class="row" href="#/r/${r.id}/${r.status === 'sent' ? 'preview' : '0'}">
    <span class="row-ico ${r.type}">${r.type === 'risk' ? '⚠' : '▤'}</span>
    <span class="row-main"><b>${esc(s?.name || 'אתר ללא שם')}</b><small>${esc(T.name)} · ${formatDate(r.visitDate)}${r.number ? ` · #${esc(r.number)}` : ''}</small></span>
    <span class="row-end">${r.status === 'sent' ? '<span class="chip ok">הופץ</span>' : dl ? `<span class="chip ${dl.kind}">${dl.label}</span>` : '<span class="chip">טיוטה</span>'}</span>
  </a>`;
}

// ---------------- views ----------------
function viewHome() {
  const name = state.settings.inspector.name;
  const pending = state.reports.filter((r) => r.status !== 'sent').sort((a, b) => b.updatedAt - a.updatedAt);
  const sent = state.reports.filter((r) => r.status === 'sent').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6);
  const sites = [...state.sites].map((s) => ({ s, st: siteStats(s) }));
  const overdue = sites.filter(({ st }) => st.last && st.left <= 14);
  sites.sort((a, b) => (a.st.left ?? 1e9) - (b.st.left ?? 1e9));

  return `
  <section class="hero">
    <div class="prompt"><span class="caret">❯</span> שלום${name ? `, ${esc(name)}` : ''}</div>
    <p class="muted">מה מתעדים היום?</p>
    <div class="actions">
      <a class="action" href="#/new/visit"><span class="action-ico">▤</span><span><b>דו"ח ביקור</b><small>ביקורת שלב / רבעונית · הפצה תוך 48 ש'</small></span></a>
      <a class="action danger" href="#/new/risk"><span class="action-ico">⚠</span><span><b>סיכון בלתי קביל</b><small>הודעה מיידית לכל המכותבים</small></span></a>
    </div>
  </section>
  ${!name || !state.settings.inspector.signature ? `<a class="banner" href="#/settings">⚙ השלם את פרופיל הבקר (שם, תואר וחתימה) — הם ייכנסו אוטומטית לכל דוח ←</a>` : ''}
  ${overdue.length ? `<section class="panel"><h2 class="panel-h">⏱ תזכורות ביקור <small>לפחות אחת ל-3 חודשים</small></h2>
    ${overdue.map(({ s, st }) => `<a class="row" href="#/sites/${s.id}"><span class="row-main"><b>${esc(s.name)}</b><small>ביקור אחרון ${formatDate(st.last)}</small></span><span class="row-end">${dueChip(st)}</span></a>`).join('')}
  </section>` : ''}
  <section class="panel"><h2 class="panel-h">טיוטות וממתינים להפצה <small>${pending.length}</small></h2>
    ${pending.length ? pending.map(reportRow).join('') : '<p class="empty">אין דוחות פתוחים 🎉</p>'}
  </section>
  <section class="panel"><h2 class="panel-h">אתרים <a class="link" href="#/sites">כל האתרים ←</a></h2>
    ${sites.length ? sites.slice(0, 6).map(({ s, st }) => `<a class="site-card" href="#/sites/${s.id}">
        <div class="site-top"><b>${esc(s.name || 'ללא שם')}</b>${dueChip(st)}</div>
        <small class="muted">${esc(s.address || '')}</small>${stageDots(st)}</a>`).join('')
      : '<p class="empty">עוד לא נוספו אתרים. אתר נוצר אוטומטית כשפותחים דוח ראשון.</p>'}
  </section>
  ${sent.length ? `<section class="panel"><h2 class="panel-h">הופצו לאחרונה <a class="link" href="#/reports">כל הדוחות ←</a></h2>${sent.map(reportRow).join('')}</section>` : ''}`;
}

function viewNew(type) {
  const T = REPORT_TYPES[type];
  const sites = [...state.sites].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>${esc(T.name)} חדש</h1></div>
  <section class="panel">
    <h2 class="panel-h">באיזה אתר?</h2>
    <form class="inline-form" data-action="new-site-report" data-type="${type}">
      <input name="name" placeholder="שם אתר חדש…" required autocomplete="off">
      <button class="btn primary">צור ←</button>
    </form>
    ${sites.map((s) => {
      const st = siteStats(s);
      return `<button class="row" data-action="new-report" data-type="${type}" data-site="${s.id}">
        <span class="row-main"><b>${esc(s.name)}</b><small>${esc(s.address || '')}${st.last ? ` · ביקור אחרון ${formatDate(st.last)}` : ''}</small></span>
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
      <small class="muted">${esc(s.address || '')} · ${st.visits.length} ביקורים · ${st.risks.length} הודעות סיכון</small>${stageDots(st)}</a>`;
  }).join('') : '<p class="empty">אין אתרים עדיין</p>'}
  </section>`;
}

function contactFields(s, role) {
  const c = typeof s[role] === 'object' && s[role] ? s[role] : { name: s[role] || '' };
  return `<fieldset class="contact"><legend>${ROLES[role]}</legend>
    <input data-sbind="${role}.name" value="${esc(c.name)}" placeholder="שם / חברה">
    <div class="two">
      <input data-sbind="${role}.email" value="${esc(c.email || '')}" placeholder="אימייל" type="email" dir="ltr" inputmode="email">
      <input data-sbind="${role}.phone" value="${esc(c.phone || '')}" placeholder="טלפון" type="tel" dir="ltr" inputmode="tel">
    </div></fieldset>`;
}

function siteForm(s) {
  return `
    <label class="field"><span>שם האתר</span><input data-sbind="name" value="${esc(s.name || '')}" placeholder="לדוגמה: מגדלי הים, בניין B"></label>
    <label class="field"><span>מען / מיקום האתר</span><input data-sbind="address" value="${esc(s.address || '')}" placeholder="רחוב, עיר / גוש-חלקה"></label>
    <div class="contacts">${Object.keys(ROLES).map((r) => contactFields(s, r)).join('')}</div>`;
}

function viewSite(id) {
  const s = site(id);
  if (!s) return notFound();
  const st = siteStats(s);
  const reps = state.reports.filter((r) => r.siteId === id).sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
  return `
  <div class="page-h"><a class="back" href="#/sites">→</a><h1>${esc(s.name || 'אתר')}</h1></div>
  <section class="panel">
    <div class="site-top">${stageDots(st)}${dueChip(st)}</div>
    <div class="actions compact">
      <button class="action" data-action="new-report" data-type="visit" data-site="${s.id}"><span class="action-ico">▤</span><b>דו"ח ביקור</b></button>
      <button class="action danger" data-action="new-report" data-type="risk" data-site="${s.id}"><span class="action-ico">⚠</span><b>סיכון בלתי קביל</b></button>
    </div>
  </section>
  <section class="panel" data-site-id="${s.id}"><h2 class="panel-h">פרטי האתר ואנשי קשר <small class="saved" id="saved"></small></h2>${siteForm(s)}</section>
  <section class="panel"><h2 class="panel-h">דוחות <small>${reps.length}</small></h2>${reps.length ? reps.map(reportRow).join('') : '<p class="empty">אין דוחות לאתר זה</p>'}</section>
  <button class="btn ghost danger-text" data-action="delete-site" data-site="${s.id}">מחק אתר</button>`;
}

function viewReports() {
  const reps = [...state.reports].sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>כל הדוחות</h1></div>
  <section class="panel">
    <input class="search" placeholder="חיפוש לפי אתר…" data-action="filter-reports">
    <div id="report-list">${reps.length ? reps.map(reportRow).join('') : '<p class="empty">אין דוחות</p>'}</div>
  </section>`;
}

// ---------- report editor ----------
const STEPS = {
  visit: [
    { id: 'details', name: 'פרטים' },
    { id: 'prestart', name: 'טרום עבודה' },
    { id: 'reason', name: 'סיבת הביקור' },
    { id: 'risks', name: 'מענים לסיכונים' },
    { id: 'ppe', name: 'ציוד מגן' },
    { id: 'training', name: 'הדרכות' },
    { id: 'sign', name: 'סיכום וחתימה' },
    { id: 'photos', name: 'תמונות' },
  ],
  risk: [
    { id: 'details', name: 'פרטים' },
    { id: 'matrix', name: 'הערכת סיכון' },
    { id: 'actions', name: 'מענה ופעולות' },
    { id: 'sign', name: 'חתימה' },
    { id: 'photos', name: 'תמונות' },
  ],
};

function stepProgress(r, stepId) {
  const d = r.data;
  const tri = (rows) => rows.filter((x) => !x.other || x.label).every((x) => x.status);
  switch (stepId) {
    case 'details': return !!site(r.siteId)?.name && !!r.visitDate;
    case 'prestart': return Object.values(d.prestartDocs).some(Boolean) || Object.values(d.prestartChecks).some(Boolean);
    case 'reason': return d.reasons.length > 0;
    case 'risks': return tri(d.risks);
    case 'ppe': return tri(d.ppe);
    case 'training': return tri(d.training);
    case 'matrix': return !!(d.severity && d.likelihood && d.riskText.trim());
    case 'actions': return !!(d.requiredResponse.trim() || d.correctiveActions.trim());
    case 'sign': return !!(r.inspector?.name && r.inspector?.signature);
    case 'photos': return (r.photos || []).length > 0;
  }
  return false;
}

function triSection(r, key, textKey, textLabel, head) {
  const rows = r.data[key];
  const count = (k) => rows.filter((x) => x.status === k).length;
  return `
  <div class="tri-tools">
    <span class="tri-count"><span class="ok">✓ ${count('ok')}</span><span class="bad">✗ ${count('bad')}</span><span class="na">— ${count('na')}</span></span>
    <button class="btn small" data-action="tri-fill" data-key="${key}">סמן את הנותרים כ"תקין"</button>
  </div>
  <div class="tri-list" role="list" aria-label="${esc(head)}">
  ${rows.map((x, i) => {
    const p = `data.${key}.${i}`;
    return `<div class="tri-row ${x.status ? `is-${x.status}` : ''}" role="listitem">
      <div class="tri-label">${x.other ? `<input data-bind="${p}.label" value="${esc(x.label)}" placeholder="אחר — נושא נוסף…">` : esc(x.label)}</div>
      <div class="seg" role="radiogroup">${['ok', 'bad', 'na'].map((k) => `<button class="seg-${k} ${x.status === k ? 'on' : ''}" data-action="tri" data-path="${p}" data-val="${k}" role="radio" aria-checked="${x.status === k}">${STATUS[k].icon}<span>${STATUS[k].label}</span></button>`).join('')}</div>
      ${x.status === 'bad' ? `<div class="tri-note">
        <textarea data-bind="${p}.note" rows="2" placeholder="פירוט הליקוי / המענה שאינו מיושם…">${esc(x.note)}</textarea>
        <div class="tri-note-actions">
          <button class="btn small" data-action="add-photo" data-caption="${esc(x.label || 'אחר')}">📷 צרף תמונה</button>
          ${r.type === 'visit' ? `<button class="btn small danger" data-action="escalate" data-path="${p}">⚠ פתח הודעת סיכון בלתי קביל</button>` : ''}
        </div></div>` : ''}
    </div>`;
  }).join('')}
  </div>
  <label class="field"><span>${esc(textLabel)} <small class="muted">(הערות שנכתבו לליקויים למעלה נכנסות אוטומטית)</small></span>
    <textarea data-bind="data.${textKey}" rows="3" placeholder="פירוט נוסף…">${esc(r.data[textKey])}</textarea></label>`;
}

function signStep(r) {
  const ins = r.inspector || {};
  const summary = r.data.summary ?? state.settings.defaultSummary;
  return `
  ${r.type === 'visit' ? `
    <div class="decl"><b>הצהרה</b><p>${esc(DECLARATION)}</p></div>
    <label class="field"><span>סיכום מקצועי <small class="muted">(ברירת המחדל נקבעת בהגדרות)</small></span>
      <textarea data-bind="data.summary" rows="6">${esc(summary)}</textarea></label>` : ''}
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

function photosStep(r) {
  const photos = r.photos || [];
  return `
  <p class="muted">תמונות, טפסים, תסקירים וכיו"ב לתיעוד — יופיעו כנספח בסוף הדוח.</p>
  <div class="row-btns">
    <button class="btn primary" data-action="add-photo" data-capture="1">📷 צלם</button>
    <button class="btn" data-action="add-photo">🖼 בחר מהגלריה</button>
  </div>
  <div class="photo-grid">
  ${photos.map((p, i) => `<figure class="photo">
      <img src="${p.src}" alt="">
      <input data-bind="photos.${i}.caption" value="${esc(p.caption || '')}" placeholder="כיתוב לתמונה…">
      <button class="icon-btn" data-action="del-photo" data-i="${i}" aria-label="מחק תמונה">✕</button>
    </figure>`).join('')}
  </div>`;
}

function stepBody(r, stepId) {
  const s = site(r.siteId) || {};
  const d = r.data;
  const T = REPORT_TYPES[r.type];
  switch (stepId) {
    case 'details': {
      const st = siteStats(s);
      return `
      <div class="grid3">
        <label class="field"><span>תאריך הביקור</span><input type="date" data-bind="visitDate" value="${r.visitDate || ''}"></label>
        <label class="field"><span>תאריך הדו"ח</span><input type="date" data-bind="reportDate" value="${r.reportDate || ''}"></label>
        <label class="field"><span>מס' דו"ח <small class="muted">(רשות)</small></span><input data-bind="number" value="${esc(r.number || '')}" inputmode="numeric"></label>
      </div>
      <div class="callout ${r.type === 'risk' ? 'danger' : ''}">
        <b>${esc(T.distribution)}</b><br>
        <small>מכותבים: ${T.recipients.map((x) => ROLES[x]).join(' · ')}</small>
        ${st.last && r.type === 'visit' ? `<br><small>ביקור קודם באתר: ${formatDate(st.last)}</small>` : ''}
      </div>
      <h3 class="step-sub">נתונים כלליים <small class="muted">— נשמרים באתר ומתמלאים אוטומטית בדוחות הבאים</small></h3>
      <div data-site-id="${s.id}">${siteForm(s)}</div>`;
    }
    case 'prestart':
      return `
      <h3 class="step-sub">מסמכים חובה <button class="btn small" data-action="check-all" data-group="prestartDocs">סמן הכל</button></h3>
      <div class="checks">${PRESTART_DOCS.map((i) => `<label class="check lvl${i.level || 0}"><input type="checkbox" data-bind="data.prestartDocs.${i.id}" ${d.prestartDocs[i.id] ? 'checked' : ''}><span>${esc(i.label)}</span></label>`).join('')}</div>
      <h3 class="step-sub">בדיקות הבקר: בקרה, ביקורת, התרעה <button class="btn small" data-action="check-all" data-group="prestartChecks">סמן הכל</button></h3>
      <div class="checks">${PRESTART_CHECKS.map((i) => `<label class="check"><input type="checkbox" data-bind="data.prestartChecks.${i.id}" ${d.prestartChecks[i.id] ? 'checked' : ''}><span>${esc(i.label)}</span></label>`).join('')}</div>`;
    case 'reason': {
      const st = siteStats(s);
      const prev = new Set(st.visits.filter((v) => v.id !== r.id).flatMap((v) => v.data.reasons));
      return `
      <p class="muted">סמן את סיבת הביקור [סעיף 2א'(ב)(1)]. ביקורת נדרשת לפחות בכל אחד מהשלבים, ולפחות אחת ל-3 חודשים.</p>
      <div class="chips-select">${VISIT_REASONS.map((x) => `<button class="pick ${d.reasons.includes(x.id) ? 'on' : ''}" data-action="toggle-reason" data-id="${x.id}" aria-pressed="${d.reasons.includes(x.id)}">
        <span class="pick-box">${d.reasons.includes(x.id) ? '✓' : ''}</span><span>${esc(x.label)}${prev.has(x.id) ? '<small>בוצע בעבר באתר זה</small>' : ''}</span></button>`).join('')}</div>`;
    }
    case 'risks':
      return triSection(r, 'risks', 'risksText', 'פירוט הליקויים או מענים שאינם מיושמים', 'הנושא');
    case 'ppe':
      return `<p class="muted">יש לוודא התאמה ותקינות הציוד לסוג העבודה המבוצעת.</p>${triSection(r, 'ppe', 'ppeText', 'פירוט הליקויים', 'הפריט')}`;
    case 'training':
      return triSection(r, 'training', 'trainingText', 'פירוט הליקויים ואיזה הדרכות חסרות?', 'הפריט');
    case 'matrix': {
      const res = riskLevel(d.severity, d.likelihood);
      return `
      <p class="muted">הקש על התא המתאים בלוח ההחלטה (חומרת פגיעה × הסתברות).</p>
      <div class="mx-wrap">${matrixTable({ sev: d.severity, lik: d.likelihood }, { interactive: true })}</div>
      ${res ? `<div class="mx-result mx-${res.level}"><b>${res.score}</b><span>${esc(LEVEL_INFO[res.level].label)}</span>
        <small>חומרה: ${esc(SEVERITY.find((x) => x.v === d.severity).name)} · הסתברות: ${esc(LIKELIHOOD.find((x) => x.v === d.likelihood).name)}</small></div>
        ${res.level !== 'red' ? '<p class="warn-text">⚠ הסיכון שנבחר אינו מוגדר "בלתי קביל" בלוח. ניתן עדיין להפיץ את הטופס כ"ממצא אחר".</p>' : ''}` : ''}
      <label class="field"><span>פירוט הסיכון הבלתי קביל שנמצא</span><textarea data-bind="data.riskText" rows="5" placeholder="מה נמצא, היכן באתר, מי חשוף…">${esc(d.riskText)}</textarea></label>
      <button class="btn small" data-action="add-photo" data-caption="הסיכון שנמצא">📷 צרף תמונה של הסיכון</button>`;
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
  const steps = STEPS[r.type];
  const idx = Math.min(Math.max(parseInt(stepArg, 10) || 0, 0), steps.length - 1);
  const step = steps[idx];
  const s = site(r.siteId);
  return `
  <div class="page-h"><a class="back" href="#/">→</a>
    <h1><span class="type-tag ${r.type}">${r.type === 'risk' ? '⚠' : '▤'} ${esc(REPORT_TYPES[r.type].name)}</span> ${esc(s?.name || '')}</h1>
    <small class="saved" id="saved">${r.status === 'sent' ? 'הופץ' : 'טיוטה'}</small>
  </div>
  <div class="editor">
    <nav class="steps" aria-label="שלבי הטופס">
      ${steps.map((x, i) => `<a href="#/r/${r.id}/${i}" class="step ${i === idx ? 'on' : ''} ${stepProgress(r, x.id) ? 'done' : ''}" ${i === idx ? 'aria-current="step"' : ''}>
        <span class="step-n">${stepProgress(r, x.id) ? '✓' : i + 1}</span><span>${esc(x.name)}</span></a>`).join('')}
      <a href="#/r/${r.id}/preview" class="step preview"><span class="step-n">⎙</span><span>תצוגה והפקה</span></a>
    </nav>
    <section class="step-panel" data-report-id="${r.id}">
      <h2 class="step-h"><span class="mono muted">${idx + 1}/${steps.length}</span> ${esc(step.name)}</h2>
      ${stepBody(r, step.id)}
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
  if (r.type === 'visit') {
    const d = r.data;
    if (!d.reasons.length) issues.push('לא סומנה סיבת ביקור');
    for (const [k, name] of [['risks', 'מענים לסיכונים'], ['ppe', 'ציוד מגן'], ['training', 'הדרכות']]) {
      const open = d[k].filter((x) => (!x.other || x.label) && !x.status).length;
      if (open) issues.push(`${name}: ${open} פריטים לא סומנו`);
      const noNote = d[k].filter((x) => x.status === 'bad' && !x.note.trim()).length;
      if (noNote && !d[`${k}Text`].trim()) issues.push(`${name}: ליקוי ללא פירוט`);
    }
  } else {
    const d = r.data;
    if (!d.severity || !d.likelihood) issues.push('לא נבחרה הערכת סיכון בלוח ההחלטה');
    if (!d.riskText.trim()) issues.push('חסר פירוט הסיכון');
    if (!d.requiredResponse.trim()) issues.push('חסר המענה הנדרש');
  }
  return issues;
}

function recipientsInfo(r) {
  const s = site(r.siteId) || {};
  return REPORT_TYPES[r.type].recipients.map((role) => {
    const c = typeof s[role] === 'object' && s[role] ? s[role] : { name: s[role] || '' };
    return { role, label: ROLES[role], ...c };
  });
}

function viewPreview(r) {
  const s = site(r.siteId);
  const model = buildModel(r, s, state.settings);
  const issues = validate(r);
  const recips = recipientsInfo(r);
  const emails = recips.map((x) => x.email).filter(Boolean);
  const dl = reportDeadline(r);
  return `
  <div class="page-h"><a class="back" href="#/r/${r.id}/0">→</a><h1>תצוגה והפקה</h1>${dl ? `<span class="chip ${dl.kind}">${dl.label}</span>` : r.status === 'sent' ? '<span class="chip ok">הופץ</span>' : ''}</div>
  <div class="preview-layout">
    <aside class="preview-side">
      <div class="panel">
        <div class="export-btns">
          <button class="btn primary" data-action="export-pdf">⬇ PDF</button>
          <button class="btn primary" data-action="export-docx">⬇ Word</button>
          <button class="btn" data-action="share">↗ שיתוף</button>
          <button class="btn" data-action="print">⎙ הדפסה</button>
        </div>
      </div>
      ${issues.length ? `<div class="panel issues"><h2 class="panel-h">לפני הפצה <small>${issues.length}</small></h2><ul>${issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '<div class="panel ok-panel">✓ הדוח מלא ומוכן להפצה</div>'}
      <div class="panel">
        <h2 class="panel-h">מכותבים</h2>
        ${recips.map((x) => `<div class="recip"><b>${esc(x.label)}</b><span>${esc(x.name || '—')}</span>${x.email ? `<small dir="ltr">${esc(x.email)}</small>` : ''}</div>`).join('')}
        ${emails.length ? `<a class="btn small" href="mailto:${emails.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(model.filename)}">✉ פתח מייל למכותבים</a>` : '<small class="muted">הוסף כתובות מייל בפרטי האתר כדי לשלוח בלחיצה</small>'}
        <p class="muted tiny">טיפ: בטלפון, "שיתוף" שולח את ה-PDF ישירות לוואטסאפ/מייל.</p>
        <button class="btn ${r.status === 'sent' ? '' : 'primary'} full" data-action="mark-sent">${r.status === 'sent' ? '↺ החזר לטיוטה' : '✓ סמן כהופץ'}</button>
      </div>
      <button class="btn ghost danger-text" data-action="delete-report">מחק דוח</button>
    </aside>
    <div class="paper-scroller"><div class="paper-scale" id="paper-scale">${renderPaper(model)}</div></div>
  </div>`;
}

function viewSettings() {
  const st = state.settings;
  const ins = st.inspector;
  return `
  <div class="page-h"><a class="back" href="#/">→</a><h1>הגדרות</h1><small class="saved" id="saved"></small></div>
  <section class="panel" data-settings>
    <h2 class="panel-h">פרופיל הבקר <small>ייכנס אוטומטית לכל דוח חדש</small></h2>
    <div class="grid2">
      <label class="field"><span>שם מלא</span><input data-setbind="inspector.name" value="${esc(ins.name)}"></label>
      <label class="field"><span>תואר</span><select data-setbind="inspector.title">${SIGNER_TITLES.map((t) => `<option ${t === ins.title ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="field"><span>טלפון</span><input data-setbind="inspector.phone" value="${esc(ins.phone)}" type="tel" dir="ltr"></label>
      <label class="field"><span>אימייל</span><input data-setbind="inspector.email" value="${esc(ins.email)}" type="email" dir="ltr"></label>
    </div>
    <div class="field"><span>חתימה</span>
      <div class="sig-box">${ins.signature ? `<img src="${ins.signature}" alt="חתימה">` : '<span class="muted">אין חתימה שמורה</span>'}</div>
      <div class="row-btns"><button class="btn small" data-action="sign-profile">✍ ${ins.signature ? 'חתום מחדש' : 'הוסף חתימה'}</button>
      <button class="btn small" data-action="upload-signature">🖼 העלה תמונת חתימה</button></div>
    </div>
  </section>
  <section class="panel" data-settings>
    <h2 class="panel-h">חברה ולוגו <small>מופיעים בכותרת הדוח</small></h2>
    <label class="field"><span>שם החברה</span><input data-setbind="company.name" value="${esc(st.company.name)}"></label>
    <div class="field"><span>לוגו</span>
      <div class="logo-box">${st.company.logo ? `<img src="${st.company.logo}" alt="לוגו">` : '<span class="muted">אין לוגו</span>'}</div>
      <div class="row-btns"><button class="btn small" data-action="upload-logo">העלה לוגו</button>${st.company.logo ? '<button class="btn small" data-action="remove-logo">הסר</button>' : ''}</div>
    </div>
  </section>
  <section class="panel" data-settings>
    <h2 class="panel-h">נוסח קבוע</h2>
    <label class="field"><span>סיכום מקצועי (ברירת מחדל לדוח ביקור)</span><textarea data-setbind="defaultSummary" rows="6">${esc(st.defaultSummary)}</textarea></label>
  </section>
  <section class="panel">
    <h2 class="panel-h">גיבוי ונתונים</h2>
    <p class="muted">כל הנתונים נשמרים רק במכשיר הזה. מומלץ לגבות מדי פעם, ולהשתמש בגיבוי כדי להעביר נתונים בין טלפון למחשב.</p>
    <div class="row-btns">
      <button class="btn" data-action="backup">⬇ הורד גיבוי</button>
      <button class="btn" data-action="restore">⬆ שחזר מגיבוי</button>
      <button class="btn" data-action="theme">◐ ערכת צבעים</button>
    </div>
    <p class="muted tiny mono">${state.sites.length} אתרים · ${state.reports.length} דוחות</p>
  </section>`;
}

function notFound() {
  return '<section class="panel"><p class="empty">לא נמצא. <a class="link" href="#/">חזרה לדף הבית</a></p></section>';
}

// ---------------- router ----------------
let current = { route: '', args: [] };
function render() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route = '', ...args] = parts;
  current = { route, args };
  let html;
  switch (route) {
    case '': html = viewHome(); break;
    case 'new': html = viewNew(args[0] === 'risk' ? 'risk' : 'visit'); break;
    case 'sites': html = args[0] ? viewSite(args[0]) : viewSites(); break;
    case 'reports': html = viewReports(); break;
    case 'r': html = viewReport(args[0], args[1]); break;
    case 'settings': html = viewSettings(); break;
    default: html = notFound();
  }
  $view.innerHTML = html;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === (route === 'new' ? 'new' : route || 'home')));
  if (route === 'r' && args[1] === 'preview') fitPaper();
  updateCrumb();
}

function rerender() {
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function updateCrumb() {
  const { route, args } = current;
  const map = { '': '~', new: '~/חדש', sites: '~/אתרים', reports: '~/דוחות', settings: '~/הגדרות', r: '~/דוח' };
  let c = map[route] ?? '~';
  if (route === 'sites' && args[0]) c += `/${site(args[0])?.name || ''}`;
  if (route === 'r') {
    const r = report(args[0]);
    if (r) c = `~/${site(r.siteId)?.name || 'אתר'}/${REPORT_TYPES[r.type].name}`;
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
    if (el.type === 'checkbox' || el.tagName === 'SELECT') refreshSteps(r);
  } else if (el.dataset.sbind) {
    const s = site(el.closest('[data-site-id]')?.dataset.siteId);
    if (!s) return;
    const [role, field] = el.dataset.sbind.split('.');
    if (field && typeof s[role] !== 'object') s[role] = { name: s[role] || '' };
    setPath(s, el.dataset.sbind, el.value);
    persistSite(s);
  } else if (el.dataset.setbind) {
    setPath(state.settings, el.dataset.setbind, el.value);
    persistSettings();
  } else if (el.dataset.action === 'filter-reports') {
    const q = el.value.trim();
    const reps = [...state.reports]
      .filter((r) => !q || (site(r.siteId)?.name || '').includes(q))
      .sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || ''));
    document.getElementById('report-list').innerHTML = reps.map(reportRow).join('') || '<p class="empty">לא נמצאו דוחות</p>';
  }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.bind && e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true }));
});

function refreshSteps(r) {
  const steps = STEPS[r.type];
  document.querySelectorAll('.steps .step:not(.preview)').forEach((a, i) => {
    const done = stepProgress(r, steps[i].id);
    a.classList.toggle('done', done);
    a.querySelector('.step-n').textContent = done ? '✓' : i + 1;
  });
}

// ---------------- actions ----------------
async function createReport(type, siteId, extra = {}) {
  const ins = state.settings.inspector;
  const r = {
    id: uid(), type, siteId, status: 'draft', number: '',
    visitDate: today(), reportDate: today(),
    data: newReportData(type), photos: [],
    inspector: { name: ins.name, title: ins.title, signature: ins.signature },
    createdAt: Date.now(),
    ...extra,
  };
  await saveReport(r);
  location.hash = `#/r/${r.id}/0`;
  return r;
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

const actions = {
  async 'new-report'(el) {
    await createReport(el.dataset.type, el.dataset.site);
  },
  async 'add-site'() {
    const s = { id: uid(), name: '', createdAt: Date.now() };
    await saveSite(s);
    location.hash = `#/sites/${s.id}`;
  },
  async 'delete-site'(el) {
    const n = state.reports.filter((r) => r.siteId === el.dataset.site).length;
    if (!confirm(n ? `למחוק את האתר ואת ${n} הדוחות שלו?` : 'למחוק את האתר?')) return;
    for (const r of state.reports.filter((x) => x.siteId === el.dataset.site)) await db.del('reports', r.id);
    await db.del('sites', el.dataset.site);
    await load();
    location.hash = '#/sites';
  },
  async 'delete-report'() {
    const r = report(current.args[0]);
    if (!confirm('למחוק את הדוח לצמיתות?')) return;
    await db.del('reports', r.id);
    state.reports = state.reports.filter((x) => x !== r);
    location.hash = '#/';
  },
  tri(el) {
    const r = report(current.args[0]);
    const row = getPath(r, el.dataset.path);
    row.status = row.status === el.dataset.val ? '' : el.dataset.val;
    persistReport(r);
    rerender();
    if (row.status === 'bad') {
      const ta = document.querySelector(`[data-bind="${el.dataset.path}.note"]`);
      ta?.focus({ preventScroll: true });
    }
  },
  'tri-fill'(el) {
    const r = report(current.args[0]);
    r.data[el.dataset.key].forEach((x) => {
      if (!x.status && (!x.other || x.label)) x.status = 'ok';
    });
    persistReport(r);
    rerender();
  },
  'check-all'(el) {
    const r = report(current.args[0]);
    const list = el.dataset.group === 'prestartDocs' ? PRESTART_DOCS : PRESTART_CHECKS;
    const all = list.every((i) => r.data[el.dataset.group][i.id]);
    list.forEach((i) => (r.data[el.dataset.group][i.id] = !all));
    persistReport(r);
    rerender();
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
    await createReport('risk', r.siteId, { data, visitDate: r.visitDate });
    toast('נפתחה הודעת סיכון בלתי קביל — יש להפיץ מיידית', 'danger');
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
      r.photos.push({ id: uid(), ...img, caption: el.dataset.caption || '' });
    }
    await saveReport(r);
    toast(`נוספו ${files.length} תמונות לנספח`);
    rerender();
  },
  async 'del-photo'(el) {
    const r = report(current.args[0]);
    r.photos.splice(+el.dataset.i, 1);
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
      const f = await makeFile(r, 'pdf');
      if (navigator.canShare?.({ files: [f] })) {
        await navigator.share({ files: [f], title: f.name, text: REPORT_TYPES[r.type].title });
      } else {
        download(f, f.name);
        toast('השיתוף אינו נתמך בדפדפן זה — הקובץ הורד');
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast('השיתוף נכשל', 'danger');
    } finally {
      busy(el, false);
    }
  },
  print() {
    window.print();
  },
  async 'mark-sent'() {
    const r = report(current.args[0]);
    r.status = r.status === 'sent' ? 'draft' : 'sent';
    r.sentAt = r.status === 'sent' ? Date.now() : null;
    await saveReport(r);
    toast(r.status === 'sent' ? 'סומן כהופץ ✓' : 'הוחזר לטיוטה');
    rerender();
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
        await importBackup(JSON.parse(await inp.files[0].text()));
        await load();
        toast('הגיבוי שוחזר ✓');
        rerender();
      } catch (err) {
        toast(err.message || 'שחזור נכשל', 'danger');
      }
    };
    inp.click();
  },
  theme() {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('bakar-theme', next); } catch {}
  },
};

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
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.dataset.action !== 'new-site-report') return;
  e.preventDefault();
  const name = new FormData(form).get('name').trim();
  if (!name) return;
  const s = { id: uid(), name, createdAt: Date.now() };
  await saveSite(s);
  await createReport(form.dataset.type, s.id);
});

// ---------------- boot ----------------
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo(0, 0);
});

(async function boot() {
  await load();
  render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
