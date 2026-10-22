// PDF writer for htmlpdf. All drawing units are CSS px with y growing DOWN (same as the browser).
// Each page content starts with a base matrix that flips to PDF space, so transforms compose like CSS.
// PdfDoc: addPage(wPx, hPx) -> Page, add(dict, data?) -> objId, addShading(def) -> name, build() -> Promise<Uint8Array>.

const K = 0.75;

// Use String.fromCharCode(92) for backslash so the source never contains a bare
// escaped-quote sequence (which would be a JS string literal error).
const BS = String.fromCharCode(92);

function escapeWinAnsi(hex) {
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (b === 92) {
      out += BS + BS; // literal backslash -> \
    } else if (b === 40) {
      out += BS + '('; // open paren -> \(
    } else if (b === 41) {
      out += BS + ')'; // close paren -> \)
    } else if (b < 32 || b > 126) {
      out += BS + b.toString(8).padStart(3, '0'); // \ooo octal
    } else {
      out += String.fromCharCode(b);
    }
  }
  return out;
}

const f = (v) => {
  const s = (+v).toFixed(3);
  return s.indexOf('.') < 0 ? s : s.replace(/0+$/, '').replace(/\.$/, '');
};

async function deflate(u8) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(u8);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

export class Page {
  constructor(doc, w, h) {
    this.doc = doc;
    this.w = w;
    this.h = h;
    this.ops = [`${f(K)} 0 0 ${f(-K)} 0 ${f(h * K)} cm`];
    this.fonts = new Map();
    this.xobjs = new Map();
    this.gs = new Map();
    this.shs = new Map();
  }
  op(s) {
    this.ops.push(s);
    return this;
  }
  save() {
    return this.op('q');
  }
  restore() {
    return this.op('Q');
  }
  transform(a, b, c, d, e, g) {
    return this.op(`${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(e)} ${f(g)} cm`);
  }
  fill(c) {
    return this.op(`${f(c[0])} ${f(c[1])} ${f(c[2])} rg`);
  }
  stroke(c) {
    return this.op(`${f(c[0])} ${f(c[1])} ${f(c[2])} RG`);
  }
  alpha(fillA, strokeA = fillA) {
    const k = `${f(fillA)}_${f(strokeA)}`;
    if (!this.gs.has(k)) this.gs.set(k, { name: 'G' + this.gs.size, ca: fillA, CA: strokeA });
    return this.op(`/${this.gs.get(k).name} gs`);
  }
  lineWidth(w) {
    return this.op(`${f(w)} w`);
  }
  dash(arr, phase = 0) {
    return this.op(arr && arr.length ? `[${arr.map(f).join(' ')}] ${f(phase)} d` : '[] 0 d');
  }
  cap(n) {
    return this.op(`${n} J`);
  }
  move(x, y) {
    return this.op(`${f(x)} ${f(y)} m`);
  }
  line(x, y) {
    return this.op(`${f(x)} ${f(y)} l`);
  }
  curve(x1, y1, x2, y2, x3, y3) {
    return this.op(`${f(x1)} ${f(y1)} ${f(x2)} ${f(y2)} ${f(x3)} ${f(y3)} c`);
  }
  close() {
    return this.op('h');
  }
  rect(x, y, w, h) {
    return this.op(`${f(x)} ${f(y)} ${f(w)} ${f(h)} re`);
  }
  // Rounded rect path. r = [[rx,ry] x4] for tl,tr,br,bl (CSS px).
  roundRect(x, y, w, h, r) {
    const A = 0.5522847498;
    const [tl, tr, br, bl] = r;
    this.move(x + tl[0], y);
    this.line(x + w - tr[0], y);
    this.curve(x + w - tr[0] + tr[0] * A, y, x + w, y + tr[1] - tr[1] * A, x + w, y + tr[1]);
    this.line(x + w, y + h - br[1]);
    this.curve(x + w, y + h - br[1] + br[1] * A, x + w - br[0] + br[0] * A, y + h, x + w - br[0], y + h);
    this.line(x + bl[0], y + h);
    this.curve(x + bl[0] - bl[0] * A, y + h, x, y + h - bl[1] + bl[1] * A, x, y + h - bl[1]);
    this.line(x, y + tl[1]);
    this.curve(x, y + tl[1] - tl[1] * A, x + tl[0] - tl[0] * A, y, x + tl[0], y);
    return this.close();
  }
  paint(mode) {
    return this.op(mode); // f f* S B n
  }
  clip(evenOdd) {
    return this.op(evenOdd ? 'W* n' : 'W n');
  }
  // Text: hex string already encoded for the font. TrueType faces use Identity-H
  // (2 hex digits per glyph), standard PDF fonts use WinAnsi (2 hex digits per byte).
  text(font, size, x, y, hex, o = {}) {
    if (!this.fonts.has(font.key)) this.fonts.set(font.key, { name: 'F' + this.fonts.size, font });
    const nm = this.fonts.get(font.key).name;
    let s = 'BT ';
    if (o.mode && !font.std) s += `${o.mode} Tr ${f(o.strokeW || 0)} w `;
    if (o.spacing) s += `${f(o.spacing)} Tc `;
    if (font.std) {
      // Standard 14 fonts take a literal string in WinAnsi encoding.
      s += `/${nm} ${f(size)} Tf 1 0 0 -1 ${f(x)} ${f(y)} Tm (${escapeWinAnsi(hex)}) Tj ET`;
    } else {
      s += `/${nm} ${f(size)} Tf 1 0 0 -1 ${f(x)} ${f(y)} Tm <${hex}> Tj ET`;
    }
    // Tf size is in user units (px) because the base matrix scales by K.
    return this.op(s);
  }
  image(img, x, y, w, h) {
    if (!this.xobjs.has(img.id)) this.xobjs.set(img.id, 'I' + this.xobjs.size);
    return this.op(`q ${f(w)} 0 0 ${f(-h)} ${f(x)} ${f(y + h)} cm /${this.xobjs.get(img.id)} Do Q`);
  }
  shading(name) {
    this.shs.set(name, name);
    return this.op(`/${name} sh`);
  }
}

export class PdfDoc {
  constructor() {
    this.objs = [null, null]; // 1 catalog, 2 pages (filled in build)
    this.pages = [];
    this.shadings = new Map();
    this.images = new Map();
    this.stdFonts = new Map();
  }
  add(dict, data, compress = true) {
    this.objs.push({ dict, data, compress });
    return this.objs.length;
  }
  addPage(w, h) {
    const p = new Page(this, w, h);
    this.pages.push(p);
    return p;
  }
  // def: { coords:[x0,y0,x1,y1] | radial {coords:[x0,y0,r0,x1,y1,r1]}, stops:[{o, c:[r,g,b]}] } -> name
  addShading(def) {
    const stops = def.stops.slice().sort((a, b) => a.o - b.o);
    const fn = (a, b) => `<< /FunctionType 2 /Domain [0 1] /C0 [${a.map(f).join(' ')}] /C1 [${b.map(f).join(' ')}] /N 1 >>`;
    let func;
    if (stops.length === 2) func = fn(stops[0].c, stops[1].c);
    else {
      const fs = [];
      const bounds = [];
      const enc = [];
      for (let i = 0; i < stops.length - 1; i++) {
        fs.push(fn(stops[i].c, stops[i + 1].c));
        enc.push('0 1');
        if (i > 0) bounds.push(f(stops[i].o));
      }
      func = `<< /FunctionType 3 /Domain [0 1] /Functions [${fs.join(' ')}] /Bounds [${bounds.join(' ')}] /Encode [${enc.join(' ')}] >>`;
    }
    const radial = def.coords.length === 6;
    const id = this.add(
      `<< /ShadingType ${radial ? 3 : 2} /ColorSpace /DeviceRGB /Coords [${def.coords.map(f).join(' ')}] /Function ${func} /Extend [true true] >>`
    );
    const name = 'S' + id;
    this.shadings.set(name, id);
    return name;
  }
  // img: { w, h, rgb:Uint8Array, alpha?:Uint8Array } raw 8-bit, or { jpeg:Uint8Array, w, h } -> {id}
  addImage(img) {
    let smask = '';
    if (img.alpha) smask = ` /SMask ${this.add(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8`, img.alpha)} 0 R`;
    const id = img.jpeg
      ? this.add(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode${smask}`, img.jpeg, false)
      : this.add(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8${smask}`, img.rgb);
    return { id };
  }
  async build() {
    const enc = new TextEncoder();
    const pageIds = [];
    for (const p of this.pages) {
      const cid = this.add('<<', enc.encode(p.ops.join('\n')));
      const font = [...p.fonts.values()].map((v) => `/${v.name} ${v.font.ref(this)} 0 R`).join(' ');
      const xo = [...p.xobjs.entries()].map(([id, n]) => `/${n} ${id} 0 R`).join(' ');
      const gs = [...p.gs.values()].map((g) => `/${g.name} << /ca ${f(g.ca)} /CA ${f(g.CA)} >>`).join(' ');
      const sh = [...p.shs.keys()].map((n) => `/${n} ${this.shadings.get(n)} 0 R`).join(' ');
      pageIds.push(
        this.add(
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.w * K)} ${f(p.h * K)}] /Contents ${cid} 0 R /Resources << /Font << ${font} >> /XObject << ${xo} >> /ExtGState << ${gs} >> /Shading << ${sh} >> >> >>`,
          null
        )
      );
    }
    this.objs[0] = { dict: '<< /Type /Catalog /Pages 2 0 R >>' };
    this.objs[1] = { dict: `<< /Type /Pages /Kids [${pageIds.map((i) => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>` };

    const parts = [];
    let len = 0;
    const push = (u) => {
      parts.push(u);
      len += u.length;
    };
    const str = (s) => push(enc.encode(s));
    const offs = [];
    str('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n');
    for (let i = 0; i < this.objs.length; i++) {
      const o = this.objs[i];
      offs.push(len);
      let dict = o.dict;
      let data = o.data;
      if (data) {
        let filter = '';
        if (o.compress) {
          const z = await deflate(data);
          if (z && z.length < data.length) {
            data = z;
            filter = ' /Filter /FlateDecode';
          }
        }
        // dict strings for streams are opened without the closing '>>'
        const open = dict.endsWith('>>') && !/^<<\s*$/.test(dict) && o.closed !== false ? dict.slice(0, -2) : dict.replace(/^<<\s*$/, '<<');
        dict = `${open}${filter} /Length ${data.length} >>`;
      }
      str(`${i + 1} 0 obj\n${dict}\n`);
      if (data) {
        str('stream\n');
        push(data);
        str('\nendstream\n');
      }
      str('endobj\n');
    }
    const xref = len;
    let x = `xref\n0 ${this.objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offs) x += String(o).padStart(10, '0') + ' 00000 n \n';
    x += `trailer\n<< /Size ${this.objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    str(x);
    const out = new Uint8Array(len);
    let p = 0;
    for (const u of parts) {
      out.set(u, p);
      p += u.length;
    }
    return out;
  }
}
