// Bundles the ES modules into single-file builds in dist/ (ESM + IIFE, minified and readable, with sourcemaps).
// Optional flags:
//   --watch  rebuild when src/ or site/ change
//   --serve  serve dist/ at http://localhost:3000 (used by `pnpm dev`)
import { build } from 'esbuild';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
);
const banner = { js: '/*! htmlpdf v' + pkg.version + ' | MIT */' };
const base = {
  entryPoints: ['src/index.js'],
  bundle: true,
  banner,
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'warning'
};

const jobs = [
  { format: 'esm', outfile: 'dist/htmlpdf.esm.js', minify: false },
  { format: 'esm', outfile: 'dist/htmlpdf.esm.min.js', minify: true },
  {
    format: 'iife',
    globalName: 'htmlpdf',
    outfile: 'dist/htmlpdf.js',
    minify: false
  },
  {
    format: 'iife',
    globalName: 'htmlpdf',
    outfile: 'dist/htmlpdf.min.js',
    minify: true
  }
];

async function doBuild() {
  rmSync('dist', { recursive: true, force: true });
  mkdirSync('dist', { recursive: true });
  for (const j of jobs) {
    await build({ ...base, ...j, sourcemap: j.minify });
    const buf = readFileSync(j.outfile);
    console.log(
      j.outfile.padEnd(30),
      String(statSync(j.outfile).size).padStart(8),
      'B',
      String(gzipSync(buf).length).padStart(8),
      'B gz'
    );
  }
  cpSync('site', 'dist', { recursive: true });
  console.log('built dist/');
}

const args = process.argv.slice(2);
const watchMode = args.includes('--watch');
const serveMode = args.includes('--serve');

await doBuild();

if (watchMode) {
  let busy = false;
  let queued = false;
  const rebuild = async () => {
    if (busy) {
      queued = true;
      return;
    }
    busy = true;
    try {
      await doBuild();
    } finally {
      busy = false;
      if (queued) {
        queued = false;
        rebuild();
      }
    }
  };
  watch('src', { recursive: true }, () => rebuild());
  watch('site', { recursive: true }, () => rebuild());
  console.log('watching src/ and site/ for changes...');
}

if (serveMode) {
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.map': 'application/json',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon'
  };
  const root = resolve('dist');
  const server = createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(
        new URL(req.url, 'http://localhost').pathname
      );
      if (pathname === '/') pathname = '/index.html';
      const file = resolve(root, '.' + pathname);
      if (file !== root && !file.startsWith(root + sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        'content-type': mime[extname(file)] || 'application/octet-stream'
      });
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(3000, () =>
    console.log('serving dist/ at http://localhost:3000')
  );
}
