// Piezas de interfaz reutilizables: avisos y diálogos.
import { el, esc } from './util.js';

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Abre un diálogo. `build(dialogEl, close)` arma el contenido. Devuelve una promesa con el valor de close(v). */
export function openDialog(build) {
  return new Promise(resolve => {
    const ov = el('<div class="overlay"><div class="dialog"></div></div>');
    const dlg = ov.firstElementChild;
    const close = v => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') close(undefined); };
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(undefined); });
    document.addEventListener('keydown', onKey);
    document.body.append(ov);
    build(dlg, close);
    dlg.querySelector('[autofocus]')?.focus();
  });
}

export function confirmDialog(msg, okLabel = 'Aceptar', danger = false) {
  return openDialog((d, close) => {
    d.innerHTML = `<p style="margin-top:0">${esc(msg)}</p>
      <div class="actions"><button class="btn" data-x>Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(okLabel)}</button></div>`;
    d.querySelector('[data-x]').onclick = () => close(false);
    d.querySelector('[data-ok]').onclick = () => close(true);
  });
}

/** Formulario simple: fields = [{name, label, value, type, placeholder}] */
export function formDialog(title, fields, okLabel = 'Guardar') {
  return openDialog((d, close) => {
    d.innerHTML = `<h2>${esc(title)}</h2><form>
      ${fields.map((f, i) => `<label class="field"><span>${esc(f.label)}</span>
        <input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" ${i === 0 ? 'autofocus' : ''}></label>`).join('')}
      <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">${esc(okLabel)}</button></div></form>`;
    d.querySelector('[data-x]').onclick = () => close(null);
    d.querySelector('form').onsubmit = e => {
      e.preventDefault();
      close(Object.fromEntries(new FormData(e.target)));
    };
  });
}
