// CSS painter for htmlpdf: walks the laid-out DOM (the browser is the layout engine) and paints every box, border,
// background layer, shadow, image and text run into the PdfDoc as vectors. Units: CSS px, y down, relative to the host.
// Covered: background-color/image (url, linear/radial/conic-gradient, size/position/repeat/clip/origin), border-radius,
// per-side borders (solid/dashed/dotted/double, collapsed table borders), box-shadow (outer/inset, blurred), opacity,
// transform (2D matrix), overflow clip, clip-path (inset/circle/ellipse/polygon), img (object-fit/position),
// inline svg and canvas (rasterised), text (font weight/size/color, letter-spacing, text-transform, underline/line-through/overline,
// text-shadow, text-stroke + paint-order), z-index order, multi-page with break-before / break-inside.
// Not covered: pseudo-elements, list markers, filters, blend modes.

import { pickFont } from './fonts.js';

export const MM = 96 / 25.4;
const SKIP = new Set(['SCRIPT', 'STYLE', 'HEAD', 'META', 'LINK', 'TEMPLATE', 'NOSCRIPT', 'TITLE']);

function warn(msg) {
  console.warn('[htmlpdf] ' + msg);
}

function splitTop(s, sep = ',') {
  const out = [];
  let d = 0;
  let cur = '';
  for (const ch of String(s || '')) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === sep && d === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

let _cx = null;
function parseColor(s) {
  if (!s || s === 'transparent' || s === 'none') return null;
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
  let r, g, b, a;
  if (m) {
    r = +m[1];
    g = +m[2];
    b = +m[3];
    a = m[4] == null ? 1 : m[5] ? +m[4] / 100 : +m[4];
  } else {
    _cx = _cx || document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    _cx.canvas.width = 1;
    _cx.fillStyle = s;
    _cx.fillRect(0, 0, 1, 1);
    const d = _cx.getImageData(0, 0, 1, 1).data;
    r = d[0];
    g = d[1];
    b = d[2];
    a = d[3] / 255;
  }
  if (!(a > 0)) return null;
  return { c: [r / 255, g / 255, b / 255], a };
}

const toLen = (s, ref) => (String(s).endsWith('%') ? (parseFloat(s) * ref) / 100 : parseFloat(s) || 0);
const posVal = (s, total, t) => (String(s).endsWith('%') ? ((total - t) * parseFloat(s)) / 100 : parseFloat(s) || 0);
const setA = (S, a) => S.page.alpha(S.alpha * a);
const adj = (S, px) => (px > 0 && px <= 1.0001 && S.hair ? S.hair : px);

function parseMatrix(s) {
  let m = /^matrix\(([^)]+)\)$/.exec(s);
  if (m) return m[1].split(',').map(Number);
  m = /^matrix3d\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(',').map(Number);
    return [v[0], v[1], v[4], v[5], v[12], v[13]];
  }
  return null;
}

function radiiOf(cs, w, h) {
  const r = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((n) => {
    const v = String(cs['border' + n + 'Radius']).split(' ');
    return [toLen(v[0], w), toLen(v[1] || v[0], h)];
  });
  const lim = (len, a, b) => (a + b > 0 ? len / (a + b) : 1);
  const f = Math.min(1, lim(w, r[0][0], r[1][0]), lim(w, r[3][0], r[2][0]), lim(h, r[0][1], r[3][1]), lim(h, r[1][1], r[2][1]));
  return f < 1 ? r.map(([a, b]) => [a * f, b * f]) : r;
}
const hasRad = (rad) => rad && rad.some((r) => r[0] > 0 && r[1] > 0);
function insetRad(rad, t, r, b, l) {
  const m = (v) => Math.max(0, v);
  return [
    [m(rad[0][0] - l), m(rad[0][1] - t)],
    [m(rad[1][0] - r), m(rad[1][1] - t)],
    [m(rad[2][0] - r), m(rad[2][1] - b)],
    [m(rad[3][0] - l), m(rad[3][1] - b)],
  ];
}
function pathBox(page, x, y, w, h, rad) {
  if (hasRad(rad)) page.roundRect(x, y, w, h, rad);
  else page.rect(x, y, w, h);
}

// clip-path helper: emits the shape path and clips. Returns true if applied.
function clipPathShape(page, cs, r) {
  const v = cs.clipPath;
  if (!v || v === 'none') return false;
  const m = /^(inset|circle|ellipse|polygon)\(([\s\S]*)\)$/.exec(v);
  if (!m) {
    warn('unsupported clip-path: ' + v.slice(0, 40));
    return false;
  }
  const kind = m[1];
  const arg = m[2].trim();
  const w = r.w;
  const h = r.h;
  const len = (s, ref) => (String(s).endsWith('%') ? (parseFloat(s) * ref) / 100 : parseFloat(s) || 0);
  if (kind === 'inset') {
    const rm = /^([\s\S]*?)(?:\s+round\s+([\s\S]*))?$/.exec(arg);
    const sides = rm[1].split(/\s+/).filter(Boolean);
    if (!sides.length) return false;
    const t = len(sides[0], h);
    const ri = len(sides[1] || sides[0], w);
    const b = len(sides[2] || sides[0], h);
    const l = len(sides[3] || sides[1] || sides[0], w);
    if (rm[2]) {
      const rv = rm[2].split(/\s+/).filter(Boolean).map((s) => len(s, w));
      const R = [
        [rv[0], rv[1] || rv[0]],
        [rv[2] || rv[0], rv[3] || rv[1] || rv[0]],
        [rv[4] || rv[2] || rv[0], rv[5] || rv[3] || rv[1] || rv[0]],
        [rv[6] || rv[4] || rv[2] || rv[0], rv[7] || rv[5] || rv[3] || rv[1] || rv[0]],
      ];
      page.roundRect(r.x + l, r.y + t, w - l - ri, h - t - b, R);
    } else {
      page.rect(r.x + l, r.y + t, w - l - ri, h - t - b);
    }
    page.clip();
    return true;
  }
  if (kind === 'polygon') {
    const pts = arg.split(',').map((p) => p.trim().split(/\s+/).filter(Boolean)).filter((p) => p.length >= 2);
    if (!pts.length) return false;
    page.move(r.x + len(pts[0][0], w), r.y + len(pts[0][1], h));
    for (let i = 1; i < pts.length; i++) page.line(r.x + len(pts[i][0], w), r.y + len(pts[i][1], h));
    page.close();
    page.clip();
    return true;
  }
  let cx = w / 2;
  let cy = h / 2;
  const am = /at\s+(\S+)(?:\s+(\S+))?/.exec(arg);
  if (am) {
    cx = cssPos(am[1], w);
    cy = cssPos(am[2] || 'center', h);
  }
  let body = arg;
  if (am) body = arg.replace(/at\s+\S+(\s+\S+)?/, '').trim();
  let rx;
  let ry;
  if (kind === 'circle') {
    let rr = body.split(/\s+/)[0] || 'closest-side';
    if (rr === 'closest-side' || rr === 'farthest-side') {
      const near = Math.min(Math.abs(cx), Math.abs(w - cx), Math.abs(cy), Math.abs(h - cy));
      const far = Math.max(Math.abs(cx), Math.abs(w - cx), Math.abs(cy), Math.abs(h - cy));
      rx = ry = rr === 'closest-side' ? near : far;
    } else {
      rx = ry = String(rr).endsWith('%') ? (Math.sqrt(w * w + h * h) / Math.SQRT2) * (parseFloat(rr) / 100) : parseFloat(rr) || 0;
    }
  } else {
    const vals = body.split(/\s+/).filter(Boolean);
    const calc = (s, ref) => s === 'closest-side' ? Math.min(Math.abs(cx), Math.abs(w - cx), Math.abs(cy), Math.abs(h - cy)) : s === 'farthest-side' ? Math.max(Math.abs(cx), Math.abs(w - cx), Math.abs(cy), Math.abs(h - cy)) : len(s, ref);
    if (vals.length >= 2) {
      rx = calc(vals[0], w);
      ry = calc(vals[1], h);
    } else if (vals.length === 1) {
      rx = ry = calc(vals[0], w);
    } else {
      rx = ry = calc('closest-side', w);
    }
  }
  if (!(rx > 0) || !(ry > 0)) return false;
  page.roundRect(r.x + cx - rx, r.y + cy - ry, 2 * rx, 2 * ry, [[ry, ry], [ry, ry], [ry, ry], [ry, ry]]);
  page.clip();
  return true;
}

// ---------- images ----------
function loadImage(src) {
  return new Promise((res) => {
    const i = new Image();
    i.crossOrigin = 'anonymous';
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = src;
  });
}
function rasterOf(source, dw, dh) {
  try {
    const c = document.createElement('canvas');
    c.width = dw;
    c.height = dh;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0, dw, dh);
    return splitRgba(g.getImageData(0, 0, dw, dh).data, dw, dh);
  } catch (err) {
    warn('image could not be read (cross-origin without CORS?): ' + err.message);
    return null;
  }
}
function splitRgba(d, w, h) {
  const rgb = new Uint8Array(w * h * 3);
  const alpha = new Uint8Array(w * h);
  let opaque = true;
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) {
    rgb[q] = d[p];
    rgb[q + 1] = d[p + 1];
    rgb[q + 2] = d[p + 2];
    alpha[i] = d[p + 3];
    if (d[p + 3] !== 255) opaque = false;
  }
  return { w, h, rgb, alpha: opaque ? null : alpha };
}
const urlsOf = (bg) => [...String(bg || '').matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)].map((m) => m[2]);

async function preload(S, host) {
  const tasks = [];
  const els = [host, ...host.querySelectorAll('*')];
  for (const el of els) {
    if (el !== host && el.parentElement && el.parentElement.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') {
      tasks.push(
        (async () => {
          try {
            await el.decode();
          } catch (e) {
            /* broken image */
          }
          if (!el.naturalWidth) return;
          const k = Math.min(1, 4000 / Math.max(el.naturalWidth, el.naturalHeight));
          const r = rasterOf(el, Math.round(el.naturalWidth * k), Math.round(el.naturalHeight * k));
          if (r) S.imgs.set(el, { ...S.doc.addImage(r), w: el.naturalWidth, h: el.naturalHeight });
        })()
      );
    } else if (tag === 'svg') {
      tasks.push(
        (async () => {
          const b = el.getBoundingClientRect();
          if (!b.width || !b.height) return;
          const c = el.cloneNode(true);
          c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          c.setAttribute('width', b.width);
          c.setAttribute('height', b.height);
          c.style.color = cs.color;
          const im = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(c)));
          if (!im) return;
          const k = 3;
          const r = rasterOf(im, Math.round(b.width * k), Math.round(b.height * k));
          if (r) S.imgs.set(el, { ...S.doc.addImage(r), w: b.width, h: b.height });
        })()
      );
    } else if (tag === 'canvas') {
      if (el.width && el.height) {
        const r = rasterOf(el, el.width, el.height);
        if (r) S.imgs.set(el, { ...S.doc.addImage(r), w: el.width, h: el.height });
      }
    }
    for (const u of urlsOf(cs.backgroundImage)) {
      if (S.imgs.has(u)) continue;
      S.imgs.set(u, null);
      tasks.push(
        (async () => {
          const im = await loadImage(u);
          if (!im) return warn('background image failed to load: ' + u.slice(0, 80));
          const r = rasterOf(im, im.naturalWidth || 1, im.naturalHeight || 1);
          if (r) S.imgs.set(u, { ...S.doc.addImage(r), w: im.naturalWidth || 1, h: im.naturalHeight || 1 });
        })()
      );
    }
  }
  await Promise.all(tasks);
}

// ---------- gradients ----------
function parseStops(parts, L) {
  const st = [];
  for (const p of parts) {
    const m = /^((?:rgba?|color|hsla?|hwb|lab|lch|oklab|oklch)\([^)]*\)|[#\w-]+)\s*(.*)$/.exec(p);
    if (!m) continue;
    const col = parseColor(m[1]) || { c: [0, 0, 0], a: 0 };
    const pos = m[2]
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => (v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v) / L));
    if (!pos.length) st.push({ o: null, col });
    else for (const o of pos) st.push({ o, col });
  }
  if (!st.length) return st;
  if (st[0].o == null) st[0].o = 0;
  if (st[st.length - 1].o == null) st[st.length - 1].o = 1;
  let mx = st[0].o;
  for (const s of st) if (s.o != null) s.o = mx = Math.max(mx, s.o);
  for (let i = 0; i < st.length; i++) {
    if (st[i].o != null) continue;
    let j = i;
    while (st[j].o == null) j++;
    const a = st[i - 1].o;
    const b = st[j].o;
    for (let k = i; k < j; k++) st[k].o = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  // transparent stops take the colour of a neighbour (CSS interpolates premultiplied)
  for (let i = 0; i < st.length; i++) {
    if (st[i].col.a > 0) continue;
    const n = st[i + 1] && st[i + 1].col.a > 0 ? st[i + 1] : st[i - 1] && st[i - 1].col.a > 0 ? st[i - 1] : null;
    if (n) st[i] = { o: st[i].o, col: { c: n.col.c, a: 0 } };
  }
  return st;
}

function vectorStops(st) {
  const out = st.map((s) => ({ o: Math.min(1, Math.max(0, s.o)), c: s.col.c }));
  if (out[0].o > 0) out.unshift({ o: 0, c: out[0].c });
  if (out[out.length - 1].o < 1) out.push({ o: 1, c: out[out.length - 1].c });
  for (let i = 1; i < out.length; i++) if (out[i].o <= out[i - 1].o) out[i].o = Math.min(1, out[i - 1].o + 0.0001);
  return out;
}

function rasterGradient(S, x, y, w, h, draw, st) {
  const s = Math.min(2, 2000 / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * s));
  const ch = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.scale(s, s);
  draw(g, (gr) => {
    for (const t of st) gr.addColorStop(Math.min(1, Math.max(0, t.o)), `rgba(${Math.round(t.col.c[0] * 255)},${Math.round(t.col.c[1] * 255)},${Math.round(t.col.c[2] * 255)},${t.col.a})`);
    return gr;
  });
  const rec = S.doc.addImage(splitRgba(g.getImageData(0, 0, cw, ch).data, cw, ch));
  setA(S, 1);
  S.page.image(rec, x, y, w, h);
}

function cssPos(t, total) {
  if (t === 'left' || t === 'top') return 0;
  if (t === 'center') return total / 2;
  if (t === 'right' || t === 'bottom') return total;
  return toLen(t, total);
}

function drawGradient(S, str, x, y, w, h) {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/.exec(str);
  if (!m || (m[1] && m[2] !== 'linear')) return warn('unsupported gradient: ' + str.slice(0, 40));
  const page = S.page;
  const parts = splitTop(m[3]);
  const tile = (fn) => {
    page.save();
    page.transform(1, 0, 0, 1, x, y);
    page.rect(0, 0, w, h);
    page.clip();
    fn();
    page.restore();
  };
  if (m[2] === 'conic') {
    if (typeof CanvasRenderingContext2D === 'undefined' || typeof CanvasRenderingContext2D.prototype.createConicGradient !== 'function') {
      return warn('conic-gradient needs canvas createConicGradient (modern browser)');
    }
    const parts = splitTop(m[3]);
    let angle = 0;
    let cx = w / 2;
    let cy = h / 2;
    const head = parts[0] || '';
    const fm = /from\s+(-?[\d.]+(?:deg|rad|turn|grad))/.exec(head);
    if (fm) {
      const v = parseFloat(fm[1]);
      angle = /turn/.test(fm[1]) ? v * 2 * Math.PI : /grad/.test(fm[1]) ? (v * Math.PI) / 200 : /rad/.test(fm[1]) ? v : (v * Math.PI) / 180;
    }
    const am = /at\s+(\S+)(?:\s+(\S+))?/.exec(head);
    if (am) {
      cx = cssPos(am[1], w);
      cy = cssPos(am[2] || 'center', h);
    }
    if (fm || am) parts.shift();
    const st = parseStops(parts, 2 * Math.PI);
    if (st.length < 2) return;
    rasterGradient(S, x, y, w, h, (g, add) => {
      g.translate(cx, cy);
      g.fillStyle = add(g.createConicGradient(angle - Math.PI / 2, 0, 0));
      g.fillRect(-cx, -cy, w, h);
    }, st);
    return;
  }
  if (m[2] === 'linear') {
    let dx = 0;
    let dy = 1;
    if (/^(to\s|-?[\d.]+(deg|rad|turn|grad))/.test(parts[0])) {
      const a = parts.shift();
      if (/^to\s/.test(a)) {
        const sx = /right/.test(a) ? 1 : /left/.test(a) ? -1 : 0;
        const sy = /bottom/.test(a) ? 1 : /top/.test(a) ? -1 : 0;
        if (sx && sy) {
          const n = Math.hypot(h, w) || 1;
          dx = (sx * h) / n;
          dy = (sy * w) / n;
        } else {
          dx = sx;
          dy = sy;
        }
      } else {
        const v = parseFloat(a);
        const rad = /turn/.test(a) ? v * 2 * Math.PI : /grad/.test(a) ? (v * Math.PI) / 200 : /rad/.test(a) ? v : (v * Math.PI) / 180;
        dx = Math.sin(rad);
        dy = -Math.cos(rad);
      }
    }
    const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
    const st = parseStops(parts, L);
    if (st.length < 2) return;
    if (m[1]) {
      // repeating-linear-gradient with hard stops (stripes/dashes): drawn as vector bands.
      const p = st[st.length - 1].o - st[0].o;
      if (!(p > 0)) return;
      const bands = [];
      for (let k = Math.floor(-st[st.length - 1].o / p); bands.length < 5000; k++) {
        if (st[0].o + k * p >= 1) break;
        for (let i = 0; i < st.length - 1; i++) if (st[i + 1].o > st[i].o) bands.push([st[i], st[i + 1], k * p]);
      }
      const solid = bands.every(([a, b]) => a.col.a === b.col.a && a.col.c.join() === b.col.c.join());
      if (!solid) return warn('repeating gradient with smooth stops is not supported');
      tile(() => {
        page.transform(dx, dy, -dy, dx, w / 2, h / 2);
        for (const [a, b, sh] of bands) {
          const t0 = a.o + sh;
          const t1 = b.o + sh;
          if (t1 <= t0 || a.col.a <= 0 || t1 <= 0 || t0 >= 1) continue;
          page.fill(a.col.c);
          setA(S, a.col.a);
          page.rect((t0 - 0.5) * L, -(w + h), (t1 - t0) * L, 2 * (w + h));
          page.paint('f');
        }
      });
      return;
    }
    const cx = w / 2;
    const cy = h / 2;
    const co = [cx - (dx * L) / 2, cy - (dy * L) / 2, cx + (dx * L) / 2, cy + (dy * L) / 2];
    if (st.every((s) => s.col.a >= 1)) {
      tile(() => {
        setA(S, 1);
        page.shading(S.doc.addShading({ coords: co, stops: vectorStops(st) }));
      });
    } else {
      rasterGradient(S, x, y, w, h, (g, add) => {
        g.fillStyle = add(g.createLinearGradient(co[0], co[1], co[2], co[3]));
        g.fillRect(0, 0, w, h);
      }, st);
    }
    return;
  }
  let shape = 'ellipse';
  let ext = 'farthest-corner';
  let cx = w / 2;
  let cy = h / 2;
  if (/^(circle|ellipse|closest|farthest|at\s)/.test(parts[0])) {
    const head = parts.shift();
    if (/circle/.test(head)) shape = 'circle';
    const e = /(closest-side|closest-corner|farthest-side|farthest-corner)/.exec(head);
    if (e) ext = e[1];
    const at = /at\s+(\S+)(?:\s+(\S+))?/.exec(head);
    if (at) {
      cx = cssPos(at[1], w);
      cy = cssPos(at[2] || 'center', h);
    }
  }
  const near = [Math.min(cx, w - cx), Math.min(cy, h - cy)];
  const far = [Math.max(cx, w - cx), Math.max(cy, h - cy)];
  let rx;
  let ry;
  if (shape === 'circle') {
    rx = ry = ext === 'closest-side' ? Math.min(...near) : ext === 'farthest-side' ? Math.max(...far) : ext === 'closest-corner' ? Math.hypot(...near) : Math.hypot(...far);
  } else {
    const k = /corner/.test(ext) ? Math.SQRT2 : 1;
    const b = /closest/.test(ext) ? near : far;
    rx = b[0] * k;
    ry = b[1] * k;
  }
  if (!(rx > 0) || !(ry > 0)) return;
  const st = parseStops(parts, rx);
  if (st.length < 2) return;
  const sY = ry / rx;
  if (st.every((s) => s.col.a >= 1)) {
    tile(() => {
      setA(S, 1);
      page.transform(1, 0, 0, 1, cx, cy);
      page.transform(1, 0, 0, sY, 0, 0);
      page.shading(S.doc.addShading({ coords: [0, 0, 0, 0, 0, rx], stops: vectorStops(st) }));
    });
  } else {
    rasterGradient(S, x, y, w, h, (g, add) => {
      g.translate(cx, cy);
      g.scale(1, sY);
      g.fillStyle = add(g.createRadialGradient(0, 0, 0, 0, 0, rx));
      g.fillRect(-cx, -cy / sY, w, h / sY);
    }, st);
  }
}

// ---------- boxes ----------
function paintShadows(S, cs, r, rad) {
  const v = cs.boxShadow;
  if (!v || v === 'none') return;
  const page = S.page;
  for (const sh of splitTop(v).reverse()) {
    const inset = /\binset\b/.test(sh);
    const cm = /(rgba?\([^)]*\)|color\([^)]*\)|#[0-9a-f]+)/i.exec(sh);
    const col = parseColor(cm ? cm[1] : cs.color);
    if (!col) continue;
    const nums = (cm ? sh.replace(cm[1], '') : sh).match(/-?[\d.]+px/g) || [];
    const [ox, oy, bl = 0, sp = 0] = nums.map(parseFloat);
    const N = bl > 0 ? 10 : 1;
    const p = 1 - Math.pow(1 - col.a, 1 / N);
    if (inset) {
      // Inset shadow: clip to the box, then fill the ring between the box and a
      // shrunk hole (shifted by the offset so the shadow gathers on the opposite side).
      for (let i = 0; i < N; i++) {
        const e = sp + (bl > 0 ? bl * ((i + 0.5) / N) : 0);
        const hw = r.w - 2 * e;
        const hh = r.h - 2 * e;
        if (hw <= 0 || hh <= 0) continue;
        const hole = { x: r.x + e + ox, y: r.y + e + oy, w: hw, h: hh };
        const rr = (rad || [[0, 0], [0, 0], [0, 0], [0, 0]]).map(([a, b]) => [a > 0 ? Math.max(0, a - e) : 0, b > 0 ? Math.max(0, b - e) : 0]);
        page.save();
        pathBox(page, r.x, r.y, r.w, r.h, rad);
        pathBox(page, hole.x, hole.y, hole.w, hole.h, rr);
        page.clip(true);
        page.fill(col.c);
        page.alpha(S.alpha * p);
        page.rect(-1e5, -1e5, 2e5, 2e5);
        page.paint('f');
        page.restore();
      }
      continue;
    }
    page.save();
    page.rect(-1e5, -1e5, 2e5, 2e5);
    pathBox(page, r.x, r.y, r.w, r.h, rad);
    page.clip(true);
    page.fill(col.c);
    for (let i = 0; i < N; i++) {
      const e = sp + (bl > 0 ? bl * (1 - ((i + 0.5) * 2) / N) : 0);
      const w = r.w + 2 * e;
      const h = r.h + 2 * e;
      if (w <= 0 || h <= 0) continue;
      const rr = (rad || [[0, 0], [0, 0], [0, 0], [0, 0]]).map(([a, b]) => [a > 0 ? Math.max(0, a + e) : 0, b > 0 ? Math.max(0, b + e) : 0]);
      page.alpha(S.alpha * p);
      pathBox(page, r.x + ox - e, r.y + oy - e, w, h, rr);
      page.paint('f');
    }
    page.restore();
  }
}

function paintBackground(S, cs, r, rad, bw) {
  const page = S.page;
  const bg = parseColor(cs.backgroundColor);
  const img = cs.backgroundImage;
  const has = img && img !== 'none';
  if (!bg && !has) return;
  const [bt, br, bb, bl] = bw;
  let c = { x: r.x, y: r.y, w: r.w, h: r.h };
  let crad = rad;
  if (cs.backgroundClip === 'padding-box' || cs.backgroundClip === 'content-box') {
    c = { x: r.x + bl, y: r.y + bt, w: r.w - bl - br, h: r.h - bt - bb };
    if (rad) crad = insetRad(rad, bt, br, bb, bl);
  }
  if (c.w <= 0 || c.h <= 0) return;
  page.save();
  pathBox(page, c.x, c.y, c.w, c.h, crad);
  page.clip();
  if (bg) {
    page.fill(bg.c);
    setA(S, bg.a);
    page.rect(c.x, c.y, c.w, c.h);
    page.paint('f');
  }
  if (has) {
    const border = cs.backgroundOrigin === 'border-box';
    const ox = border ? r.x : r.x + bl;
    const oy = border ? r.y : r.y + bt;
    const ow = border ? r.w : r.w - bl - br;
    const oh = border ? r.h : r.h - bt - bb;
    const layers = splitTop(img);
    const sizes = splitTop(cs.backgroundSize);
    const poss = splitTop(cs.backgroundPosition);
    const reps = splitTop(cs.backgroundRepeat);
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const sz = sizes[i % sizes.length] || 'auto';
      const ps = poss[i % poss.length] || '0% 0%';
      const rp = reps[i % reps.length] || 'repeat';
      let nat = null;
      const um = /^url\(\s*(["']?)(.*?)\1\s*\)$/.exec(L);
      if (um) {
        nat = S.imgs.get(um[2]);
        if (!nat) continue;
      } else if (!/gradient\(/.test(L)) continue;
      const natw = nat ? nat.w : ow;
      const nath = nat ? nat.h : oh;
      let tw;
      let th;
      if (sz === 'cover' || sz === 'contain') {
        const k = sz === 'cover' ? Math.max(ow / natw, oh / nath) : Math.min(ow / natw, oh / nath);
        tw = natw * k;
        th = nath * k;
      } else {
        const sp = sz.split(/\s+/);
        tw = sp[0] === 'auto' ? null : toLen(sp[0], ow);
        th = (sp[1] || 'auto') === 'auto' ? null : toLen(sp[1], oh);
        if (tw == null && th == null) {
          tw = natw;
          th = nath;
        } else if (tw == null) tw = nat ? (th * natw) / nath : ow;
        else if (th == null) th = nat ? (tw * nath) / natw : oh;
      }
      if (!(tw > 0) || !(th > 0)) continue;
      const pp = ps.split(/\s+/);
      const x0 = ox + posVal(pp[0], ow, tw);
      const y0 = oy + posVal(pp[1] || '50%', oh, th);
      let rt = rp.split(/\s+/);
      if (rp === 'repeat-x') rt = ['repeat', 'no-repeat'];
      else if (rp === 'repeat-y') rt = ['no-repeat', 'repeat'];
      const repX = rt[0] !== 'no-repeat';
      const repY = (rt[1] || rt[0]) !== 'no-repeat';
      const axis = (start, size, c0, c1, rep) => {
        if (!rep) return [start];
        const out = [];
        for (let v = start - Math.ceil((start - c0) / size) * size; v < c1 && out.length < 3000; v += size) out.push(v);
        return out;
      };
      for (const ty of axis(y0, th, c.y, c.y + c.h, repY)) {
        for (const tx of axis(x0, tw, c.x, c.x + c.w, repX)) {
          if (nat) {
            setA(S, 1);
            page.image(nat, tx, ty, tw, th);
          } else drawGradient(S, L, tx, ty, tw, th);
        }
      }
    }
  }
  page.restore();
}

function strokeSide(S, i, r, bw, st, col, collapse) {
  const page = S.page;
  const t = bw[i];
  const e = collapse ? 0 : t / 2;
  const { x, y, w, h } = r;
  const ends = [
    [x, y + e, x + w, y + e],
    [x + w - e, y, x + w - e, y + h],
    [x, y + h - e, x + w, y + h - e],
    [x + e, y, x + e, y + h],
  ][i];
  page.save();
  page.stroke(col.c);
  setA(S, col.a);
  page.lineWidth(t);
  if (st === 'dashed') {
    page.dash([t * 3, t * 3]);
    page.cap(0);
  } else if (st === 'dotted') {
    page.dash([0.01, t * 2]);
    page.cap(1);
  } else page.cap(collapse ? 2 : 0);
  page.move(ends[0], ends[1]);
  page.line(ends[2], ends[3]);
  page.paint('S');
  page.restore();
}

function paintBorders(S, cs, r, rad, collapse, flags) {
  const page = S.page;
  const names = ['Top', 'Right', 'Bottom', 'Left'];
  const bw = names.map((n) => adj(S, parseFloat(cs['border' + n + 'Width']) || 0));
  const st = names.map((n) => cs['border' + n + 'Style']);
  const col = names.map((n) => parseColor(cs['border' + n + 'Color']));
  const ok = names.map((_, i) => bw[i] > 0 && col[i] && st[i] !== 'none' && st[i] !== 'hidden');
  if (flags && flags.skipL) ok[3] = false;
  if (flags && flags.skipR) ok[1] = false;
  if (!ok.some(Boolean)) return;
  if (collapse) {
    for (let i = 0; i < 4; i++) if (ok[i]) strokeSide(S, i, r, bw, st[i], col[i], true);
    return;
  }
  const [T, R, B, Lw] = bw;
  const same = ok.every(Boolean) && st.every((s) => s === 'solid') && col.every((c) => c.a === col[0].a && c.c.join() === col[0].c.join());
  if (same) {
    page.save();
    page.fill(col[0].c);
    setA(S, col[0].a);
    pathBox(page, r.x, r.y, r.w, r.h, rad);
    pathBox(page, r.x + Lw, r.y + T, r.w - Lw - R, r.h - T - B, rad ? insetRad(rad, T, R, B, Lw) : null);
    page.paint('f*');
    page.restore();
    return;
  }
  const { x, y, w, h } = r;
  const polys = [
    [[x, y], [x + w, y], [x + w - R, y + T], [x + Lw, y + T]],
    [[x + w, y], [x + w, y + h], [x + w - R, y + h - B], [x + w - R, y + T]],
    [[x + w, y + h], [x, y + h], [x + Lw, y + h - B], [x + w - R, y + h - B]],
    [[x, y + h], [x, y], [x + Lw, y + T], [x + Lw, y + h - B]],
  ];
  page.save();
  if (hasRad(rad)) {
    pathBox(page, x, y, w, h, rad);
    page.clip();
  }
  for (let i = 0; i < 4; i++) {
    if (!ok[i]) continue;
    if (st[i] === 'dashed' || st[i] === 'dotted') {
      strokeSide(S, i, r, bw, st[i], col[i], false);
    } else if (st[i] === 'double' && bw[i] >= 3) {
      const t3 = bw[i] / 3;
      const inner = bw.slice();
      inner[i] = t3;
      strokeSide(S, i, r, inner, 'solid', col[i], false);
      const rr = { x, y, w, h };
      const off = (bw[i] * 2) / 3;
      if (i === 0) rr.y += off, rr.h -= off;
      else if (i === 1) rr.w -= off;
      else if (i === 2) rr.h -= off;
      else rr.x += off, rr.w -= off;
      strokeSide(S, i, rr, inner, 'solid', col[i], false);
    } else {
      page.fill(col[i].c);
      setA(S, col[i].a);
      const p = polys[i];
      page.move(p[0][0], p[0][1]);
      for (let k = 1; k < 4; k++) page.line(p[k][0], p[k][1]);
      page.close();
      page.paint('f');
    }
  }
  page.restore();
}

function paintImg(S, el, cs, r, bw, rad) {
  const rec = S.imgs.get(el);
  if (!rec) return;
  const pad = ['Top', 'Right', 'Bottom', 'Left'].map((n) => parseFloat(cs['padding' + n]) || 0);
  const x = r.x + bw[3] + pad[3];
  const y = r.y + bw[0] + pad[0];
  const w = r.w - bw[1] - bw[3] - pad[1] - pad[3];
  const h = r.h - bw[0] - bw[2] - pad[0] - pad[2];
  if (w <= 0 || h <= 0) return;
  let dw = w;
  let dh = h;
  const fit = cs.objectFit;
  if (fit === 'contain' || (fit === 'scale-down' && (rec.w > w || rec.h > h))) {
    const k = Math.min(w / rec.w, h / rec.h);
    dw = rec.w * k;
    dh = rec.h * k;
  } else if (fit === 'cover') {
    const k = Math.max(w / rec.w, h / rec.h);
    dw = rec.w * k;
    dh = rec.h * k;
  } else if (fit === 'none' || fit === 'scale-down') {
    dw = rec.w;
    dh = rec.h;
  }
  const op = String(cs.objectPosition || '50% 50%').split(/\s+/);
  const page = S.page;
  page.save();
  pathBox(page, x, y, w, h, rad ? insetRad(rad, bw[0] + pad[0], bw[1] + pad[1], bw[2] + pad[2], bw[3] + pad[3]) : null);
  page.clip();
  setA(S, 1);
  page.image(rec, x + posVal(op[0], w, dw), y + posVal(op[1] || '50%', h, dh), dw, dh);
  page.restore();
}

// ---------- text ----------
function paintText(S, node) {
  const el = node.parentElement;
  if (!el) return;
  const cs = getComputedStyle(el);
  if (cs.visibility !== 'visible' || cs.display === 'none') return;
  const str = node.nodeValue;
  const range = document.createRange();
  range.selectNodeContents(node);
  const nb = range.getBoundingClientRect();
  if (!nb.width && !nb.height) return;
  const o = S.o;
  if (nb.bottom - o.y < S.top - 2 || nb.top - o.y > S.bottom + 2) return;
  const size = parseFloat(cs.fontSize);
  const font = pickFont(cs.fontFamily, cs.fontWeight, cs.fontStyle);
  if (!font) throw new Error('htmlpdf: no font registered for "' + cs.fontFamily + '" (call registerFont first)');
  const col = parseColor(cs.color) || { c: [0, 0, 0], a: 1 };
  const ls = parseFloat(cs.letterSpacing) || 0;
  const tt = cs.textTransform;
  const base = Math.round((font.asc * size) / 1000);
  const deco = cs.textDecorationLine || 'none';
  const sw = parseFloat(cs.webkitTextStrokeWidth) || 0;
  const sc = sw > 0 ? parseColor(cs.webkitTextStrokeColor) : null;
  const strokeFirst = /^stroke/.test(cs.paintOrder || '');
  const words = [];
  const segs = [];
  let word = null;
  let seg = null;
  let prev = ' ';
  for (let i = 0; i < str.length;) {
    const len = str.codePointAt(i) > 0xffff ? 2 : 1;
    let ch = str.substr(i, len);
    range.setStart(node, i);
    range.setEnd(node, i + len);
    i += len;
    const rc = range.getClientRects()[0];
    const was = prev;
    prev = ch;
    if (!rc || rc.width === 0) {
      word = null;
      continue;
    }
    if (tt === 'uppercase') ch = ch.toUpperCase();
    else if (tt === 'lowercase') ch = ch.toLowerCase();
    else if (tt === 'capitalize' && /\s/.test(was)) ch = ch.toUpperCase();
    const top = rc.top - o.y;
    const x = rc.left - o.x;
    const r = rc.right - o.x;
    if (seg && Math.abs(seg.top - top) > 1) seg = null;
    if (!seg) segs.push((seg = { top, x0: x, x1: r }));
    seg.x1 = r;
    if (/\s/.test(ch)) {
      word = null;
      continue;
    }
    if (word && Math.abs(word.top - top) > 1) word = null;
    if (!word) words.push((word = { top, chars: [] }));
    word.chars.push({ ch, x, r });
  }
  const page = S.page;
  const emit = (fillCol, dx, dy, mode) => {
    for (const w of words) {
      const y = w.top + base + dy;
      const text = w.chars.map((c) => c.ch).join('');
      const enc = font.encode(text);
      const first = w.chars[0];
      const last = w.chars[w.chars.length - 1];
      const predicted = enc.width * size + ls * w.chars.length;
      const runs = w.chars.length === 1 || Math.abs(predicted - (last.r - first.x)) <= 0.35 ? [{ x: first.x, hex: enc.hex, sp: ls }] : w.chars.map((c) => ({ x: c.x, hex: font.encode(c.ch).hex, sp: 0 }));
      for (const u of runs) {
        page.save();
        page.fill(fillCol.c);
        if (sc) page.stroke(sc.c);
        setA(S, fillCol.a);
        page.text(font, size, u.x + dx, y, u.hex, { mode, strokeW: sw, spacing: u.sp });
        page.restore();
      }
    }
  };
  const ts = cs.textShadow;
  if (ts && ts !== 'none') {
    const first = splitTop(ts)[0];
    const cm = /(rgba?\([^)]*\)|#[0-9a-f]+)/i.exec(first);
    const sh = parseColor(cm ? cm[1] : cs.color);
    const nums = (cm ? first.replace(cm[1], '') : first).match(/-?[\d.]+px/g) || [];
    if (sh) emit(sh, parseFloat(nums[0]) || 0, parseFloat(nums[1]) || 0, 0);
  }
  if (sc && strokeFirst) {
    emit(col, 0, 0, 1);
    emit(col, 0, 0, 0);
  } else emit(col, 0, 0, sc ? 2 : 0);
  if (deco !== 'none') {
    const dc = parseColor(cs.textDecorationColor) || col;
    const th = Math.max(1, size / 14);
    for (const s of segs) {
      page.save();
      page.fill(dc.c);
      setA(S, dc.a);
      const b = s.top + base;
      if (/underline/.test(deco)) page.rect(s.x0, b + size * 0.1, s.x1 - s.x0, th);
      if (/line-through/.test(deco)) page.rect(s.x0, b - size * 0.3, s.x1 - s.x0, th);
      if (/overline/.test(deco)) page.rect(s.x0, b - size * 0.9, s.x1 - s.x0, th);
      page.paint('f');
      page.restore();
    }
  }
}

// ---------- element walk ----------
function paintEl(S, el) {
  if (SKIP.has(el.tagName)) return;
  const cs = getComputedStyle(el);
  if (cs.display === 'none') return;
  const page = S.page;
  const o = S.o;
  const op = parseFloat(cs.opacity);
  const tm = cs.transform && cs.transform !== 'none' ? parseMatrix(cs.transform) : null;
  const origin = cs.transformOrigin;
  const prevAlpha = S.alpha;
  const prevNonTrivial = S.nonTrivial;
  let rect;
  // Prefer real measured values without touching style. For a pure translation,
  // getBoundingClientRect() is the local box shifted by the matrix; we recover it
  // by subtracting the translate. For rotation/scale we must neutralise the
  // transform to measure the untransformed box (the element is a clone inside a
  // hidden host, so this has no visible effect).
  if (tm && S.nonTrivial === false && tm[0] === 1 && tm[1] === 0 && tm[2] === 0 && tm[3] === 1) {
    const b = el.getBoundingClientRect();
    rect = { left: b.left - tm[4], top: b.top - tm[5], width: b.width, height: b.height };
  }
  if (!rect) {
    const prevT = el.style.transform;
    if (tm) el.style.transform = 'none';
    rect = el.getBoundingClientRect();
    if (tm) el.style.transform = prevT;
  }
  if (tm && (tm[0] !== 1 || tm[1] !== 0 || tm[2] !== 0 || tm[3] !== 1)) S.nonTrivial = true;
  const tag = el.tagName.toLowerCase();
  const display = cs.display;
  const inline = display === 'inline';
  const clip = !inline && cs.clipPath && cs.clipPath !== 'none';
  const saved = op < 1 || tm || clip;
  if (saved) page.save();
  if (op < 1) S.alpha *= op;
  if (tm) {
    const [ox, oy] = origin.split(' ').map(parseFloat);
    const px = rect.left - o.x + ox;
    const py = rect.top - o.y + oy;
    page.transform(1, 0, 0, 1, px, py);
    page.transform(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]);
    page.transform(1, 0, 0, 1, -px, -py);
  }
  if (clip) {
    const cr = { x: rect.left - o.x, y: rect.top - o.y, w: rect.width, h: rect.height };
    clipPathShape(page, cs, cr);
  }
  if (display !== 'contents' && cs.visibility === 'visible') {
    const tcs = el.closest && (display.startsWith('table') ? el.closest('table') : null);
    const collapse = !!tcs && getComputedStyle(tcs).borderCollapse === 'collapse' && display !== 'table-column' && display !== 'table-column-group';
    const frags = inline ? [...el.getClientRects()] : [rect];
    frags.forEach((fr, i) => {
      const r = { x: fr.left - o.x, y: fr.top - o.y, w: fr.width, h: fr.height };
      if (r.w <= 0 && r.h <= 0) return;
      const rad = inline ? null : radiiOf(cs, r.w, r.h);
      const flags = inline ? { skipL: i > 0, skipR: i < frags.length - 1 } : null;
      const bw = ['Top', 'Right', 'Bottom', 'Left'].map((n) => {
        const st = cs['border' + n + 'Style'];
        return st === 'none' || st === 'hidden' ? 0 : adj(S, parseFloat(cs['border' + n + 'Width']) || 0);
      });
      if (flags && flags.skipL) bw[3] = 0;
      if (flags && flags.skipR) bw[1] = 0;
      if (!collapse) paintShadows(S, cs, r, rad);
      paintBackground(S, cs, r, rad, collapse ? [0, 0, 0, 0] : bw);
      paintBorders(S, cs, r, rad, collapse, flags);
      if (tag === 'img' || tag === 'canvas' || tag === 'svg') paintImg(S, el, cs, r, bw, rad);
    });
  }
  if (tag !== 'img' && tag !== 'canvas' && tag !== 'svg') {
    const clip = !inline && (cs.overflowX !== 'visible' || cs.overflowY !== 'visible');
    if (clip) {
      const r = { x: rect.left - o.x, y: rect.top - o.y, w: rect.width, h: rect.height };
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      const bb = parseFloat(cs.borderBottomWidth) || 0;
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const rad = radiiOf(cs, r.w, r.h);
      page.save();
      pathBox(page, r.x + bl, r.y + bt, r.w - bl - br, r.h - bt - bb, hasRad(rad) ? insetRad(rad, bt, br, bb, bl) : null);
      page.clip();
    }
    const kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 1) {
        const c = getComputedStyle(n);
        const z = c.position !== 'static' && c.zIndex !== 'auto' ? Number(c.zIndex) || 0 : 0;
        kids.push({ n, z });
      } else if (n.nodeType === 3 && n.nodeValue.trim() !== '') kids.push({ n, z: 0 });
    }
    if (kids.some((k) => k.z !== 0)) kids.sort((a, b) => a.z - b.z);
    for (const k of kids) {
      if (k.n.nodeType === 1) paintEl(S, k.n);
      else paintText(S, k.n);
    }
    if (clip) page.restore();
  }
  if (saved) page.restore();
  S.alpha = prevAlpha;
  S.nonTrivial = prevNonTrivial;
}

// Pushes elements down (margin-top) so break-before: page starts a page and break-inside: avoid never straddles one.
function paginate(host, contentH) {
  const y0 = host.getBoundingClientRect().top;
  const push = (el, d) => {
    el.style.marginTop = (parseFloat(getComputedStyle(el).marginTop) || 0) + d + 'px';
  };
  for (const el of host.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    const top = r.top - y0;
    const force = /^(page|always|left|right)$/.test(cs.breakBefore) || cs.pageBreakBefore === 'always';
    const avoid = cs.breakInside === 'avoid' || cs.pageBreakInside === 'avoid';
    if (force && top > 0.5 && top % contentH > 0.5) push(el, contentH - (top % contentH));
    else if (avoid && r.height <= contentH && Math.floor(top / contentH) !== Math.floor((top + r.height - 0.01) / contentH)) push(el, contentH - (top % contentH));
  }
}

export async function render(host, doc, opts) {
  const S = { doc, page: null, o: null, alpha: 1, imgs: new Map(), hair: (opts.hairline || 0) * MM, top: 0, bottom: Infinity, nonTrivial: false };
  await preload(S, host);
  const pw = opts.width * MM;
  const m = (opts.margin || 0) * MM;
  const auto = !opts.height;
  const ph = auto ? 0 : opts.height * MM;
  const contentH = auto ? 0 : ph - 2 * m;
  if (!auto) paginate(host, contentH);
  const hr = host.getBoundingClientRect();
  S.o = { x: hr.left, y: hr.top };
  const total = hr.height;
  const n = auto ? 1 : Math.max(1, Math.ceil((total - 0.5) / contentH));
  const pageH = auto ? total + 2 * m : ph;
  const bg = opts.background ? parseColor(opts.background) : null;
  for (let i = 0; i < n; i++) {
    const page = doc.addPage(pw, pageH);
    S.page = page;
    S.top = auto ? 0 : i * contentH;
    S.bottom = auto ? Infinity : (i + 1) * contentH;
    if (bg) {
      page.fill(bg.c);
      page.rect(0, 0, pw, pageH);
      page.paint('f');
    }
    page.save();
    page.rect(m, m, pw - 2 * m, pageH - 2 * m);
    page.clip();
    page.transform(1, 0, 0, 1, m, m - (auto ? 0 : i * contentH));
    paintEl(S, host);
    page.restore();
  }
}
