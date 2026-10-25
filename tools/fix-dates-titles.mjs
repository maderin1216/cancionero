// Corrección única de datos en la base (versión 2.16):
//  - fecha de agregado de las canciones importadas de Word = fecha del archivo .docx
//  - títulos en mayúsculas (se sube la versión de la canción para que los dispositivos la vuelvan a bajar)
//
//   node tools/fix-dates-titles.mjs <carpeta-docx> <salida.sql> [--remote|--local]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { slugify } from '../app/js/util.js';
import { upperTitle } from '../app/js/song.js';

const [dir, out, where = '--remote'] = process.argv.slice(2);
const wrangler = path.resolve('node_modules/.bin/' + (process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'));
const query = sql => {
  // con shell (necesario en Windows para el .cmd) la consulta va entre comillas
  const args = ['d1', 'execute', 'cancionero', '--config', 'server/wrangler.toml', where, '--json', '--command', process.platform === 'win32' ? `"${sql}"` : sql];
  if (where === '--local') args.push('--persist-to', 'server/.wrangler/state');
  const raw = execFileSync(wrangler, args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64e6 });
  return JSON.parse(raw.slice(raw.indexOf('[')))[0].results;
};
const q = s => `'${String(s).replace(/'/g, "''")}'`;

// fecha de cada .docx, con el mismo nombre de archivo -> slug que usó la importación
const used = new Set(), dates = new Map();
for (const f of fs.readdirSync(dir).filter(f => /\.doc[xm]$/i.test(f) && !f.startsWith('~$'))) {
  const base = slugify(f.replace(/\.doc[xm]$/i, '').trim());
  let s = base, n = 2;
  while (used.has(s)) s = `${base}-${n++}`;
  used.add(s);
  dates.set(s, Math.round(fs.statSync(path.join(dir, f)).mtimeMs));
}

const rows = query('SELECT slug, created_at, text FROM songs WHERE deleted = 0');
// la importación cargó todas con la misma fecha: la más repetida
const freq = new Map();
for (const r of rows) freq.set(r.created_at, (freq.get(r.created_at) || 0) + 1);
const importTs = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];

const sql = [];
let nDates = 0, nTitles = 0;
const now = Date.now();
for (const r of rows) {
  if (r.created_at === importTs && dates.has(r.slug)) {
    sql.push(`UPDATE songs SET created_at = ${dates.get(r.slug)} WHERE slug = ${q(r.slug)};`);
    nDates++;
  }
  const fixed = r.text.replace(/^(\s*\{\s*(?:title|t)\s*:\s*)(.*?)(\s*\}\s*)$/mi, (_, a, t, b) => a + upperTitle(t) + b);
  if (fixed !== r.text) {
    sql.push(`UPDATE songs SET text = ${q(fixed)}, rev = rev + 1, updated_at = ${now} WHERE slug = ${q(r.slug)};`);
    nTitles++;
  }
}
fs.writeFileSync(out, sql.join('\n') + '\n');
console.log(`importación del ${new Date(importTs).toLocaleDateString('es-AR')}: ${nDates} fechas desde los Word · ${nTitles} títulos a mayúsculas -> ${out}`);
