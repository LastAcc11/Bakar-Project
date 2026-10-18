// מרנדר את מודל המסמך לדף A4 ב-HTML — משמש לתצוגה מקדימה ולהפקת PDF.
import { SEVERITY, LIKELIHOOD, riskLevel, LEVEL_INFO, STATUS } from './templates.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const box = (on) => `<span class="pp-box">${on ? '☒' : '☐'}</span>`;
const multiline = (s) => esc(s).replace(/\n/g, '<br>');

function block(b) {
  switch (b.t) {
    case 'meta':
      return `<div class="pp-meta">
        <div class="pp-date">תאריך הדו"ח: <b>${esc(b.date) || '__________'}</b>${b.number ? ` &nbsp;|&nbsp; מס' דו"ח: <b>${esc(b.number)}</b>` : ''}</div>
        <div class="pp-to"><u>אל</u>: ${b.to.map((x) => `<div>${esc(x)}</div>`).join('')}</div>
      </div>`;
    case 'title':
      return `<h1 class="pp-title">${esc(b.text)} - <i>"${esc(b.site)}"</i></h1>`;
    case 'note':
      return `<p class="pp-note">${esc(b.text)}</p>`;
    case 'h':
      return `<h2 class="pp-h">${b.num ? `<span class="pp-num">${esc(b.num)}.</span>` : ''}<span><u>${esc(b.text)}</u>${
        b.ref ? ` <small>${esc(b.ref)}</small>` : ''}</span></h2>`;
    case 'sub':
      return `<h3 class="pp-sub">${esc(b.text)}</h3>`;
    case 'fields':
      return `<table class="pp-fields">${b.rows
        .map(([k, v]) => `<tr><th>${esc(k)}:</th><td>${multiline(v) || '&nbsp;'}</td></tr>`)
        .join('')}</table>`;
    case 'checklist':
      return `<ul class="pp-check">${b.items
        .map((i) => `<li class="lvl${i.level}">${box(i.checked)} ${esc(i.label)}</li>`)
        .join('')}</ul>`;
    case 'tri': {
      const labels = b.labels || Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label]));
      return `<table class="pp-tri"><thead><tr><th>${esc(b.head)}</th>${['ok', 'bad', 'na']
        .map((k) => `<th>${esc(labels[k])}</th>`)
        .join('')}</tr></thead><tbody>${b.rows
        .map((r) =>
          r.header
            ? `<tr class="is-group"><td colspan="4">${esc(r.label)}</td></tr>`
            : `<tr class="${r.status === 'bad' ? 'is-bad' : ''}"><td class="lvl${r.level || 0}">${esc(r.label)}</td>${['ok', 'bad', 'na']
                .map((k) => `<td class="c">${box(r.status === k)}</td>`)
                .join('')}</tr>`,
        )
        .join('')}</tbody></table>`;
    }
    case 'text':
      return `<div class="pp-text"><h3 class="pp-sub"><u>${esc(b.label)}</u></h3>${
        (b.value || '').trim()
          ? `<p>${multiline(b.value)}</p>`
          : '<div class="pp-lines"><span></span><span></span><span></span></div>'
      }</div>`;
    case 'matrix':
      return matrix(b);
    case 'declaration':
      return `<p class="pp-decl"><i><b>${esc(b.text)}</b></i></p>`;
    case 'summary':
      return `<div class="pp-summary"><h3 class="pp-sub"><i>${esc(b.label)}</i></h3><p><i>${multiline(b.text)}</i></p></div>`;
    case 'signature':
      return `<div class="pp-sign">
        <p><i>${esc(b.intro)}</i></p>
        <div class="pp-sign-row">
          <div>שם מלא: <b>${esc(b.name) || '__________________'}</b></div>
          <div class="pp-sign-img">חתימה: ${b.signature ? `<img src="${b.signature}" alt="">` : '______________________'}</div>
        </div>
        <p><i>${esc(b.title) || 'מהנדס אזרחי/הנדסאי אזרחי/ממונה בטיחות בעל השתלמות ענפית בניה'}</i></p>
      </div>`;
    case 'photos':
      return `<div class="pp-photos ${b.inline ? 'inline' : ''}"><h3 class="pp-sub"><u>${esc(b.label)}</u></h3>${b.sub ? `<p><i>${esc(b.sub)}</i></p>` : ''}
        <div class="pp-photo-grid">${b.items
          .map((p) => `<figure><img src="${p.src}" alt=""><figcaption>תמונה ${p.n}${p.caption ? ` — ${esc(p.caption)}` : ''}</figcaption></figure>`)
          .join('')}</div></div>`;
    default:
      return '';
  }
}

export function matrixTable(sel = {}, { interactive = false } = {}) {
  const head = LIKELIHOOD.map(
    (l) => `<th><div class="mx-lv">(${esc(l.name)} - ${l.v})</div><div class="mx-desc">${esc(l.desc)}</div></th>`,
  ).join('');
  const rows = SEVERITY.map((s) => {
    const cells = LIKELIHOOD.map((l) => {
      const r = riskLevel(s.v, l.v);
      const on = sel.sev === s.v && sel.lik === l.v;
      const attrs = interactive ? ` data-sev="${s.v}" data-lik="${l.v}" role="button" tabindex="0" aria-pressed="${on}"` : '';
      return `<td class="mx-cell mx-${r.level}${on ? ' mx-on' : ''}"${attrs}>${r.score}</td>`;
    }).join('');
    return `<tr><th class="mx-row"><div class="mx-lv">(${esc(s.name)} - ${s.v})</div><div class="mx-desc">${esc(s.desc)}</div></th>${cells}</tr>`;
  }).join('');
  return `<table class="mx"><thead><tr><th class="mx-corner"><span class="a">הסתברות</span><span class="b">חומרת פגיעה</span></th>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function matrix(b) {
  const res = b.result
    ? `<p class="pp-mx-res">הערכת הסיכון: חומרה ${b.sev} × הסתברות ${b.lik} = <b>${b.result.score}</b> — <b>${esc(LEVEL_INFO[b.result.level].label)}</b></p>`
    : '';
  return `<div class="pp-mx"><h3 class="pp-mx-title">לוח - "לוח החלטה"</h3>${matrixTable(b)}${res}</div>`;
}

export function renderPaper(model) {
  const h = model.header;
  const header = `<div class="pp-header">${
    h.logo ? `<img class="pp-logo" src="${h.logo}" alt="">` : ''
  }${h.company || h.slogan ? `<span class="pp-co"><b>${esc(h.company)}</b>${h.slogan ? `<small>${esc(h.slogan)}</small>` : ''}</span>` : ''}</div>`;
  return `<div class="paper" dir="rtl">${header}${model.blocks.map(block).join('\n')}</div>`;
}
