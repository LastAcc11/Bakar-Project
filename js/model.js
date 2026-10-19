// בונה "מודל מסמך" אחד מהדוח. ממנו מיוצרים גם התצוגה/PDF (render-html, export-pdf) וגם קובץ ה-Word (export-docx),
// כך שכל הפורמטים תמיד זהים בתוכן ובמבנה.
import {
  REGULATION, ROLES, REPORT_TYPES, VISIT_REASONS, DECLARATION, DEFAULT_SUMMARY, finalRisk, LEVEL_INFO,
} from './templates.js';

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export const contactOf = (s, role) => (typeof s?.[role] === 'object' && s[role] ? s[role] : { name: s?.[role] || '' });

// "שם, ח.פ./ת.ז. 123" + שורת פרטי התקשרות (סעיפים 6–7)
function contactText(c, withReach) {
  let t = c.name || '';
  if (c.idNumber) t += `${t ? ', ' : ''}ח.פ./ת.ז. ${c.idNumber}`;
  if (withReach) {
    const reach = [c.phone && `וואטסאפ/טל': ${c.phone}`, c.email && `דוא"ל: ${c.email}`].filter(Boolean).join(' | ');
    if (reach) t += `${t ? '\n' : ''}${reach}`;
  }
  return t;
}

function compileNotes(sec) {
  const lines = sec.rows
    .filter((r) => !r.hidden && !r.header && (r.note || '').trim())
    .map((r) => {
      const st = r.status && r.status !== 'bad' ? ` (${sec.labels[r.status]})` : '';
      return `• ${r.label}${st}: ${r.note.trim()}`;
    });
  if ((sec.text || '').trim()) lines.push(sec.text.trim());
  return lines.join('\n');
}

// תמונות שצולמו מתוך שורה/סעיף מוצגות בגוף הדוח, ליד הסעיף (סעיף 9); השאר בנספח
function photosFor(photos, used, match) {
  const list = photos.filter((p) => p.ref && !used.has(p.id) && match(p.ref));
  list.forEach((p) => used.add(p.id));
  return list;
}

// הגדרות הדפסה (לכל דוח): הסתרת שורות שלא סומנו / סעיפים שלא סומנו בכלל
function printRows(sec, opts) {
  let rows = sec.rows.filter((r) => !r.hidden);
  if (opts.hideUnmarked) {
    const keep = (r) => r.status || (r.note || '').trim();
    // כותרת קבוצה נשארת רק אם יש מתחתיה שורה שנשארת
    rows = rows.filter((r, i) => {
      if (!r.header) return keep(r);
      for (let j = i + 1; j < rows.length && !rows[j].header; j++) if (keep(rows[j])) return true;
      return false;
    });
  }
  return rows;
}
export function sectionIsEmpty(sec, photos) {
  return !sec.rows.some((r) => !r.hidden && !r.header && (r.status || (r.note || '').trim()))
    && !(sec.text || '').trim()
    && !photos.some((p) => p.ref === sec.key || (p.ref || '').startsWith(`${sec.key}:`));
}

function sectionBlocks(sec, photos, used, { blankLines, num, opts }) {
  const out = [];
  const rows = printRows(sec, opts);
  if (sec.group) out.push({ t: 'h', num: '', text: sec.group });
  if (num) out.push({ t: 'h', num, text: sec.title, ref: sec.ref });
  else out.push({ t: 'sub', text: `${sec.title}:` });
  if (rows.length) {
    out.push({
      t: 'tri', head: sec.head, labels: sec.labels,
      rows: rows.map((r) => ({ label: r.label, status: r.status, level: r.level || 0, header: !!r.header })),
    });
  }
  const notes = compileNotes(sec);
  if (notes || (blankLines && !opts.hideEmptySections)) out.push({ t: 'text', label: sec.textLabel, value: notes });
  const pics = photosFor(photos, used, (ref) => ref === sec.key || ref.startsWith(`${sec.key}:`));
  if (pics.length) out.push({ t: 'photos', inline: true, label: 'תמונות לסעיף', items: pics });
  return out;
}

export function buildModel(report, site, settings) {
  const T = REPORT_TYPES[report.type];
  const s = site || {};
  const d = report.data;
  const inspector = report.inspector || settings.inspector || {};
  const photos = report.photos || [];
  const used = new Set();
  const blocks = [];
  const title = report.type === 'custom' ? d.formTitle || 'דו"ח' : T.title;
  const opts = { hideUnmarked: !!report.print?.hideUnmarked, hideEmptySections: !!report.print?.hideEmptySections };
  const visibleSecs = (list) => (opts.hideEmptySections ? list.filter((sec) => !sectionIsEmpty(sec, photos)) : list);

  blocks.push({
    t: 'meta',
    date: formatDate(report.reportDate),
    number: report.number || '',
    to: T.recipients.map((role) => {
      const c = contactText(contactOf(s, role), false);
      return c ? `${ROLES[role]} – ${c}` : ROLES[role];
    }),
  });
  blocks.push({ t: 'title', text: title, site: s.name || 'שם אתר' });
  if (report.type === 'custom') {
    if (d.formSubtitle) blocks.push({ t: 'note', text: d.formSubtitle });
  } else {
    blocks.push({ t: 'note', text: `בהתאם לדרישות סעיף ${T.clause} ל${REGULATION}` });
    blocks.push({ t: 'note', text: T.distribution });
  }

  const general = [
    ['שם האתר', s.name],
    ['מען/מיקום האתר', s.address],
    ...Object.keys(ROLES).map((role) => [ROLES[role], contactText(contactOf(s, role), true)]),
    ['תאריך הביקור', formatDate(report.visitDate)],
  ];
  if ((d.distMethod || '').trim()) general.push(['אופן ההפצה', d.distMethod]);

  if (report.type === 'visit') {
    const [docs, checks, ...rest] = d.sections;
    blocks.push({ t: 'h', num: '1', text: '(א) נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    const pre = visibleSecs([docs, checks].filter(Boolean));
    // כותרת "(ב) שלב טרום תחילת עבודה" שייכת לסעיף הראשון; אם הוא הוסתר — עוברת לבא אחריו
    if (pre.length && !pre[0].group && docs?.group) pre[0] = { ...pre[0], group: docs.group };
    for (const sec of pre) blocks.push(...sectionBlocks(sec, photos, used, { blankLines: false, opts }));

    blocks.push({ t: 'h', num: '2', text: 'הגדרת הביקור', ref: "[בהתאם לדרישות סעיף 2א'(ב)(1) לתקנה]" });
    blocks.push({ t: 'sub', text: 'סיבת הביקור:' });
    blocks.push({ t: 'checklist', items: VISIT_REASONS.map((r) => ({ label: r.label, level: 0, checked: d.reasons.includes(r.id) })) });

    visibleSecs(rest).forEach((sec, i) => blocks.push(...sectionBlocks(sec, photos, used, { blankLines: true, num: String(i + 3), opts })));

    blocks.push({ t: 'declaration', text: DECLARATION });
    const summary = d.summary ?? settings.defaultSummary ?? DEFAULT_SUMMARY;
    if ((summary || '').trim()) blocks.push({ t: 'summary', label: 'סיכום מקצועי', text: summary });
  } else if (report.type === 'custom') {
    blocks.push({ t: 'h', num: '1', text: 'נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    visibleSecs(d.sections).forEach((sec, i) => blocks.push(...sectionBlocks(sec, photos, used, { blankLines: false, num: String(i + 2), opts })));
    if ((d.summary || '').trim()) blocks.push({ t: 'text', label: d.summaryLabel || 'סיכום והערות', value: d.summary });
  } else {
    blocks.push({ t: 'h', num: '1', text: 'נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    const res = finalRisk(d);
    if (d.showMatrix !== false) blocks.push({ t: 'matrix', sev: d.severity, lik: d.likelihood, result: res });
    else if (res) blocks.push({ t: 'text', label: 'דירוג הסיכון', value: `${LEVEL_INFO[res.level].label}${res.score && !res.manual ? ` (ציון ${res.score})` : ''}` });
    const text = (label, value) => {
      if ((value || '').trim() || !opts.hideEmptySections) blocks.push({ t: 'text', label, value });
    };
    text('פירוט הסיכון הבלתי קביל שנמצא', d.riskText);
    const pics = photosFor(photos, used, (ref) => ref === 'risk');
    if (pics.length) blocks.push({ t: 'photos', inline: true, label: 'תמונות הסיכון', items: pics });
    text('המענה הנדרש למימוש', d.requiredResponse);
    text('פעולות מתקנות מיידיות שבוצעו', d.correctiveActions);
    text('ממצאים/ליקויים נוספים לדיווח', d.otherFindings);
  }

  blocks.push({
    t: 'signature',
    intro: report.type === 'risk' ? 'בזאת באתי על החתום, בקר הבטיחות:' : 'בזאת באתי על החתום,',
    name: inspector.name || '',
    title: inspector.title || '',
    signature: inspector.signature || '',
  });

  const appendix = photos.filter((p) => !used.has(p.id));
  if (appendix.length) {
    blocks.push({ t: 'photos', label: 'נספח:', sub: 'תמונות, טפסים, תסקירים וכיוצ"ב לתיעוד', items: appendix });
  }
  // מספור רציף של התמונות לפי סדר הופעתן במסמך
  let n = 0;
  for (const b of blocks) if (b.t === 'photos') b.items = b.items.map((p) => ({ ...p, n: ++n }));

  const typeName = report.type === 'custom' ? d.formTitle || 'דו"ח' : T.name;
  return {
    blocks,
    header: { company: settings.company?.name || '', logo: settings.company?.logo || '', slogan: settings.company?.slogan || '' },
    filename: `${typeName}${report.number ? ` ${report.number}` : ''} - ${s.name || 'אתר'} - ${formatDate(report.visitDate || report.reportDate).replaceAll('/', '.')}`.replace(/[\\/:*?"<>|]/g, ''),
  };
}
