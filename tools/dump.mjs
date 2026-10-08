// Vuelca el texto plano de varios .docx para inspección.
import fs from 'node:fs';
import path from 'node:path';
import { readDocx } from './docx-read.mjs';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => /\.docx$/i.test(f));
const pick = process.argv[3] ? files.filter(f => f.toUpperCase().includes(process.argv[3].toUpperCase())) : files;
for (const f of pick.slice(0, +(process.argv[4] || 5))) {
  const paras = await readDocx(path.join(dir, f));
  console.log('=====', f);
  for (const p of paras) console.log((p.runs.some(r => r.bold) ? 'B|' : ' |') + p.runs.map(r => r.text).join(''));
}
