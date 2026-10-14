// בונה "מודל מסמך" אחד מהדוח. ממנו מיוצרים גם התצוגה/PDF (render-html) וגם קובץ ה-Word (export-docx),
// כך ששני הפורמטים תמיד זהים בתוכן ובמבנה.
import {
  REGULATION, ROLES, REPORT_TYPES, VISIT_REASONS, PRESTART_DOCS, PRESTART_CHECKS,
  DECLARATION, DEFAULT_SUMMARY, riskLevel,
} from './templates.js';

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

function contactLine(c) {
  if (!c) return '';
  return typeof c === 'string' ? c : c.name || '';
}

function compileNotes(rows, freeText) {
  const lines = rows
    .filter((r) => r.status === 'bad' && (r.note || '').trim())
    .map((r) => `• ${r.label}: ${r.note.trim()}`);
  if ((freeText || '').trim()) lines.push(freeText.trim());
  return lines.join('\n');
}

export function buildModel(report, site, settings) {
  const T = REPORT_TYPES[report.type];
  const s = site || {};
  const d = report.data;
  const inspector = report.inspector || settings.inspector || {};
  const blocks = [];

  blocks.push({
    t: 'meta',
    date: formatDate(report.reportDate),
    number: report.number || '',
    to: T.recipients.map((r) => ROLES[r]),
  });
  blocks.push({ t: 'title', text: T.title, site: s.name || 'שם אתר' });
  blocks.push({ t: 'note', text: `בהתאם לדרישות סעיף ${T.clause} ל${REGULATION}` });
  blocks.push({ t: 'note', text: T.distribution });

  const general = [
    ['שם האתר', s.name],
    ['מען/מיקום האתר', s.address],
    ['מזמין העבודה', contactLine(s.client)],
    ['מבצע הבניה', contactLine(s.contractor)],
    ['מנהל אתר', contactLine(s.siteManager)],
    ['מנהל עבודה', contactLine(s.workManager)],
    ['תאריך הביקור', formatDate(report.visitDate)],
  ];

  if (report.type === 'visit') {
    blocks.push({ t: 'h', num: '1', text: '(א) נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });

    blocks.push({ t: 'h', num: '', text: '(ב) שלב טרום תחילת עבודה:' });
    blocks.push({ t: 'sub', text: 'מסמכים חובה:' });
    blocks.push({
      t: 'checklist',
      items: PRESTART_DOCS.map((i) => ({ label: i.label, level: i.level || 0, checked: !!d.prestartDocs[i.id] })),
    });
    blocks.push({ t: 'sub', text: 'בדיקות הבקר: בקרה, ביקורת, התרעה' });
    blocks.push({
      t: 'checklist',
      items: PRESTART_CHECKS.map((i) => ({ label: i.label, level: 0, checked: !!d.prestartChecks[i.id] })),
    });

    blocks.push({ t: 'h', num: '2', text: 'הגדרת הביקור', ref: "[בהתאם לדרישות סעיף 2א'(ב)(1) לתקנה]" });
    blocks.push({ t: 'sub', text: 'סיבת הביקור:' });
    blocks.push({
      t: 'checklist',
      items: VISIT_REASONS.map((r) => ({ label: r.label, level: 0, checked: d.reasons.includes(r.id) })),
    });

    blocks.push({
      t: 'h', num: '3',
      text: 'בדיקה ואישור לקיום כלל המענים לסיכונים באתר כמפורטים בתוכנית הבטיחות בהתאמה לשלב הבניה',
      ref: "[בהתאם לדרישות סעיף 2א'(ב)(2) לתקנה]",
    });
    const risks = d.risks.filter((r) => !r.other || r.label.trim() || r.status);
    blocks.push({ t: 'tri', head: 'הנושא', rows: risks.map((r) => ({ label: r.other ? `אחר: ${r.label}` : r.label, status: r.status })) });
    blocks.push({ t: 'text', label: 'פירוט הליקויים או מענים שאינם מיושמים', value: compileNotes(risks, d.risksText) });

    blocks.push({
      t: 'h', num: '4',
      text: 'אספקת ציוד מיגון אישי - יש לוודא התאמה ותקינות הציוד לסוג העבודה המבוצעת',
      ref: "[בהתאם לדרישות סעיף 2א'(ב)(2) לתקנה]",
    });
    blocks.push({ t: 'tri', head: 'הפריט', rows: d.ppe });
    blocks.push({ t: 'text', label: 'פירוט הליקויים', value: compileNotes(d.ppe, d.ppeText) });

    blocks.push({
      t: 'h', num: '5', text: 'קיומן של הדרכות בטיחות באתר',
      ref: '[בהתאם לתקנות ארגון הפיקוח על העבודה (מסירת מידע והדרכת עובדים) 1999]',
    });
    blocks.push({ t: 'tri', head: 'הפריט', rows: d.training });
    blocks.push({ t: 'text', label: 'פירוט הליקויים ואיזה הדרכות חסרות?', value: compileNotes(d.training, d.trainingText) });

    blocks.push({ t: 'declaration', text: DECLARATION });
    const summary = d.summary ?? settings.defaultSummary ?? DEFAULT_SUMMARY;
    if ((summary || '').trim()) blocks.push({ t: 'summary', label: 'סיכום מקצועי', text: summary });
  } else {
    blocks.push({ t: 'h', num: '1', text: 'נתונים כללי:' });
    blocks.push({ t: 'fields', rows: general });
    const r = riskLevel(d.severity, d.likelihood);
    blocks.push({ t: 'matrix', sev: d.severity, lik: d.likelihood, result: r });
    blocks.push({ t: 'text', label: 'פירוט הסיכון הבלתי קביל שנמצא', value: d.riskText });
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

  const photos = report.photos || [];
  if (photos.length) {
    blocks.push({ t: 'photos', label: 'נספח:', sub: 'תמונות, טפסים, תסקירים וכיוצ"ב לתיעוד', items: photos });
  }

  return {
    blocks,
    header: { company: settings.company?.name || '', logo: settings.company?.logo || '' },
    filename: `${T.name} - ${s.name || 'אתר'} - ${formatDate(report.visitDate || report.reportDate).replaceAll('/', '.')}`,
  };
}
