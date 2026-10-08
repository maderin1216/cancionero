// Lee un .docx y devuelve sus párrafos como listas de runs {text, bold, size}.
import fs from 'node:fs';
import JSZip from 'jszip';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = s => s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));

export async function readDocx(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const xml = await zip.file('word/document.xml').async('string');
  const body = xml.slice(xml.indexOf('<w:body>'));
  const paras = [];
  for (const pm of body.matchAll(/<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = pm[0];
    const pPrRun = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    const runs = [];
    // tabla: tratar cada celda igual que párrafos; aquí no anidamos
    for (const rm of p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)) {
      const r = rm[0];
      const rPr = (r.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      const bold = /<w:b\/>|<w:b w:val="(1|true|on)"\/>/.test(rPr);
      const sz = +(rPr.match(/<w:sz w:val="(\d+)"/) || [0, 22])[1] / 2;
      let text = '';
      for (const t of r.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
        if (t[0].startsWith('<w:tab')) text += '\t';
        else if (t[0].startsWith('<w:br') || t[0].startsWith('<w:cr')) text += '\n';
        else text += unescape(t[1]);
      }
      if (text) runs.push({ text, bold, size: sz });
    }
    paras.push({ runs, center: /<w:jc w:val="center"\/>/.test(pPrRun) });
  }
  return paras;
}
