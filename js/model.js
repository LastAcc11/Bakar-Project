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

function sectionBlocks(sec, photos, used, { blankLines }) {
  const out = [];
  const rows = sec.rows.filter((r) => !r.hidden);
  if (sec.group) out.push({ t: 'h', num: '', text: sec.group });
  if (sec.num) out.push({ t: 'h', num: sec.num, text: sec.title, ref: sec.ref });
  else out.push({ t: 'sub', text: `${sec.title}:` });
  if (rows.length) {
    out.push({
      t: 'tri', head: sec.head, labels: sec.labels,
      rows: rows.map((r) => ({ label: r.label, status: r.status, level: r.level || 0, header: !!r.header })),
    });
  }
  const notes = compileNotes(sec);
  if (notes || blankLines) out.push({ t: 'text', label: sec.textLabel, value: notes });
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
    for (const sec of [docs, checks].filter(Boolean)) blocks.push(...sectionBlocks(sec, photos, used, { blankLines: false }));

    blocks.push({ t: 'h', num: '2', text: 'הגדרת הביקור', ref: "[בהתאם לדרישות סעיף 2א'(ב)(1) לתקנה]" });
    blocks.push({ t: 'sub', text: 'סיבת הביקור:' });
    blocks.push({ t: 'checklist', items: VISIT_REASONS.map((r) => ({ label: r.label, level: 0, checked: d.reasons.includes(r.id) })) });

    for (const sec of rest) blocks.push(...sectionBlocks(sec, photos, used, { blankLines: true }));

    blocks.push({ t: 'declaration', text: DECLARATION });
    const summary = d.summary ?? settings.defaultSummary ?? DEFAULT_SUMMARY;
    if ((summary || '').trim()) blocks.push({ t: 'summary', label: 'סיכום מקצועי', text: summary });
  } else if (report.type === 'custom') {
    blocks.push({ t: 'h', num: '1', text: 'נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    for (const sec of d.sections) blocks.push(...sectionBlocks(sec, photos, used, { blankLines: false }));
    if ((d.summary || '').trim()) blocks.push({ t: 'text', label: d.summaryLabel || 'סיכום והערות', value: d.summary });
  } else {
    blocks.push({ t: 'h', num: '1', text: 'נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    const res = finalRisk(d);
    if (d.showMatrix !== false) blocks.push({ t: 'matrix', sev: d.severity, lik: d.likelihood, result: res });
    else if (res) blocks.push({ t: 'text', label: 'דירוג הסיכון', value: `${LEVEL_INFO[res.level].label}${res.score && !res.manual ? ` (ציון ${res.score})` : ''}` });
    blocks.push({ t: 'text', label: 'פירוט הסיכון הבלתי קביל שנמצא', value: d.riskText });
    const pics = photosFor(photos, used, (ref) => ref === 'risk');
    if (pics.length) blocks.push({ t: 'photos', inline: true, label: 'תמונות הסיכון', items: pics });
    blocks.push({ t: 'text', label: 'המענה הנדרש למימוש', value: d.requiredResponse });
    blocks.push({ t: 'text', label: 'פעולות מתקנות מיידיות שבוצעו', value: d.correctiveActions });
    blocks.push({ t: 'text', label: 'ממצאים/ליקויים נוספים לדיווח', value: d.otherFindings });
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
