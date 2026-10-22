// Font registry + TrueType embedding for htmlpdf. Full Unicode: glyphs are addressed by glyph id (CID Identity-H),
// so any character present in the registered font prints (not just ASCII). A ToUnicode map keeps text selectable/searchable.
// registerFont({ family, weight=400, style='normal', data:ArrayBuffer }) ; pickFont(familyList, weight, style) -> Font|null
//
// Standard 14 fallback: when no TrueType face is registered for a family, pickFont returns a logical PDF base font
// (Helvetica / Times / Courier) so documents render without downloading *any* font files. Glyphs outside WinAnsi
// become '?'.

const registry = [];

export function registerFont(o) {
  const family = String(o.family).toLowerCase();
  const weight = Number(o.weight) || 400;
  const style = o.style || 'normal';
  const i = registry.findIndex((r) => r.family === family && r.weight === weight && r.style === style);
  const entry = { family, weight, style, font: new Font(o.data) };
  if (i >= 0) registry[i] = entry;
  else registry.push(entry);
}

export function hasFonts() {
  return registry.length > 0;
}

// ---------- standard 14 fallback ----------

const STD_VARIANTS = {
  helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
};

// Index into the 4-variant array: 0 regular, 1 bold, 2 italic, 3 bold italic.
const SCORE = (bold, italic) => (bold ? 1 : 0) + (italic ? 2 : 0);

class StdFont {
  constructor(base) {
    this.key = 'std:' + base;
    this.std = true;
    this.base = base;
    this.upm = 1000;
    this.asc = base.startsWith('Times') ? 683 : base.startsWith('Courier') ? 629 : 718;
    this.desc = base.startsWith('Times') ? -217 : base.startsWith('Courier') ? -157 : -207;
    this.k = 1;
  }
  encode(text) {
    let hex = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      let b;
      if (cp >= 0x20 && cp <= 0x7e) b = cp;
      else if (cp >= 0xa0 && cp <= 0xff) b = cp;
      else b = WINANSI.get(cp) || 0x3f;
      hex += b.toString(16).padStart(2, '0');
    }
    return { hex, width: 0 }; // width 0 forces per-character positioning in paint.js
  }
  adv() {
    return 0;
  }
  width() {
    return 0;
  }
  ref(doc) {
    if (!doc.stdFonts.has(this.base)) {
      doc.stdFonts.set(this.base, doc.add(`<< /Type /Font /Subtype /Type1 /BaseFont /${this.base} /Encoding /WinAnsiEncoding >>`));
    }
    return doc.stdFonts.get(this.base);
  }
}

const WINANSI = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

// Generic family keywords and known families that hint at the PDF base font class.
// 'sans-serif' must not count as serif, hence the explicit exclusion.
const SERIF_RE = /serif|georgia|times|garamond|palatino|bookman|new york|roman/;
const MONO_RE = /mono|courier|consolas|menlo|terminal/;

const _stdCache = new Map();

function stdFor(names, weight, style) {
  const specific = names.filter((n) => !/^(sans-serif|serif|monospace|system-ui|ui-sans-serif|ui-monospace|sans|mono)$/.test(n));
  const list = specific.length ? specific : names;
  let family = 'helvetica';
  if (list.some((n) => MONO_RE.test(n))) family = 'courier';
  else if (list.some((n) => SERIF_RE.test(n) && n !== 'sans-serif')) family = 'times';
  const k = family + ':' + (weight >= 600 ? 2 : 0) + (style === 'italic' ? 1 : 0);
  if (!_stdCache.has(k)) _stdCache.set(k, new StdFont(STD_VARIANTS[family][SCORE(weight >= 600, style === 'italic')]));
  return _stdCache.get(k);
}

// familyList: CSS font-family computed value, e.g. 'Inter, system-ui, sans-serif'.
export function pickFont(familyList, weight, style) {
  const names = String(familyList || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').toLowerCase());
  let w = Number(weight);
  if (Number.isNaN(w)) w = String(weight).toLowerCase() === 'bold' ? 700 : 400;
  for (const n of names.concat(registry.length ? [registry[0].family] : [])) {
    const c = registry.filter((r) => r.family === n);
    if (!c.length) continue;
    // Closest weight first; among equal weight, exact style wins.
    c.sort((a, b) => Math.abs(a.weight - w) - Math.abs(b.weight - w) || (a.style === style ? 0 : 1) - (b.style === style ? 0 : 1));
    return c[0].font;
  }
  return stdFor(names, w, style);
}

// ---------- @font-face discovery ----------
// Scans a document's stylesheets for @font-face rules and registers every TrueType
// (.ttf / data:) face it can fetch. Used automatically by htmlToPdf unless
// opts.noAutoFonts is true. Returns the number of URLs attempted.

const _fetched = new Set();

export async function discoverFonts(doc = document) {
  const tasks = [];
  const visitSheet = (sheet) => {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (err) {
      return; // cross-origin stylesheet: rules are not readable
    }
    for (const r of rules) {
      if (r.type !== 5) continue; // CSSFontFaceRule
      const st = r.style;
      const family = String(st.getPropertyValue('font-family') || '').replace(/["']/g, '').trim().toLowerCase();
      if (!family) continue;
      const weight = parseInt(st.getPropertyValue('font-weight'), 10) || 400;
      const style = st.getPropertyValue('font-style') || 'normal';
      if (registry.some((x) => x.family === family && x.weight === weight && x.style === style)) continue;
      const src = st.getPropertyValue('src') || '';
      const faces = [];
      for (const m of String(src).matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)) {
        const u = m[2];
        if (/\.(woff2?|otf)(\?|$)/i.test(u)) continue; // CFF/woff not supported
        faces.push(u);
      }
      for (const u of faces) {
        if (_fetched.has(u)) continue;
        _fetched.add(u);
        tasks.push(
          (async () => {
            try {
              const res = await fetch(u);
              if (!res.ok) return;
              const data = await res.arrayBuffer();
              try {
                registerFont({ family, weight, style, data });
              } catch (err) {
                /* not a valid TrueType font */
              }
            } catch (err) {
              /* network/CORS: fall back to standard fonts */
            }
          })()
        );
      }
    }
  };
  // Collect stylesheets from a Document (styleSheets) or from <style> elements
  // in a subtree (e.g. the offscreen host that holds the input's inline CSS).
  const sheets = [];
  if (doc.styleSheets) {
    for (const s of doc.styleSheets) sheets.push(s);
  }
  if (doc.querySelectorAll) {
    for (const el of doc.querySelectorAll('style')) {
      if (el.sheet) sheets.push(el.sheet);
    }
  }
  for (const s of sheets) visitSheet(s);
  await Promise.all(tasks);
  return tasks.length;
}

let uid = 0;

export class Font {
  constructor(buf) {
    this.key = 'f' + uid++;
    this.std = false;
    if (!buf || buf.byteLength < 12) throw new Error('htmlpdf: invalid font data');
    const magic = new DataView(buf).getUint32(0);
    if (magic === 0x4f54544f) throw new Error('htmlpdf: CFF/OpenType (.otf) fonts are not supported, use TrueType (.ttf)');
    if (magic === 0x74746366) throw new Error('htmlpdf: font collections (.ttc) are not supported, use a single .ttf');
    this.data = new Uint8Array(buf);
    const dv = new DataView(buf);
    this.dv = dv;
    const n = dv.getUint16(4);
    const t = {};
    for (let i = 0; i < n; i++) {
      const o = 12 + i * 16;
      t[String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3))] = dv.getUint32(o + 8);
    }
    this.t = t;
    this.upm = dv.getUint16(t.head + 18);
    this.numHM = dv.getUint16(t.hhea + 34);
    const k = 1000 / this.upm;
    this.k = k;
    this.bbox = [36, 38, 40, 42].map((o) => Math.round(dv.getInt16(t.head + o) * k));
    this.asc = Math.round(dv.getInt16(t.hhea + 4) * k);
    this.desc = Math.round(dv.getInt16(t.hhea + 6) * k);
    this.cmap = this._cmap();
    this.used = new Map(); // gid -> codepoint
    this.docs = new Map();
  }
  _cmap() {
    const { dv, t } = this;
    const nt = dv.getUint16(t.cmap + 2);
    let best = null;
    for (let i = 0; i < nt; i++) {
      const r = t.cmap + 4 + i * 8;
      const pid = dv.getUint16(r);
      const eid = dv.getUint16(r + 2);
      const off = t.cmap + dv.getUint32(r + 4);
      const fmt = dv.getUint16(off);
      const score = pid === 3 && eid === 10 && fmt === 12 ? 4 : pid === 0 && fmt === 12 ? 3 : pid === 3 && eid === 1 && fmt === 4 ? 2 : pid === 0 && fmt === 4 ? 1 : 0;
      if (score && (!best || score > best.score)) best = { score, off, fmt };
    }
    if (!best) throw new Error('htmlpdf: font has no usable cmap');
    const map = new Map();
    const o = best.off;
    if (best.fmt === 12) {
      const ng = dv.getUint32(o + 12);
      for (let i = 0; i < ng; i++) {
        const g = o + 16 + i * 12;
        const s = dv.getUint32(g);
        const e = dv.getUint32(g + 4);
        const gi = dv.getUint32(g + 8);
        for (let c = s; c <= e && c - s < 70000; c++) map.set(c, gi + (c - s));
      }
    } else {
      const segX2 = dv.getUint16(o + 6);
      const seg = segX2 / 2;
      for (let i = 0; i < seg; i++) {
        const end = dv.getUint16(o + 14 + i * 2);
        const start = dv.getUint16(o + 16 + segX2 + i * 2);
        const delta = dv.getInt16(o + 16 + 2 * segX2 + i * 2);
        const roAddr = o + 16 + 3 * segX2 + i * 2;
        const ro = dv.getUint16(roAddr);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            g = dv.getUint16(roAddr + ro + (c - start) * 2);
            if (g) g = (g + delta) & 0xffff;
          }
          if (g) map.set(c, g);
        }
      }
    }
    return map;
  }
  adv(gid) {
    const { dv, t } = this;
    return dv.getUint16(t.hmtx + Math.min(gid, this.numHM - 1) * 4) * this.k;
  }
  // text -> { hex, width (em units, multiply by font size) }
  encode(text) {
    let hex = '';
    let w = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const gid = this.cmap.get(cp) || 0;
      this.used.set(gid, gid ? cp : 0);
      w += this.adv(gid);
      hex += gid.toString(16).padStart(4, '0');
    }
    return { hex, width: w / 1000 };
  }
  width(text, size) {
    let w = 0;
    for (const ch of text) w += this.adv(this.cmap.get(ch.codePointAt(0)) || 0);
    return (w / 1000) * size;
  }
  // Writes the font objects into doc once; returns the Type0 object id.
  ref(doc) {
    if (this.docs.has(doc)) return this.docs.get(doc);
    const name = 'Font' + this.key;
    const file = doc.add(`<< /Length1 ${this.data.length}`, this.data);
    const desc = doc.add(
      `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [${this.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${this.asc} /Descent ${this.desc} /CapHeight ${Math.round(this.asc * 0.7)} /StemV 80 /FontFile2 ${file} 0 R >>`
    );
    const gids = [...this.used.keys()].sort((a, b) => a - b);
    const W = gids.map((g) => `${g} [${Math.round(this.adv(g))}]`).join(' ');
    const cid = doc.add(
      `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /DW 0 /W [${W}] >>`
    );
    const hex4 = (n) => n.toString(16).padStart(4, '0');
    const utf16 = (cp) => {
      if (cp < 0x10000) return hex4(cp);
      const v = cp - 0x10000;
      return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff));
    };
    const rows = gids.filter((g) => this.used.get(g)).map((g) => `<${hex4(g)}> <${utf16(this.used.get(g))}>`);
    let body = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
    for (let i = 0; i < rows.length; i += 100) {
      const chunk = rows.slice(i, i + 100);
      body += chunk.length + ' beginbfchar\n' + chunk.join('\n') + '\nendbfchar\n';
    }
    body += 'endcmap CMapName currentdict /CMap defineresource pop end end';
    const id = doc.add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${doc.add('<<', body)} 0 R >>`);
    this.docs.set(doc, id);
    return id;
  }
}
