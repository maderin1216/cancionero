// Acceso a la carpeta de canciones en disco, restringido a esa carpeta.
import fs from 'node:fs/promises';
import path from 'node:path';

export function makeFsApi(getRoot) {
  const resolve = rel => {
    const root = getRoot();
    if (!root) throw new Error('No hay carpeta de canciones elegida');
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Ruta inválida');
    if (!/^(canciones\/[^/]+\.cho|listas\/[^/]+\.json)$/i.test(rel.replace(/\\/g, '/'))) throw new Error('Ruta no permitida');
    return full;
  };
  return {
    async list() {
      const root = getRoot();
      const out = [];
      for (const dir of ['canciones', 'listas']) {
        let names = [];
        try { names = await fs.readdir(path.join(root, dir)); } catch { continue; }
        for (const n of names) {
          if (!/\.(cho|json)$/i.test(n) || n.includes('conflicted copy') || n.includes('copia en conflicto')) continue;
          const st = await fs.stat(path.join(root, dir, n));
          if (st.isFile()) out.push({ path: `${dir}/${n}`, rev: `${st.mtimeMs}-${st.size}` });
        }
      }
      return out;
    },
    async read(rel) { return fs.readFile(resolve(rel), 'utf8'); },
    async write(rel, text) {
      const full = resolve(rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, text, 'utf8');
      const st = await fs.stat(full);
      return { rev: `${st.mtimeMs}-${st.size}` };
    },
    async remove(rel) { await fs.rm(resolve(rel), { force: true }); return {}; },
  };
}
