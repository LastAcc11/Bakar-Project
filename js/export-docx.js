// מייצא את מודל המסמך לקובץ Word (‎.docx) מימין לשמאל, באמצעות ספריית docx (vendor/docx.min.js).
import { SEVERITY, LIKELIHOOD, riskLevel, LEVEL_INFO, STATUS } from './templates.js';

const FONT = 'Arial';
const SIZE = 22; // חצאי נקודה => 11pt

function dataUrlToBytes(url) {
  const bin = atob(url.split(',')[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1, h: 1 });
    img.src = url;
  });
}

function fit(size, maxW, maxH) {
  const k = Math.min(maxW / size.w, maxH / size.h, 1);
  return { width: Math.round(size.w * k), height: Math.round(size.h * k) };
}

export async function exportDocx(model) {
  const D = window.docx;
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType,
    BorderStyle, ShadingType, ImageRun, Header, VerticalAlign, TableLayoutType,
  } = D;

  const run = (text, o = {}) =>
    new TextRun({
      text,
      rightToLeft: true,
      font: { ascii: FONT, hAnsi: FONT, cs: FONT, eastAsia: FONT },
      size: o.size || SIZE,
      sizeComplexScript: o.size || SIZE,
      bold: o.bold,
      boldComplexScript: o.bold,
      italics: o.italics,
      italicsComplexScript: o.italics,
      underline: o.underline ? {} : undefined,
      color: o.color,
      break: o.break,
    });

  const para = (children, o = {}) =>
    new Paragraph({
      bidirectional: true,
      alignment: o.align || AlignmentType.START,
      spacing: { before: o.before ?? 0, after: o.after ?? 80, line: 300 },
      indent: o.indent ? { start: o.indent } : undefined,
      keepNext: o.keepNext,
      children: Array.isArray(children) ? children : [children],
    });

  // טקסט מרובה שורות -> פסקה עם שבירות שורה
  const lines = (text, o = {}) =>
    String(text)
      .split('\n')
      .map((line, i) => run(line, { ...o, break: i ? 1 : undefined }));

  const border = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const borders = { top: border, bottom: border, left: border, right: border };

  const cell = (children, o = {}) =>
    new TableCell({
      children: Array.isArray(children) ? children : [children],
      width: o.width ? { size: o.width, type: WidthType.DXA } : undefined,
      shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
      verticalAlign: VerticalAlign.CENTER,
      borders: o.borders || borders,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    });

  const table = (rows, widths, o = {}) =>
    new Table({
      rows,
      visuallyRightToLeft: true,
      layout: TableLayoutType.FIXED,
      columnWidths: widths,
      width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
      alignment: o.align || AlignmentType.CENTER,
    });

  const box = (on) => (on ? '☒' : '☐');
  const out = [];

  for (const b of model.blocks) {
    switch (b.t) {
      case 'meta':
        out.push(para([run('תאריך הדו"ח: '), run(b.date || '__________', { bold: true }),
          ...(b.number ? [run(`   |   מס' דו"ח: `), run(b.number, { bold: true })] : [])], { after: 200 }));
        b.to.forEach((r, i) => out.push(para(i === 0 ? [run('אל', { underline: true }), run(`: ${r}`)] : [run(r)], { indent: i ? 300 : 0, after: 40 })));
        break;
      case 'title':
        out.push(para([run(`${b.text} - `, { bold: true, underline: true, size: 32 }), run(`"${b.site}"`, { bold: true, italics: true, underline: true, size: 32 })],
          { align: AlignmentType.CENTER, before: 300, after: 200 }));
        break;
      case 'note':
        out.push(para(run(b.text, { size: 20 }), { align: AlignmentType.CENTER, after: 40 }));
        break;
      case 'h':
        out.push(para([
          ...(b.num ? [run(`${b.num}. `, { bold: true })] : []),
          run(b.text, { bold: true, underline: true }),
          ...(b.ref ? [run(` ${b.ref}`, { size: 18, underline: true })] : []),
        ], { before: 300, after: 120, keepNext: true }));
        break;
      case 'sub':
        out.push(para(run(b.text, { bold: true }), { before: 120, keepNext: true }));
        break;
      case 'fields':
        out.push(table(b.rows.map(([k, v]) => new TableRow({
          children: [
            cell(para(run(`${k}:`, { bold: true }), { after: 0 }), { width: 2600, fill: 'F2F2F2' }),
            cell(para(run(v || ''), { after: 0 }), { width: 6400 }),
          ],
        })), [2600, 6400]));
        break;
      case 'checklist':
        b.items.forEach((i) => out.push(para([run(`${box(i.checked)}  `), run(i.label)], { indent: 360 + i.level * 500, after: 40 })));
        break;
      case 'tri': {
        const w = [4800, 1400, 1400, 1400];
        const head = new TableRow({
          tableHeader: true,
          children: [b.head, ...['ok', 'bad', 'na'].map((k) => STATUS[k].label)].map((t, i) =>
            cell(para(run(t, { bold: true }), { align: i ? AlignmentType.CENTER : AlignmentType.START, after: 0 }), { width: w[i], fill: 'D9D9D9' })),
        });
        const rows = b.rows.map((r) => new TableRow({
          children: [
            cell(para(run(r.label), { after: 0 }), { width: w[0] }),
            ...['ok', 'bad', 'na'].map((k, i) => cell(para(run(box(r.status === k), { size: 26 }), { align: AlignmentType.CENTER, after: 0 }),
              { width: w[i + 1], fill: r.status === 'bad' && k === 'bad' ? 'FDE2E1' : undefined })),
          ],
        }));
        out.push(table([head, ...rows], w));
        break;
      }
      case 'text':
        out.push(para(run(b.label, { bold: true, underline: true }), { before: 200, keepNext: true }));
        if ((b.value || '').trim()) out.push(para(lines(b.value)));
        else for (let i = 0; i < 3; i++) out.push(para(run('_'.repeat(70))));
        break;
      case 'matrix': {
        out.push(para(run('לוח - "לוח החלטה"', { bold: true, size: 26 }), { align: AlignmentType.CENTER, before: 200, keepNext: true }));
        const w = [2200, 1700, 1700, 1700, 1700];
        const fills = { red: 'FF0000', yellow: 'FFFF00', green: '00FF00' };
        const desc = (x) => [para(run(`(${x.name} - ${x.v})`, { bold: true, size: 18 }), { after: 0 }), para(run(x.desc, { size: 18 }), { after: 0 })];
        const head = new TableRow({
          children: [
            cell([para(run('הסתברות ←', { bold: true, size: 18 }), { after: 0 }), para(run('חומרת פגיעה ↓', { bold: true, size: 18 }), { after: 0 })], { width: w[0], fill: 'D9D9D9' }),
            ...LIKELIHOOD.map((l, i) => cell(desc(l), { width: w[i + 1], fill: 'D9D9D9' })),
          ],
        });
        const thick = { style: BorderStyle.SINGLE, size: 36, color: '000000' };
        const rows = SEVERITY.map((s) => new TableRow({
          children: [
            cell(desc(s), { width: w[0] }),
            ...LIKELIHOOD.map((l, i) => {
              const r = riskLevel(s.v, l.v);
              const on = b.sev === s.v && b.lik === l.v;
              return cell(para(run(on ? `◉ ${r.score}` : String(r.score), { bold: true, size: on ? 32 : 28 }), { align: AlignmentType.CENTER, after: 0 }),
                { width: w[i + 1], fill: fills[r.level], borders: on ? { top: thick, bottom: thick, left: thick, right: thick } : borders });
            }),
          ],
        }));
        out.push(table([head, ...rows], w));
        if (b.result) {
          out.push(para([run(`הערכת הסיכון: חומרה ${b.sev} × הסתברות ${b.lik} = `), run(String(b.result.score), { bold: true }),
            run(` — ${LEVEL_INFO[b.result.level].label}`, { bold: true })], { before: 120 }));
        }
        break;
      }
      case 'declaration':
        out.push(para(run(b.text, { bold: true, italics: true }), { before: 300 }));
        break;
      case 'summary':
        out.push(para(run(b.label, { bold: true, italics: true }), { before: 200, keepNext: true }));
        out.push(para(lines(b.text, { italics: true })));
        break;
      case 'signature': {
        out.push(para(run(b.intro, { italics: true }), { before: 400, keepNext: true }));
        const children = [run('שם מלא: ', { italics: true }), run(b.name || '__________________', { bold: true }), run('     חתימה: ', { italics: true })];
        if (b.signature) {
          const sz = fit(await imageSize(b.signature), 160, 60);
          children.push(new ImageRun({ data: dataUrlToBytes(b.signature), transformation: sz }));
        } else children.push(run('______________________'));
        out.push(para(children, { keepNext: true }));
        out.push(para(run(b.title || 'מהנדס אזרחי/הנדסאי אזרחי/ממונה בטיחות בעל השתלמות ענפית בניה', { italics: true })));
        break;
      }
      case 'photos':
        out.push(para(run(b.label, { bold: true, underline: true }), { before: 300 }));
        out.push(para(run(b.sub, { italics: true })));
        for (const [i, p] of b.items.entries()) {
          const sz = fit({ w: p.w || 800, h: p.h || 600 }, 560, 420);
          out.push(para(new ImageRun({ data: dataUrlToBytes(p.src), transformation: sz }), { align: AlignmentType.CENTER, before: 200, after: 40, keepNext: true }));
          out.push(para(run(`תמונה ${i + 1}${p.caption ? ` — ${p.caption}` : ''}`, { size: 18, italics: true }), { align: AlignmentType.CENTER }));
        }
        break;
    }
  }

  // כותרת עליונה: לוגו/שם חברה
  const headerChildren = [];
  if (model.header.logo) {
    const sz = fit(await imageSize(model.header.logo), 180, 60);
    headerChildren.push(new ImageRun({ data: dataUrlToBytes(model.header.logo), transformation: sz }));
  }
  if (model.header.company) headerChildren.push(run(`  ${model.header.company}`, { bold: true, color: '555555' }));

  const doc = new Document({
    creator: 'בקר — מערכת דוחות בקר בטיחות',
    title: model.filename,
    styles: { default: { document: { run: { font: FONT, size: SIZE, rightToLeft: true } } } },
    sections: [{
      properties: { page: { margin: { top: 1100, bottom: 1000, left: 1100, right: 1100 } } },
      headers: headerChildren.length ? { default: new Header({ children: [para(headerChildren, { align: AlignmentType.CENTER })] }) } : undefined,
      children: out,
    }],
  });
  return Packer.toBlob(doc);
}
