/**
 * Builds the single-file report.
 *
 *   node src/build.ts [--csv a.csv --csv b.csv] [--bu NAME] [--keep-names] [--out dist/journey-change-log.html]
 *
 *   template.html ─┬─ core.ts (types stripped, exports removed) ──► <script>
 *                  ├─ fonts/*.woff2 (base64 @font-face) ─────────────► <style>
 *                  ├─ fixtures/sample.csv (synthetic) ──────────────► #sample
 *                  └─ --csv files → build() anonymized by default ──► #dataset
 *   then: CSP meta with sha256 of every inline <script>/<style>; SHA-256 of the file.
 *
 * Without --csv the page opens on the drop screen. With --csv the data is anonymized
 * before embedding unless --keep-names is passed (internal use only).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './core.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const out = values('--out')[0] ?? join(root, 'dist', 'journey-change-log.html');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;

// core: strip types, drop `export` so it runs inside the app's IIFE
const core = stripTypeScriptTypes(readFileSync(join(here, 'core.ts'), 'utf8'), { mode: 'strip' })
  .replace(/^export (?=(?:const|function|let|class) )/gm, '');

// fonts
const font = (file: string, range: string) =>
  `@font-face{font-family:"Onest";font-style:normal;font-weight:400 700;font-display:swap;` +
  `src:url(data:font/woff2;base64,${readFileSync(join(here, 'fonts', file)).toString('base64')}) format("woff2");unicode-range:${range}}`;
const fonts = [
  font('onest-cyrillic.woff2', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'),
  font('onest-latin.woff2', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'),
].join('\n');

// data
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');
const csvs = values('--csv');
let dataset: unknown = null;
if (csvs.length) {
  const bu = values('--bu')[0];
  const r = build(csvs.map(f => ({ name: basename(f), text: readFileSync(f, 'utf8'), bu })), { keepNames: flag('--keep-names') });
  if (!r.ok) { console.error('build error:', r.error); process.exit(1); }
  dataset = r.data;
}
const sample = readFileSync(join(here, 'fixtures', 'sample.csv'), 'utf8');

let html = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('/*__FONTS__*/', () => fonts)
  .replace('/*__CORE__*/', () => core)
  .replace('__DATA__', () => json(dataset))
  .replace('__SAMPLE__', () => json(sample))
  .replace('<title>Journey Change Log</title>', `<title>Journey Change Log</title>\n<meta name="generator" content="journey-change-log ${version}">`);

// CSP: hash every executable inline script and every inline style
const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => sha(m[1]));
const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => sha(m[1]));
const csp = `default-src 'none'; script-src ${scripts.join(' ')}; style-src ${styles.join(' ')}; font-src data:; img-src data:; base-uri 'none'; form-action 'none'`;
html = html.replace('<!--__CSP__-->', `<meta http-equiv="Content-Security-Policy" content="${csp}">`);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
const digest = createHash('sha256').update(html).digest('hex');
writeFileSync(out + '.sha256', `${digest}  ${basename(out)}\n`);
console.log(`${out}  v${version}  ${(html.length / 1024).toFixed(0)} KB  sha256 ${digest}${dataset ? `  (embedded: ${flag('--keep-names') ? 'WITH NAMES' : 'anonymized'})` : '  (drop mode)'}`);
