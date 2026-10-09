// Genera un archivo SQL para pasar las canciones (y opcionalmente las listas) de la carpeta de
// Dropbox a la base D1. Las listas quedan a nombre del usuario 1 (el administrador).
//
//   node tools/migrate-to-d1.mjs <carpeta> <salida.sql> [--songs] [--lists]
//   npx wrangler d1 execute cancionero --config server/wrangler.toml --file <salida.sql> [--local|--remote]
import fs from 'node:fs';
import path from 'node:path';

const [dir, out, ...flags] = process.argv.slice(2);
const doSongs = flags.includes('--songs'), doLists = flags.includes('--lists');
const q = s => s === null || s === undefined ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`;
const now = Date.now();
const sql = [];

if (doSongs) {
  for (const f of fs.readdirSync(path.join(dir, 'canciones')).filter(f => f.endsWith('.cho')).sort()) {
    const text = fs.readFileSync(path.join(dir, 'canciones', f), 'utf8');
    const slug = f.replace(/\.cho$/, '');
    sql.push(`INSERT INTO songs (slug, text, rev, updated_at) VALUES (${q(slug)}, ${q(text)}, 1, ${now}) ON CONFLICT (slug) DO NOTHING;`);
  }
}

if (doLists) {
  let n = 0;
  for (const f of fs.existsSync(path.join(dir, 'listas')) ? fs.readdirSync(path.join(dir, 'listas')).filter(f => f.endsWith('.json')) : []) {
    const l = JSON.parse(fs.readFileSync(path.join(dir, 'listas', f), 'utf8'));
    const semis = {};
    const items = (l.items || []).map((it, i) => {
      const id = `m${i}${Math.random().toString(36).slice(2, 7)}`;
      if (it.semis) semis[id] = it.semis;
      return { id, song: String(it.song).replace(/^canciones\//, '').replace(/\.cho$/, ''), ...(it.label ? { label: it.label } : {}) };
    });
    sql.push(`INSERT INTO lists (owner_id, name, date, items, updated_at) VALUES (1, ${q(l.name)}, ${q(l.date || null)}, ${q(JSON.stringify(items))}, ${now});`);
    if (Object.keys(semis).length) sql.push(`INSERT INTO list_semis (list_id, user_id, semis) VALUES (last_insert_rowid(), 1, ${q(JSON.stringify(semis))});`);
    n++;
  }
  console.log(`${n} listas`);
}

fs.writeFileSync(out, sql.join('\n') + '\n');
console.log(`${sql.length} sentencias -> ${out}`);
