// הגדרות הטפסים — הטקסטים לקוחים מהטפסים המקוריים של בקר הבטיחות.
// הנוסח הקבוע של הדוחות נמצא כאן. רשימות הבדיקה ניתנות לעריכה גם מהממשק (בדוח עצמו ובהגדרות).

export const REGULATION = 'תקנות הבטיחות (עבודות בניה ובניה הנדסית) תשמ"ח-1988';

export const SIGNER_TITLES = [
  'מהנדס אזרחי',
  'הנדסאי אזרחי',
  'ממונה בטיחות בעל השתלמות ענפית בניה',
];

export const ROLES = {
  client: 'מזמין העבודה',
  contractor: 'מבצע הבניה',
  siteManager: 'מנהל אתר',
  workManager: 'מנהל עבודה',
};

// שלבי ביקורת חובה + ביקור רבעוני
export const VISIT_REASONS = [
  { id: 'excavation', label: 'שלב החפירות', short: 'חפירות' },
  { id: 'foundation', label: 'שלב הביסוס', short: 'ביסוס' },
  { id: 'skeleton', label: 'שלב השלד', short: 'שלד' },
  { id: 'finishing', label: 'שלב הגמרים', short: 'גמר' },
  { id: 'quarterly', label: 'ביקור רבעוני (תלת-חודשי)', short: 'רבעוני' },
];
export const MANDATORY_STAGES = ['excavation', 'foundation', 'skeleton', 'finishing'];
export const MAX_DAYS_BETWEEN_VISITS = 90;

// ---- רשימות הבדיקה ----
// כל רשימה היא "סעיף" עם שורות. מוסכמה לטקסט של שורה (גם בתבניות שהמשתמש עורך בהגדרות):
//   שורה שמתחילה ב "-"  → תת-פריט (מוזח)
//   שורה שמסתיימת ב ":" → כותרת קבוצה (בלי סימון)
export const STATUS_LABELS = { ok: 'תקין', bad: 'לא תקין', na: 'לא רלוונטי' };
export const STATUS_ICONS = { ok: '✓', bad: '✗', na: '—' };
export const STATUS = Object.fromEntries(Object.entries(STATUS_LABELS).map(([k, label]) => [k, { label, icon: STATUS_ICONS[k] }]));

export const VISIT_SECTION_DEFS = [
  {
    key: 'docs', step: 'prestart', group: '(ב) שלב טרום תחילת עבודה:',
    title: 'מסמכים חובה', head: 'המסמך', labels: { ok: 'יש', bad: 'אין', na: 'לא רלוונטי' },
    textLabel: 'הערות לגבי המסמכים',
    items: [
      'תוכנית בטיחות מאושרת (Site Safety Plan)',
      'אישור המזמין בכתב לתוכנית',
      'הקצאת משאבים לבטיחות בחוזה',
      'מינוי רשמי של:',
      '-בקר בטיחות',
      '-מנהל עבודה',
      '-ממונה בטיחות (אם נדרש לפי היקף עובדים)',
      '-מנהל אתר (מעל 15000 מ"ר)',
      'פנקס כללי אתר',
      'תוכנית ארגון אתר (כולל תנועות, הפרדות, אזורי סיכון)',
    ],
  },
  {
    key: 'checks', step: 'prestart',
    title: 'בדיקות הבקר: בקרה, ביקורת, התרעה', head: 'הבדיקה', labels: { ok: 'כן', bad: 'לא', na: 'לא רלוונטי' },
    textLabel: 'הערות לבדיקות הבקר',
    items: [
      'האם התוכנית מותאמת ספציפית לפרויקט (לא גנרית)',
      'האם קיימת התאמה בין חוזה ↔ תוכנית בטיחות',
      "האם הוגדרו סיכונים ייחודיים (גובה, עגורנים, חפירות וכו')",
    ],
  },
  {
    key: 'risks', step: 'risks', num: '3',
    title: 'בדיקה ואישור לקיום כלל המענים לסיכונים באתר כמפורטים בתוכנית הבטיחות בהתאמה לשלב הבניה',
    ref: "[בהתאם לדרישות סעיף 2א'(ב)(2) לתקנה]", head: 'הנושא', labels: STATUS_LABELS,
    textLabel: 'פירוט הליקויים או מענים שאינם מיושמים',
    items: ['ארגון אתר', 'חפירות', 'כלונסאות', 'ביסוס', 'שלד', 'גמרים', 'פיתוח חיצוני', 'חשמל',
      'כלי צמ"ה', 'פיגומים באתר', 'עגורנים ומכונות הרמה', 'טפסות', 'מיגון מכונות וכלי עבודה'],
  },
  {
    key: 'ppe', step: 'ppe', num: '4',
    title: 'אספקת ציוד מיגון אישי - יש לוודא התאמה ותקינות הציוד לסוג העבודה המבוצעת',
    ref: "[בהתאם לדרישות סעיף 2א'(ב)(2) לתקנה]", head: 'הפריט', labels: STATUS_LABELS,
    textLabel: 'פירוט הליקויים',
    items: ['כובע מגן', 'נעלי בטיחות S3', 'וסט זוהר', 'משקפי מגן', 'הגנת שמיעה', 'כפפות עבודה', 'רתמה לעבודה בגובה'],
  },
  {
    key: 'training', step: 'training', num: '5',
    title: 'קיומן של הדרכות בטיחות באתר',
    ref: '[בהתאם לתקנות ארגון הפיקוח על העבודה (מסירת מידע והדרכת עובדים) 1999]', head: 'הפריט', labels: STATUS_LABELS,
    textLabel: 'פירוט הליקויים ואיזה הדרכות חסרות?',
    items: ['תמצית בכתב לעובד חדש', 'מסירת מידע בעמדת העבודה', 'הדרכה תקופתית'],
  },
];

export const rid = () => Math.random().toString(36).slice(2, 9);

// טקסט שורה ("-פריט" / "כותרת:") → אובייקט שורה
export function parseItem(line) {
  const t = String(line).trim();
  if (!t) return null;
  const level = t.startsWith('-') ? 1 : 0;
  const label = level ? t.slice(1).trim() : t;
  return { id: rid(), label, status: '', note: '', level, header: !level && label.endsWith(':') };
}
export const itemsToText = (rows) => rows.filter((r) => !r.hidden).map((r) => (r.level ? `-${r.label}` : r.label)).join('\n');
export const textToItems = (text) => String(text || '').split('\n').map(parseItem).filter(Boolean);
export const defaultItemsText = (key) => VISIT_SECTION_DEFS.find((d) => d.key === key)?.items.join('\n') || '';

// בונה סעיף לדוח מהגדרה. overrideItems = רשימה שהמשתמש קבע בהגדרות (אם יש)
export function buildSection(def, overrideItems) {
  const { items, ...meta } = def;
  const rows = overrideItems ? textToItems(overrideItems) : items.map(parseItem).filter(Boolean);
  return { ...meta, labels: { ...STATUS_LABELS, ...def.labels }, rows, text: '' };
}

export const DECLARATION =
  'הריני מצהיר כי בדקתי בשטח האתר אספקת הציוד מיגון אישי, ההדרכות הנדרשות לעובדים ואת יישומם של כלל המענים לכלל הסיכונים המפורטים בתוכנית הבטיחות בהתאם לשלב הבניה הנוכחי וכל התוצאות תואמות את יום תאריך בדיקת הדוח.';

export const DEFAULT_SUMMARY = `התיקון 2025–2026 יוצר מודל חדש:
לא עוד "אדם אחד אחראי" אלא מערכת מבוקרת + מתועדת + רב־שכבתית.
הבקר הוא:
• שומר הסף של המזמין
• כלי מניעת אחריות פלילית
• גורם קריטי ל־compliance אמיתי`;

// ---- מטריצת הסיכונים ("לוח החלטה") ----
export const SEVERITY = [
  { v: 4, name: 'חמורה', desc: 'מוות או נכות תמידית' },
  { v: 3, name: 'בינונית', desc: 'פגיעה רצינית או מחלה של יותר מ-30 יום' },
  { v: 2, name: 'קלה', desc: 'טיפול רפואי וימי אי כושר' },
  { v: 1, name: 'שולית', desc: 'נחוצה רק עזרה ראשונה' },
];
export const LIKELIHOOD = [
  { v: 4, name: 'גבוהה', desc: 'עלול לקרות בכל יום' },
  { v: 3, name: 'בינונית', desc: 'עלול לקרות מדי פעם' },
  { v: 2, name: 'נמוכה', desc: 'עלול לקרות, אך רק לעתים רחוקות' },
  { v: 1, name: 'נמוכה מאד', desc: 'עלול לקרות, אך כנראה לא יקרה אף פעם' },
];
// צבעי התאים כפי שמופיעים בלוח המקורי (לא נגזרים רק מהציון)
const LEVELS = {
  4: { 4: 'red', 3: 'red', 2: 'yellow', 1: 'yellow' },
  3: { 4: 'red', 3: 'yellow', 2: 'yellow', 1: 'green' },
  2: { 4: 'yellow', 3: 'yellow', 2: 'green', 1: 'green' },
  1: { 4: 'yellow', 3: 'green', 2: 'green', 1: 'green' },
};
export const LEVEL_INFO = {
  red: { label: 'סיכון בלתי קביל', color: '#FF0000' },
  yellow: { label: 'סיכון בינוני — נדרש טיפול', color: '#FFFF00' },
  green: { label: 'סיכון קביל', color: '#00FF00' },
};
export function riskLevel(sev, lik) {
  if (!sev || !lik) return null;
  return { score: sev * lik, level: LEVELS[sev][lik] };
}
// הדירוג הסופי: לפי הלוח, או דירוג ידני שהבקר בחר (סעיף 13)
export function finalRisk(d) {
  const auto = riskLevel(d.severity, d.likelihood);
  if (!d.levelOverride) return auto && { ...auto, manual: false };
  return { score: auto?.score ?? null, level: d.levelOverride, manual: true };
}

export const REPORT_TYPES = {
  visit: {
    name: 'דו"ח ממצאי ביקור',
    title: 'דו"ח ממצאי ביקור בקר בטיחות',
    clause: "2א'(ב)",
    distribution: 'הדו"ח יופץ למזמין העבודה ומבצע הבניה בתוך 48 שעות ממועד הביקור',
    recipients: ['client', 'contractor'],
    deadlineHours: 48,
  },
  risk: {
    name: 'הודעת סיכון בלתי קביל',
    title: 'טופס הודעה של בקר הבטיחות על סיכון בלתי קביל/ממצא אחר',
    clause: "2א'(ג)",
    distribution: 'הדו"ח יופץ מיידית למכותבים לפעולה',
    recipients: ['client', 'contractor', 'siteManager', 'workManager'],
    deadlineHours: 0,
  },
  custom: {
    name: 'טופס מותאם',
    title: '',
    clause: '',
    distribution: '',
    recipients: ['client', 'contractor'],
    deadlineHours: null,
  },
};

// תבנית ריקה לטופס מותאם (סעיף 20) — המשתמש קובע כותרות ופריטים
export function newCustomForm() {
  return {
    id: rid(),
    name: 'טופס חדש',
    title: 'דו"ח ביקורת',
    subtitle: '',
    summaryLabel: 'סיכום והערות',
    sections: [{ id: rid(), title: 'סעיף 1', head: 'הפריט', labels: { ...STATUS_LABELS }, textLabel: 'פירוט והערות', items: '' }],
  };
}

export function newReportData(type, { templates = {}, form } = {}) {
  if (type === 'visit') {
    return {
      sections: VISIT_SECTION_DEFS.map((def) => buildSection(def, templates[def.key])),
      reasons: [],
      summary: null, // null = לקחת מברירת המחדל בהגדרות
      distMethod: 'וואטסאפ / דוא"ל',
    };
  }
  if (type === 'custom') {
    const f = form || newCustomForm();
    return {
      formId: f.id,
      formTitle: f.title,
      formSubtitle: f.subtitle || '',
      summaryLabel: f.summaryLabel || 'סיכום והערות',
      summary: '',
      distMethod: 'וואטסאפ / דוא"ל',
      sections: (f.sections || []).map((sec, i) => ({
        key: sec.id || `s${i}`, step: `s${i}`, num: String(i + 2), title: sec.title, head: sec.head || 'הפריט',
        labels: { ...STATUS_LABELS, ...sec.labels }, textLabel: sec.textLabel || 'פירוט והערות',
        rows: textToItems(sec.items), text: '',
      })),
    };
  }
  return {
    severity: 0,
    likelihood: 0,
    showMatrix: true,
    levelOverride: '',
    riskText: '',
    requiredResponse: '',
    correctiveActions: '',
    otherFindings: '',
    distMethod: 'וואטסאפ / דוא"ל',
  };
}

// המרה מהמבנה הישן של דוח ביקור (prestartDocs / risks / ppe / training) למבנה הסעיפים
const OLD_DOC_IDS = ['ssp', 'clientApproval', 'budget', 'appointments', 'apController', 'apWorkManager', 'apSafetyOfficer', 'apSiteManager', 'siteBook', 'sitePlan'];
const OLD_CHECK_IDS = ['specific', 'contractMatch', 'uniqueRisks'];
export function migrateVisitData(d) {
  if (d.sections) return d;
  const fresh = newReportData('visit');
  const [docs, checks, risks, ppe, training] = fresh.sections;
  docs.rows.forEach((r, i) => { if (d.prestartDocs?.[OLD_DOC_IDS[i]] && !r.header) r.status = 'ok'; });
  checks.rows.forEach((r, i) => { if (d.prestartChecks?.[OLD_CHECK_IDS[i]]) r.status = 'ok'; });
  const copy = (sec, oldRows, text) => {
    const list = Array.isArray(oldRows) ? oldRows : Object.values(oldRows || {});
    sec.rows = list
      .filter((o) => !o.other || (o.label || '').trim())
      .map((o) => ({ id: rid(), label: o.label, status: o.status || '', note: o.note || '', level: 0, header: false }));
    sec.text = text || '';
  };
  copy(risks, d.risks, d.risksText);
  copy(ppe, d.ppe, d.ppeText);
  copy(training, d.training, d.trainingText);
  return { ...fresh, reasons: d.reasons || [], summary: d.summary ?? null };
}
