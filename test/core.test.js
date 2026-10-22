import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PdfDoc } from '../src/writer.js';
import { registerFont, hasFonts } from '../src/fonts.js';

const latin1 = (u8) => Buffer.from(u8).toString('latin1');

test('PdfDoc builds a structurally valid PDF', async () => {
  const doc = new PdfDoc();
  const page = doc.addPage(794, 1123);
  page.fill([1, 0, 0]);
  page.rect(10, 10, 100, 50);
  page.paint('f');
  doc.addPage(300, 400);
  const s = latin1(await doc.build());
  assert.ok(s.startsWith('%PDF-1.5'));
  assert.ok(s.trimEnd().endsWith('%%EOF'));
  assert.match(s, /\/Count 2/);
  const at = Number(/startxref\n(\d+)/.exec(s)[1]);
  const lines = s.slice(at).split('\n');
  assert.equal(lines[0], 'xref');
  const count = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < count; i++) {
    const off = parseInt(lines[2 + i], 10);
    assert.ok(s.slice(off).startsWith(i + ' 0 obj'), 'xref entry ' + i + ' points at its object');
  }
});

test('shadings and images with alpha are written', async () => {
  const doc = new PdfDoc();
  const page = doc.addPage(200, 200);
  const sh = doc.addShading({ coords: [0, 0, 100, 0], stops: [{ o: 0, c: [1, 0, 0] }, { o: 1, c: [0, 0, 1] }] });
  page.shading(sh);
  const img = doc.addImage({ w: 2, h: 2, rgb: new Uint8Array(12), alpha: new Uint8Array(4) });
  page.image(img, 0, 0, 10, 10);
  const s = latin1(await doc.build());
  assert.match(s, /\/ShadingType 2/);
  assert.match(s, /\/SMask \d+ 0 R/);
});

test('registerFont rejects unusable font data', () => {
  assert.throws(() => registerFont({ family: 'x', data: new ArrayBuffer(4) }), /invalid font data/);
  const otf = new ArrayBuffer(64);
  new DataView(otf).setUint32(0, 0x4f54544f);
  assert.throws(() => registerFont({ family: 'x', data: otf }), /\.otf/);
  const ttc = new ArrayBuffer(64);
  new DataView(ttc).setUint32(0, 0x74746366);
  assert.throws(() => registerFont({ family: 'x', data: ttc }), /\.ttc/);
  assert.equal(hasFonts(), false);
});
