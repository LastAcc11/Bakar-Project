// הגדרות הטפסים — הטקסטים לקוחים מהטפסים המקוריים של בקר הבטיחות.
// כל שינוי בנוסח הדוח נעשה כאן בלבד, וזורם אוטומטית לטופס, לתצוגה, ל-PDF ול-Word.

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

export const PRESTART_DOCS = [
  { id: 'ssp', label: 'תוכנית בטיחות מאושרת (Site Safety Plan)' },
  { id: 'clientApproval', label: 'אישור המזמין בכתב לתוכנית' },
  { id: 'budget', label: 'הקצאת משאבים לבטיחות בחוזה' },
  { id: 'appointments', label: 'מינוי רשמי של:' },
  { id: 'apController', label: 'בקר בטיחות', level: 1 },
  { id: 'apWorkManager', label: 'מנהל עבודה', level: 1 },
  { id: 'apSafetyOfficer', label: 'ממונה בטיחות (אם נדרש לפי היקף עובדים)', level: 1 },
  { id: 'apSiteManager', label: 'מנהל אתר (מעל 15000 מ"ר)', level: 1 },
  { id: 'siteBook', label: 'פנקס כללי אתר' },
  { id: 'sitePlan', label: 'תוכנית ארגון אתר (כולל תנועות, הפרדות, אזורי סיכון)' },
];

export const PRESTART_CHECKS = [
  { id: 'specific', label: 'האם התוכנית מותאמת ספציפית לפרויקט (לא גנרית)' },
  { id: 'contractMatch', label: 'האם קיימת התאמה בין חוזה ↔ תוכנית בטיחות' },
  { id: 'uniqueRisks', label: "האם הוגדרו סיכונים ייחודיים (גובה, עגורנים, חפירות וכו')" },
];

export const RISK_TOPICS = [
  'ארגון אתר', 'חפירות', 'כלונסאות', 'ביסוס', 'שלד', 'גמרים', 'פיתוח חיצוני', 'חשמל',
  'כלי צמ"ה', 'פיגומים באתר', 'עגורנים ומכונות הרמה', 'טפסות', 'מיגון מכונות וכלי עבודה',
];

export const PPE_ITEMS = [
  'כובע מגן', 'נעלי בטיחות S3', 'וסט זוהר', 'משקפי מגן', 'הגנת שמיעה', 'כפפות עבודה', 'רתמה לעבודה בגובה',
];

export const TRAINING_ITEMS = ['תמצית בכתב לעובד חדש', 'מסירת מידע בעמדת העבודה', 'הדרכה תקופתית'];

export const STATUS = {
  ok: { label: 'תקין', icon: '✓' },
  bad: { label: 'לא תקין', icon: '✗' },
  na: { label: 'לא רלוונטי', icon: '—' },
};

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
};

export function emptyTri(labels) {
  return labels.map((label) => ({ label, status: '', note: '' }));
}

export function newReportData(type) {
  if (type === 'visit') {
    return {
      prestartDocs: {},
      prestartChecks: {},
      reasons: [],
      risks: [...emptyTri(RISK_TOPICS), { label: '', status: '', note: '', other: true }, { label: '', status: '', note: '', other: true }],
      risksText: '',
      ppe: emptyTri(PPE_ITEMS),
      ppeText: '',
      training: emptyTri(TRAINING_ITEMS),
      trainingText: '',
      summary: null, // null = לקחת מברירת המחדל בהגדרות
    };
  }
  return {
    severity: 0,
    likelihood: 0,
    riskText: '',
    requiredResponse: '',
    correctiveActions: '',
    otherFindings: '',
  };
}
