// htmlpdf: write HTML + CSS, get a vector PDF that matches what the browser lays out. Zero dependencies, no build step.
//
//   import { htmlToPdf, downloadPdf } from 'htmlpdf';
//   const pdf = await htmlToPdf('<h1 style="color:tomato">Hello</h1>', {
//     fonts: [{ family: 'Inter', weight: 400, url: './Inter-400.ttf' }],   // same font files your CSS uses
//   });
//   downloadPdf(pdf, 'hello.pdf');
//
// opts: width/height mm (default A4 210x297; height 0 = one page as tall as the content), margin mm, background css
//   colour (default '#fff', null = none), hairline mm (borders thinner than 1px are drawn this wide), css string,
//   fonts [{ family, weight=400, style='normal', url }] (loaded once, cached).
// input: HTML string or a DOM node (cloned).
// Helpers: pdfBlobUrl, openPdf, downloadPdf, printPdf. Low level: registerFont, registerFontUrl.

import { PdfDoc } from './writer.js';
import { registerFont, discoverFonts } from './fonts.js';
import { render, MM } from './paint.js';

export { registerFont };

export async function registerFontUrl(family, url, o = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('htmlpdf: cannot load font ' + url);
  registerFont({ family, weight: o.weight, style: o.style, data: await res.arrayBuffer() });
}

const loading = new Map();
function loadFonts(list) {
  return Promise.all(
    list.map((f) => {
      const url = String(f.url instanceof URL ? f.url.href : new URL(f.url, document.baseURI).href);
      const key = [f.family, f.weight || 400, f.style || 'normal', url].join('|');
      if (!loading.has(key)) {
        loading.set(
          key,
          registerFontUrl(f.family, url, f).catch((err) => {
            loading.delete(key);
            throw err;
          })
        );
      }
      return loading.get(key);
    })
  );
}

/**
 * @typedef {Object} FontSource
 * @property {string} family
 * @property {number} [weight] default 400
 * @property {'normal'|'italic'} [style] default 'normal'
 * @property {string|URL} url TrueType (.ttf) file the CSS also uses
 */

/**
 * @typedef {Object} HtmlToPdfOptions
 * @property {number} [width] page width in mm (default 210)
 * @property {number} [height] page height in mm (default 297, 0 = one page as tall as the content)
 * @property {number} [margin] page margin in mm (default 0)
 * @property {string|null} [background] page colour (default '#fff', null = none)
 * @property {number} [hairline] width in mm for borders thinner than 1px (default 0)
 * @property {string} [css] extra CSS applied to the content
 * @property {FontSource[]} [fonts] fonts to load once and cache
 * @property {boolean} [noAutoFonts] disable automatic @font-face discovery (default false)
 */

/**
 * Renders HTML (string or DOM node) to a vector PDF.
 * @param {string|Node} input
 * @param {HtmlToPdfOptions} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function htmlToPdf(input, opts = {}) {
  const o = { width: 210, height: 297, margin: 0, background: '#fff', hairline: 0, css: '', fonts: [], noAutoFonts: false, ...opts };
  if (o.fonts.length) await loadFonts(o.fonts);
  else if (!o.noAutoFonts) await discoverFonts(document);
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = `position:absolute;left:-100000px;top:0;margin:0;padding:0;box-sizing:border-box;width:${o.width * MM - 2 * (o.margin || 0) * MM}px`;
  if (o.css) {
    const st = document.createElement('style');
    st.textContent = o.css;
    host.appendChild(st);
  }
  const body = document.createElement('div');
  if (typeof input === 'string') body.innerHTML = input;
  else body.appendChild(input.cloneNode(true));
  host.appendChild(body);
  document.body.appendChild(host);
  try {
    void host.offsetHeight;
    await discoverFonts(host); // @font-face rules inside the input's inline <style>
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const doc = new PdfDoc();
    await render(host, doc, o);
    return await doc.build();
  } finally {
    host.remove();
  }
}

// ---- helpers ----
export function pdfBlobUrl(pdf) {
  return URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' }));
}

export function openPdf(pdf) {
  const url = pdfBlobUrl(pdf);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

export function downloadPdf(pdf, name = 'document.pdf') {
  const url = pdfBlobUrl(pdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Prints through a hidden iframe (browser PDF viewer print dialog); falls back to opening the PDF in a tab.
export function printPdf(pdf) {
  const url = pdfBlobUrl(pdf);
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
      setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 120000);
    };
    let loaded = false;
    frame.onload = () => {
      loaded = true;
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (err) {
          window.open(url, '_blank');
        }
        finish();
      }, 400);
    };
    frame.src = url;
    document.body.appendChild(frame);
    setTimeout(() => {
      if (!loaded && !done) {
        window.open(url, '_blank');
        finish();
      }
    }, 5000);
  });
}
