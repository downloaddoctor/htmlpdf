# htmlpdf

Write HTML + CSS, get a **vector PDF** (real selectable text, real lines, crisp at any zoom) that matches what the browser shows.
The browser does the layout; the library paints every box, border, gradient, image and text run into the PDF.
Zero dependencies, no build step, plain ES modules. Works in any modern browser.

## Install

Load the single-file minified build straight from GitHub Pages (no npm, no build).

```html
<script src="https://downloaddoctor.github.io/htmlpdf/htmlpdf.min.js"></script>
<script>
  htmlpdf
    .htmlToPdf('<h1>Hello</h1>', {
      fonts: [{ family: 'Inter', url: './Inter-400.ttf' }]
    })
    .then((pdf) => htmlpdf.downloadPdf(pdf, 'hello.pdf'));
</script>
```

```js
import { htmlToPdf } from 'https://downloaddoctor.github.io/htmlpdf/htmlpdf.esm.min.js';
```

Build locally: `pnpm install && pnpm run build` (outputs to `dist/`).

## Live demo

Interactive playground with examples and copy-ready code: https://downloaddoctor.github.io/htmlpdf/

For LLMs and coding agents: https://downloaddoctor.github.io/htmlpdf/llms.txt

## Use from source

1. Copy the `src/` folder anywhere.
2. Use it:

```js
import { htmlToPdf, downloadPdf } from './src/index.js';

const pdf = await htmlToPdf('<h1 style="color:tomato">Hello</h1>', {
  fonts: [{ family: 'Inter', weight: 400, url: './fonts/Inter-400.ttf' }]
});
downloadPdf(pdf, 'hello.pdf'); // or printPdf(pdf) / openPdf(pdf)
```

`fonts` must be the same `.ttf` files your CSS uses (add one entry per weight/style). They are fetched once and cached.
Full Unicode works for any glyph the font contains.

You do not have to pass `fonts` at all: the library discovers `@font-face` rules (from the page and from `opts.css`)
and embeds matching TrueType fonts automatically. When no font file can be fetched (e.g. you used a locally installed
font that the page has no `@font-face` URL for), text still renders using the PDF standard 14 fonts — Helvetica,
Times or Courier, picked from the computed `font-family` — so real PDFs are produced without downloading anything.
Set `noAutoFonts: true` to disable discovery. OTF/CFF and `.ttc` are not supported.

## API

`htmlToPdf(htmlOrNode, opts) -> Promise<Uint8Array>`

| Option            | Default  | Meaning                                                                       |
| ----------------- | -------- | ----------------------------------------------------------------------------- |
| `width`, `height` | 210, 297 | Page size in mm. `height: 0` = one page as tall as the content                |
| `margin`          | 0        | Page margin in mm                                                             |
| `background`      | `'#fff'` | Page colour, `null` for none                                                  |
| `hairline`        | 0        | Width in mm for borders thinner than 1px (browsers snap them to 1px)          |
| `css`             | `''`     | Extra CSS applied to the content                                              |
| `fonts`           | `[]`     | `[{ family, weight, style, url }]`; omit for automatic `@font-face` discovery |
| `noAutoFonts`     | `false`  | Set `true` to skip automatic `@font-face` discovery                           |

Helpers: `downloadPdf(pdf, name)`, `printPdf(pdf)`, `openPdf(pdf)`, `pdfBlobUrl(pdf)`.
Low level: `registerFont({ family, weight, style, data })`, `registerFontUrl(family, url, { weight, style })`.

Pages: content longer than the page flows onto more pages. Use `break-before: page` and `break-inside: avoid`.

## How it reads the layout

The browser lays out a cloned copy of your HTML in a hidden offscreen host; the library never guesses metrics. It reads
`getComputedStyle` for every visual property and `getBoundingClientRect` / `Range.getClientRects` for measured boxes and
text runs — the same numbers the browser uses to paint. The only time a style is touched is measuring an element with a
non-translation `transform` (rotation/scale), where the untransformed box is read by momentarily neutering the transform
on the offscreen clone; pure translations are recovered mathematically without touching style at all.

## Supported CSS

Backgrounds (colour, `url()`, linear/radial/repeating-linear gradients, size, position, repeat, clip, origin),
`border-radius`, per-side borders (solid, dashed, dotted, double), `box-shadow`, `opacity`, 2D `transform`,
`overflow` clipping, `<img>` (`object-fit`), inline `<svg>`, `<canvas>`, text (weight, size, colour, `letter-spacing`,
`text-transform`, underline/line-through, `text-shadow`, `-webkit-text-stroke`, `paint-order`), `z-index` order.

Not supported: filters, blend modes. (`::before`/`::after` — including their CSS inline styles and `attr()` content — and list markers are now rendered.)

Cross-origin images need CORS headers, otherwise they are skipped with a console warning.

## Files

- `src/index.js` public API and helpers
- `src/paint.js` CSS painter (DOM walk)
- `src/writer.js` PDF object writer
- `src/fonts.js` TrueType embedding
- `site/index.html` interactive playground with examples and copy-ready code (copied into dist/, the GitHub Pages root; locally run `pnpm run build`, then `npx serve dist`)
- `site/llms.txt` LLM-oriented summary of the API and rules (served at the site root)
- `build.js` esbuild bundler, output in `dist/`
