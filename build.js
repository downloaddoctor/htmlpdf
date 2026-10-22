// Bundles the ES modules into single-file builds in dist/ (ESM + IIFE, minified and readable, with sourcemaps).
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const banner = { js: '/*! htmlpdf v' + pkg.version + ' | MIT */' };
const base = { entryPoints: ['src/index.js'], bundle: true, banner, target: 'es2020', legalComments: 'none', logLevel: 'warning' };

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

const jobs = [
  { format: 'esm', outfile: 'dist/htmlpdf.esm.js', minify: false },
  { format: 'esm', outfile: 'dist/htmlpdf.esm.min.js', minify: true },
  { format: 'iife', globalName: 'htmlpdf', outfile: 'dist/htmlpdf.js', minify: false },
  { format: 'iife', globalName: 'htmlpdf', outfile: 'dist/htmlpdf.min.js', minify: true },
];

for (const j of jobs) {
  await build({ ...base, ...j, sourcemap: j.minify });
  const buf = readFileSync(j.outfile);
  console.log(j.outfile.padEnd(30), String(statSync(j.outfile).size).padStart(8), 'B', String(gzipSync(buf).length).padStart(8), 'B gz');
}

// dist/ is the Pages site root: bundles plus the static pages from site/.
cpSync('site', 'dist', { recursive: true });
