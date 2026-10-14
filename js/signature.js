// משטח חתימה פשוט (עכבר / אצבע / עט) שמחזיר PNG שקוף וחתוך לגבולות החתימה.
export class SignaturePad {
  constructor(canvas) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = 0;
    this.drawing = false;
    canvas.onpointerdown = (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.last = this.pos(e);
      this.dot(this.last);
      this.strokes++;
    };
    canvas.onpointermove = (e) => {
      if (!this.drawing) return;
      const p = this.pos(e);
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(this.last.x, this.last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      this.last = p;
    };
    canvas.onpointerup = canvas.onpointercancel = () => (this.drawing = false);
  }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.c.width = r.width * dpr;
    this.c.height = r.height * dpr;
    this.ctx.scale(dpr, dpr);
    Object.assign(this.ctx, { lineWidth: 2.4, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0b1f4d', fillStyle: '#0b1f4d' });
    this.strokes = 0;
  }

  pos(e) {
    const r = this.c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  dot(p) {
    this.ctx.beginPath();
    this.ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  clear() {
    this.ctx.clearRect(0, 0, this.c.width, this.c.height);
    this.strokes = 0;
  }

  isEmpty() {
    return this.strokes === 0;
  }

  toDataURL() {
    const { width: w, height: h } = this.c;
    const px = this.ctx.getImageData(0, 0, w, h).data;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const pad = 8;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w, x1 + pad); y1 = Math.min(h, y1 + pad);
    const out = document.createElement('canvas');
    out.width = x1 - x0;
    out.height = y1 - y0;
    out.getContext('2d').drawImage(this.c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
}
