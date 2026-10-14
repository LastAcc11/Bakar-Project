// מפיק PDF וקטורי (טקסט חד וניתן לחיפוש) ישירות ממודל המסמך, בעזרת jsPDF.
// עברית: גופן Liberation Sans מוטמע + אלגוריתם ה-bidi של Unicode (bidi-js) לסידור מימין לשמאל,
// כך שמספרים, אנגלית וסוגריים בתוך טקסט עברי מוצגים נכון — בכל דפדפן, כולל אייפון.
import bidiFactory from '../vendor/bidi.min.mjs';
import { SEVERITY, LIKELIHOOD, riskLevel, LEVEL_INFO, STATUS } from './templates.js';

const bidi = bidiFactory();
const FONT = 'Liberation';
const FONT_FILES = {
  normal: 'LiberationSans-Regular.ttf',
  bold: 'LiberationSans-Bold.ttf',
  italic: 'LiberationSans-Italic.ttf',
  bolditalic: 'LiberationSans-BoldItalic.ttf',
};
let fontCache;

async function loadFonts() {
  if (!fontCache) {
    fontCache = Promise.all(
      Object.entries(FONT_FILES).map(async ([style, file]) => {
        const buf = await (await fetch(new URL(`../vendor/fonts/${file}`, import.meta.url))).arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return [style, file, btoa(bin)];
      }),
    );
  }
  return fontCache;
}

function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
const fit = (s, maxW, maxH) => {
  const k = Math.min(maxW / s.w, maxH / s.h);
  return { w: s.w * k, h: s.h * k };
};
const imgFormat = (url) => (url.startsWith('data:image/png') ? 'PNG' : 'JPEG');

// ---------- page geometry (mm) ----------
const PAGE_W = 210;
const PAGE_H = 297;
const M_X = 18;
const TOP = 26;
const BOTTOM = PAGE_H - 18;
const RIGHT = PAGE_W - M_X;
const LEFT = M_X;
const WIDTH = RIGHT - LEFT;
const PT = 0.3528; // mm per point

class Writer {
  constructor(doc) {
    this.doc = doc;
    this.y = TOP;
    this.style = null;
  }

  // ---- styles & measuring ----
  use(st = {}) {
    const key = `${st.bold ? 'b' : ''}${st.italic ? 'i' : ''}${st.size || 11}`;
    if (key !== this.style) {
      const fs = st.bold && st.italic ? 'bolditalic' : st.bold ? 'bold' : st.italic ? 'italic' : 'normal';
      this.doc.setFont(FONT, fs);
      this.doc.setFontSize(st.size || 11);
      this.style = key;
    }
  }
  width(text, st) {
    this.use(st);
    return this.doc.getTextWidth(text);
  }
  static visual(text) {
    const levels = bidi.getEmbeddingLevels(text, 'rtl');
    return bidi.getReorderedString(text, levels);
  }

  // ---- rich text layout: runs = [{text, bold, italic, underline, size}] ----
  layout(runs, maxW) {
    const tokens = [];
    for (const r of runs) {
      String(r.text ?? '').split('\n').forEach((part, i) => {
        if (i) tokens.push({ br: true, st: r });
        for (const w of part.split(/(\s+)/)) if (w) tokens.push({ text: w, st: r, space: /^\s+$/.test(w) });
      });
    }
    const lines = [];
    let cur = [];
    let curW = 0;
    const push = () => {
      while (cur.length && cur[cur.length - 1].space) cur.pop();
      lines.push(cur);
      cur = [];
      curW = 0;
    };
    for (const t of tokens) {
      if (t.br) { push(); continue; }
      if (t.space && !cur.length) continue;
      const w = this.width(t.text, t.st);
      if (!t.space && cur.length && curW + w > maxW) push();
      cur.push({ ...t, w });
      curW += w;
    }
    if (cur.length || !lines.length) push();
    return lines.map((toks) => {
      const segs = [];
      for (const t of toks) {
        const last = segs[segs.length - 1];
        if (last && last.st === t.st) last.text += t.text;
        else segs.push({ text: t.text, st: t.st });
      }
      for (const s of segs) {
        s.visual = Writer.visual(s.text);
        s.w = this.width(s.visual, s.st);
      }
      const size = segs.length ? Math.max(...segs.map((s) => s.st.size || 11)) : 11;
      return { segs, w: segs.reduce((a, s) => a + s.w, 0), h: size * PT * 1.45, size };
    });
  }

  drawLine(line, top, { right = RIGHT, left = LEFT, align = 'right' } = {}) {
    const base = top + line.h * 0.74;
    let cursor = align === 'center' ? (left + right) / 2 + line.w / 2 : align === 'left' ? left + line.w : right;
    for (const s of line.segs) {
      const x = cursor - s.w;
      this.use(s.st);
      this.doc.setTextColor(s.st.color || '#000000');
      this.doc.text(s.visual, x, base);
      if (s.st.underline) {
        // רווחים בתחילת/סוף הקטע (לוגית) לא מקבלים קו תחתון
        const lead = this.width(s.text.match(/^\s*/)[0], s.st);
        const trail = this.width(s.text.match(/\s*$/)[0], s.st);
        this.doc.setLineWidth(0.25);
        this.doc.setDrawColor('#000000');
        this.doc.line(x + trail, base + 0.7, cursor - lead, base + 0.7);
      }
      cursor = x;
    }
  }

  // ---- flow ----
  newPage() {
    this.doc.addPage();
    this.y = TOP;
  }
  ensure(h) {
    if (this.y + h > BOTTOM) this.newPage();
  }
  space(h) {
    this.y += h;
  }
  para(runs, o = {}) {
    const right = (o.right ?? RIGHT) - (o.indent || 0);
    const left = o.left ?? LEFT;
    const lines = this.layout(runs, right - left);
    if (o.keepNext) this.ensure(lines[0].h + 14);
    for (const line of lines) {
      this.ensure(line.h);
      this.drawLine(line, this.y, { right, left, align: o.align });
      this.y += line.h;
    }
    this.y += o.after ?? 1.2;
  }

  checkbox(xRight, top, checked, size = 3.4) {
    const d = this.doc;
    const x = xRight - size;
    d.setLineWidth(0.3);
    d.setDrawColor('#000000');
    d.rect(x, top, size, size);
    if (checked) {
      d.setLineWidth(0.45);
      d.line(x + 0.6, top + 0.6, x + size - 0.6, top + size - 0.6);
      d.line(x + size - 0.6, top + 0.6, x + 0.6, top + size - 0.6);
    }
  }

  // ---- tables: cols = widths from right to left; cells = [{runs, align, fill, box, draw}] ----
  table(rows, cols, o = {}) {
    const d = this.doc;
    const pad = 1.6;
    const total = cols.reduce((a, b) => a + b, 0);
    const right = o.right ?? RIGHT - (WIDTH - total) / 2;
    const prepared = rows.map((cells) => {
      const laid = cells.map((c, i) => (c.runs ? this.layout(c.runs, cols[i] - pad * 2) : []));
      const contentH = Math.max(...laid.map((ls, i) => (cells[i].box ? 3.4 : ls.reduce((a, l) => a + l.h, 0))), cells.minH || 0);
      return { cells, laid, h: Math.max(contentH + pad * 2, o.minRowH || 0) };
    });
    const drawRow = (row) => {
      let x = right;
      row.cells.forEach((c, i) => {
        const w = cols[i];
        const cx = x - w;
        if (c.fill) {
          d.setFillColor(c.fill);
          d.rect(cx, this.y, w, row.h, 'F');
        }
        if (c.draw) c.draw(cx, this.y, w, row.h);
        else if (c.box !== undefined) this.checkbox(cx + w / 2 + 1.7, this.y + (row.h - 3.4) / 2, c.box);
        else {
          const textH = row.laid[i].reduce((a, l) => a + l.h, 0);
          let ty = this.y + (c.valign === 'top' ? pad : (row.h - textH) / 2);
          for (const line of row.laid[i]) {
            this.drawLine(line, ty, { right: x - pad, left: cx + pad, align: c.align || 'right' });
            ty += line.h;
          }
        }
        d.setLineWidth(c.border || o.border || 0.25);
        d.setDrawColor('#000000');
        d.rect(cx, this.y, w, row.h);
        x = cx;
      });
      this.y += row.h;
    };
    const [head, ...body] = prepared;
    const headIsHeader = o.header !== false;
    this.ensure(head.h + (body[0]?.h || 0));
    drawRow(head);
    for (const row of body) {
      if (this.y + row.h > BOTTOM) {
        this.newPage();
        if (headIsHeader) drawRow(head);
      }
      drawRow(row);
    }
    // thick borders drawn last so neighbours don't paint over them
    if (o.after) o.after();
    this.y += 2;
  }
}

export async function exportPdf(model) {
  const { jsPDF } = window.jspdf;
  // jsPDF מפעיל מנוע bidi משלו שהופך מחרוזות מעורבות (עברית+ספרות) — אנחנו כבר מסדרים בעצמנו, אז מנטרלים אותו
  jsPDF.API.events = jsPDF.API.events.filter((e) => !(e[0] === 'postProcessText' && String(e[1]).includes('doBidiReorder')));
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  for (const [style, file, b64] of await loadFonts()) {
    doc.addFileToVFS(file, b64);
    doc.addFont(file, FONT, style);
  }
  doc.setProperties({ title: model.filename, creator: 'בקר — מערכת דוחות בקר בטיחות' });
  const W = new Writer(doc);
  const B = { bold: true };

  for (const b of model.blocks) {
    switch (b.t) {
      case 'meta':
        W.para([{ text: 'תאריך הדו"ח: ' }, { text: b.date || '__________', ...B },
          ...(b.number ? [{ text: `   |   מס' דו"ח: ` }, { text: b.number, ...B }] : [])], { align: 'left', after: 4 });
        b.to.forEach((r, i) => W.para(i ? [{ text: r }] : [{ text: 'אל', underline: true }, { text: `: ${r}` }], { indent: i ? 7 : 0, after: 0.6 }));
        W.space(4);
        break;
      case 'title':
        W.space(3);
        W.para([{ text: `${b.text} - `, ...B, underline: true, size: 16 }, { text: `"${b.site}"`, ...B, italic: true, underline: true, size: 16 }], { align: 'center', after: 3 });
        break;
      case 'note':
        W.para([{ text: b.text, size: 10 }], { align: 'center', after: 0.6 });
        break;
      case 'h':
        W.space(5);
        W.para([...(b.num ? [{ text: `${b.num}. `, ...B }] : []), { text: b.text, ...B, underline: true }, ...(b.ref ? [{ text: ` ${b.ref}`, size: 9 }] : [])],
          { keepNext: true, after: 2 });
        break;
      case 'sub':
        W.space(1.5);
        W.para([{ text: b.text, ...B }], { keepNext: true, after: 1 });
        break;
      case 'fields':
        W.table(b.rows.map(([k, v]) => [{ runs: [{ text: `${k}:`, ...B }], fill: '#F2F2F2' }, { runs: [{ text: v || '' }] }]), [48, WIDTH - 48], { header: false });
        break;
      case 'checklist':
        for (const i of b.items) {
          const indent = 4 + i.level * 7;
          const lines = W.layout([{ text: i.label }], WIDTH - indent - 6);
          W.ensure(lines[0].h);
          W.checkbox(RIGHT - indent, W.y + (lines[0].h - 3.4) / 2, i.checked);
          W.para([{ text: i.label }], { indent: indent + 5.5, after: 0.4 });
        }
        break;
      case 'tri': {
        const c = 24;
        W.table([
          [{ runs: [{ text: b.head, ...B }], fill: '#D9D9D9' }, ...['ok', 'bad', 'na'].map((k) => ({ runs: [{ text: STATUS[k].label, ...B }], align: 'center', fill: '#D9D9D9' }))],
          ...b.rows.map((r) => [
            { runs: [{ text: r.label, bold: r.status === 'bad' }] },
            ...['ok', 'bad', 'na'].map((k) => ({ box: r.status === k, fill: r.status === 'bad' && k === 'bad' ? '#FDE2E1' : undefined })),
          ]),
        ], [WIDTH - c * 3, c, c, c]);
        break;
      }
      case 'text':
        W.space(2.5);
        W.para([{ text: b.label, ...B, underline: true }], { keepNext: true, after: 1 });
        if ((b.value || '').trim()) W.para([{ text: b.value }]);
        else for (let i = 0; i < 3; i++) {
          W.ensure(7);
          W.y += 6.5;
          doc.setLineWidth(0.25);
          doc.line(LEFT, W.y, RIGHT, W.y);
        }
        W.space(1);
        break;
      case 'matrix': {
        const first = 46;
        const cw = (WIDTH - first) / 4;
        const hdr = (x) => ({ runs: [{ text: `(${x.name} - ${x.v})\n`, ...B, size: 8.5 }, { text: x.desc, size: 8.5 }], align: 'center', valign: 'top' });
        const fills = { red: '#FF0000', yellow: '#FFFF00', green: '#00FF00' };
        let selRect = null;
        W.space(4);
        W.ensure(80);
        W.para([{ text: 'לוח - "לוח החלטה"', ...B, size: 14 }], { align: 'center', after: 2 });
        W.table([
          [
            { draw: (x, y, w, h) => {
                doc.setFillColor('#D9D9D9'); doc.rect(x, y, w, h, 'F');
                doc.setLineWidth(0.3); doc.line(x + w, y, x, y + h);
                W.drawLine(W.layout([{ text: 'הסתברות', ...B, size: 9.5 }], w)[0], y + 1, { right: x + w, left: x + 1.5, align: 'left' });
                W.drawLine(W.layout([{ text: 'חומרת פגיעה', ...B, size: 9.5 }], w)[0], y + h - 5.2, { right: x + w - 1.5, left: x });
              } },
            ...LIKELIHOOD.map((l) => ({ ...hdr(l), fill: '#D9D9D9' })),
          ],
          ...SEVERITY.map((s) => [
            { runs: [{ text: `(${s.name} - ${s.v})\n`, ...B, size: 8.5 }, { text: s.desc, size: 8.5 }] },
            ...LIKELIHOOD.map((l) => {
              const r = riskLevel(s.v, l.v);
              const on = b.sev === s.v && b.lik === l.v;
              return {
                draw: (x, y, w, h) => {
                  doc.setFillColor(fills[r.level]);
                  doc.rect(x, y, w, h, 'F');
                  W.drawLine(W.layout([{ text: String(r.score), ...B, size: 15 }], w)[0], y + 1, { left: x + 2, right: x + w, align: 'left' });
                  if (on) {
                    selRect = [x, y, w, h];
                    doc.setFillColor('#000000');
                    doc.circle(x + w - 4.5, y + h - 4.5, 1.8, 'F');
                  }
                },
              };
            }),
          ]),
        ], [first, cw, cw, cw, cw], { border: 0.5, minRowH: 13, after: () => {
          if (!selRect) return;
          doc.setLineWidth(1.6);
          doc.setDrawColor('#000000');
          const [x, y, w, h] = selRect;
          doc.rect(x + 0.8, y + 0.8, w - 1.6, h - 1.6);
        } });
        if (b.result) {
          W.para([{ text: `הערכת הסיכון: חומרה ${b.sev} × הסתברות ${b.lik} = ` }, { text: String(b.result.score), ...B },
            { text: ` — ${LEVEL_INFO[b.result.level].label}`, ...B }], { after: 2 });
        }
        break;
      }
      case 'declaration':
        W.space(5);
        W.para([{ text: b.text, ...B, italic: true }], { after: 2 });
        break;
      case 'summary':
        W.space(2);
        W.para([{ text: b.label, ...B, italic: true }], { keepNext: true, after: 1 });
        W.para([{ text: b.text, italic: true }]);
        break;
      case 'signature': {
        W.space(6);
        W.ensure(34);
        W.para([{ text: b.intro, italic: true }], { after: 3 });
        const nameRuns = [{ text: 'שם מלא: ', italic: true }, { text: b.name || '__________________', ...B }];
        const line = W.layout(nameRuns, WIDTH)[0];
        const rowH = 16;
        W.drawLine(line, W.y + (rowH - line.h) / 2);
        const sigRight = RIGHT - line.w - 14;
        const lab = W.layout([{ text: 'חתימה: ', italic: true }], WIDTH)[0];
        W.drawLine(lab, W.y + (rowH - lab.h) / 2, { right: sigRight });
        if (b.signature) {
          const sz = await imageSize(b.signature);
          if (sz) {
            const f = fit(sz, 50, rowH);
            doc.addImage(b.signature, imgFormat(b.signature), sigRight - lab.w - 2 - f.w, W.y + (rowH - f.h) / 2, f.w, f.h);
          }
        } else {
          W.drawLine(W.layout([{ text: '______________________' }], WIDTH)[0], W.y + (rowH - lab.h) / 2, { right: sigRight - lab.w - 2 });
        }
        W.y += rowH + 1;
        W.para([{ text: b.title || 'מהנדס אזרחי/הנדסאי אזרחי/ממונה בטיחות בעל השתלמות ענפית בניה', italic: true }]);
        break;
      }
      case 'photos': {
        W.space(6);
        W.para([{ text: b.label, ...B, underline: true }], { keepNext: true, after: 0.5 });
        W.para([{ text: b.sub, italic: true }], { after: 3 });
        const gap = 6;
        const cellW = (WIDTH - gap) / 2;
        const boxH = 66;
        for (let i = 0; i < b.items.length; i += 2) {
          W.ensure(boxH + 8);
          b.items.slice(i, i + 2).forEach((p, j) => {
            const xRight = RIGHT - j * (cellW + gap);
            const f = fit({ w: p.w || 4, h: p.h || 3 }, cellW, boxH);
            const x = xRight - cellW + (cellW - f.w) / 2;
            doc.addImage(p.src, imgFormat(p.src), x, W.y + (boxH - f.h) / 2, f.w, f.h);
            doc.setLineWidth(0.2);
            doc.setDrawColor('#BBBBBB');
            doc.rect(x, W.y + (boxH - f.h) / 2, f.w, f.h);
            const cap = W.layout([{ text: `תמונה ${i + j + 1}${p.caption ? ` — ${p.caption}` : ''}`, italic: true, size: 9 }], cellW)[0];
            W.drawLine(cap, W.y + boxH + 1, { right: xRight, left: xRight - cellW, align: 'center' });
          });
          W.y += boxH + 9;
        }
        break;
      }
    }
  }

  // header (logo / company) and footer (page numbers) on every page
  const pages = doc.getNumberOfPages();
  const logo = model.header.logo ? await imageSize(model.header.logo) : null;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    let hasHeader = false;
    if (logo) {
      const f = fit(logo, 50, 12);
      const textW = model.header.company ? W.width(model.header.company, { bold: true, size: 10 }) + 4 : 0;
      const total = f.w + textW;
      doc.addImage(model.header.logo, imgFormat(model.header.logo), PAGE_W / 2 + total / 2 - f.w, 8, f.w, f.h);
      if (textW) W.drawLine(W.layout([{ text: model.header.company, bold: true, size: 10, color: '#555555' }], WIDTH)[0], 8 + f.h / 2 - 2.5, { right: PAGE_W / 2 + total / 2 - f.w - 4 });
      hasHeader = true;
    } else if (model.header.company) {
      W.drawLine(W.layout([{ text: model.header.company, bold: true, size: 10, color: '#555555' }], WIDTH)[0], 10, { align: 'center' });
      hasHeader = true;
    }
    if (hasHeader) {
      doc.setLineWidth(0.2);
      doc.setDrawColor('#BBBBBB');
      doc.line(LEFT, 21.5, RIGHT, 21.5);
    }
    W.drawLine(W.layout([{ text: `עמוד ${i} מתוך ${pages}`, size: 8, color: '#777777' }], WIDTH)[0], PAGE_H - 11, { align: 'center' });
  }

  return doc.output('blob');
}
