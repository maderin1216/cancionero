// Escanea todos los .docx y lista tokens de líneas "casi de acordes" que no reconoce el regex.
import fs from 'node:fs';
import path from 'node:path';
import { readDocx } from './docx-read.mjs';
import { isChordToken } from '../app/js/chords.js';

const dir = process.argv[2];
const unknown = new Map();
const files = fs.readdirSync(dir).filter(f => /\.doc[xm]$/i.test(f));
for (const f of files) {
  let paras; try { paras = await readDocx(path.join(dir, f)); } catch (e) { console.log("NO SE PUDO LEER", f); continue; }
  for (const p of paras) {
    for (const line of p.runs.map(r => r.text).join('').split('\n')) {
      const toks = line.trim().split(/\s+/).filter(Boolean);
      if (!toks.length) continue;
      const ok = toks.filter(isChordToken).length;
      if (ok / toks.length >= 0.4 && ok < toks.length) {
        for (const t of toks) if (!isChordToken(t)) {
          const e = unknown.get(t) || { n: 0, ex: `${f}: ${line.trim()}` };
          e.n++; unknown.set(t, e);
        }
      }
    }
  }
}
for (const [t, e] of [...unknown].sort((a, b) => b[1].n - a[1].n)) console.log(e.n, JSON.stringify(t), '  ', e.ex.slice(0, 140));
