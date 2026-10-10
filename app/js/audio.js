// Audio de cada canción (hasta 30 segundos): grabar, elegir un archivo o capturar lo que suena en la
// PC; después se recorta el fragmento y se guarda como WAV mono liviano.
import { esc } from './util.js';
import { openDialog, toast } from './ui.js';

export const MAX_SECONDS = 30;
const MAX_RECORD = 90;      // lo que se puede grabar antes de recortar
const RATE = 22050;         // calidad suficiente para escuchar la canción de referencia

export const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Decodifica audio o video (mp3, m4a, ogg, webm, wav, mp4…) a un AudioBuffer. */
async function decode(blob) {
  const ctx = new AudioContext();
  try { return await ctx.decodeAudioData(await blob.arrayBuffer()); }
  finally { ctx.close(); }
}

/** Recorta [start, start+len] a mono 22 kHz, con fundido corto en los bordes, y lo pasa a WAV. */
async function encodeWav(buffer, start, len) {
  const frames = Math.ceil(len * RATE);
  const ctx = new OfflineAudioContext(1, frames, RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  const fade = Math.min(0.03, len / 4);
  gain.gain.setValueAtTime(0, 0);
  gain.gain.linearRampToValueAtTime(1, fade);
  gain.gain.setValueAtTime(1, len - fade);
  gain.gain.linearRampToValueAtTime(0, len);
  src.connect(gain).connect(ctx.destination);
  src.start(0, start, len);
  const out = (await ctx.startRendering()).getChannelData(0);
  const view = new DataView(new ArrayBuffer(44 + frames * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i])) * 0x7fff, true);
  return new Blob([view], { type: 'audio/wav' });
}

/** Graba un stream de audio con MediaRecorder. Devuelve {stop, done: Promise<Blob>}. */
function record(stream) {
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported?.(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise(res => { rec.onstop = () => { stream.getTracks().forEach(t => t.stop()); res(new Blob(chunks, { type: rec.mimeType })); }; });
  rec.start(250);
  return { stop: () => { if (rec.state !== 'inactive') rec.stop(); }, done };
}

/** Sonido de la PC (sólo en la app de escritorio, que provee el audio del sistema). */
async function systemAudioStream() {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  s.getVideoTracks().forEach(t => { t.stop(); s.removeTrack(t); });
  if (!s.getAudioTracks().length) throw new Error('No se pudo capturar el sonido de la PC');
  return s;
}

const micStream = () => navigator.mediaDevices.getUserMedia({
  // para música conviene sin los filtros pensados para la voz en llamadas
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
});

function drawWave(canvas, buffer, sel) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  const css = getComputedStyle(canvas);
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const x0 = sel.start / buffer.duration * w, x1 = (sel.start + sel.len) / buffer.duration * w;
  g.fillStyle = css.getPropertyValue('--hl-drop') || '#b9d0ff';
  g.fillRect(x0, 0, x1 - x0, h);
  for (let x = 0; x < w; x++) {
    let mx = 0;
    for (let i = x * step, e = Math.min(data.length, i + step); i < e; i++) mx = Math.max(mx, Math.abs(data[i]));
    g.fillStyle = x >= x0 && x <= x1 ? css.color : css.getPropertyValue('--muted');
    const bh = Math.max(1, mx * h * 0.95);
    g.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

/**
 * Diálogo para cargar el audio de una canción.
 * save(blob, duration) guarda; remove() borra el actual; current() devuelve el blob actual o null.
 */
export function audioDialog({ title, hasAudio, desktop, save, remove, current }) {
  return openDialog((d, close) => {
    let rec = null, timer = null, buffer = null, sel = { start: 0, len: 10 }, playing = null, pill = null;
    const stopPlay = () => { try { playing?.stop(); } catch { /* ya terminó */ } playing = null; };
    const cleanup = () => { clearInterval(timer); rec?.stop(); rec = null; stopPlay(); pill?.remove(); pill = null; };

    const chooseView = () => {
      cleanup();
      d.innerHTML = `<h2>Audio de "${esc(title)}"</h2>
        <p class="hint" style="margin-top:0">Hasta ${MAX_SECONDS} segundos. Primero cargás el audio y después elegís el fragmento.</p>
        <div class="audio-src">
          <button class="btn" data-src="mic">🎙 Grabar con el micrófono</button>
          <label class="btn">📎 Elegir archivo (audio o video)<input type="file" accept="audio/*,video/*" hidden></label>
          ${desktop ? '<button class="btn" data-src="system">🔊 Grabar lo que suena en la PC</button>' : ''}
        </div>
        <p class="hint">${desktop
          ? 'Para Spotify, YouTube o Instagram: poné play, tocá "Grabar lo que suena en la PC" y detené cuando pase el fragmento.'
          : 'Para un video de Instagram: grabalo con el grabador de pantalla del celular (con sonido) y elegí ese video.'}</p>
        <div class="actions">
          ${hasAudio ? '<button class="btn danger" data-del>Borrar el audio actual</button>' : ''}
          <button class="btn" data-x>Cerrar</button></div>`;
      d.querySelector('input[type=file]').onchange = async e => {
        const f = e.target.files[0];
        if (f) loadBlob(f);
      };
    };

    const recordView = async kind => {
      let stream;
      try { stream = kind === 'mic' ? await micStream() : await systemAudioStream(); }
      catch (err) { toast(kind === 'mic' ? 'No se pudo usar el micrófono (revisá el permiso)' : err.message, 4000); return; }
      rec = record(stream);
      const t0 = Date.now();
      // mientras se graba, la ventana se oculta para poder leer la canción; queda un indicador en una esquina
      const overlay = d.closest('.overlay');
      overlay.hidden = true;
      pill = document.createElement('div');
      pill.className = 'rec-pill';
      pill.setAttribute('role', 'status');
      pill.innerHTML = `<span class="rec-dot"></span><b data-t>0:00</b>
        <button class="btn small primary" data-stop>Detener</button><button class="btn small" data-cancel title="Cancelar la grabación" aria-label="Cancelar la grabación">✕</button>`;
      document.body.append(pill);
      const back = () => { pill?.remove(); pill = null; overlay.hidden = false; };
      const stopNow = async () => {
        clearInterval(timer);
        const r = rec; rec = null;
        back();
        r.stop();
        loadBlob(await r.done);
      };
      timer = setInterval(() => {
        if (!d.isConnected) { cleanup(); return; } // se cerró la ventana (por ejemplo con Escape)
        const s = (Date.now() - t0) / 1000;
        pill.querySelector('[data-t]').textContent = fmtTime(s);
        if (s >= MAX_RECORD) stopNow();
      }, 250);
      pill.querySelector('[data-stop]').onclick = stopNow;
      pill.querySelector('[data-cancel]').onclick = () => { clearInterval(timer); rec.stop(); rec = null; back(); chooseView(); };
    };

    const loadBlob = async blob => {
      d.innerHTML = '<h2>Preparando el audio…</h2>';
      try { buffer = await decode(blob); }
      catch { toast('No se pudo leer ese archivo. Probá con otro formato (mp3, m4a, mp4, ogg, wav).', 5000); chooseView(); return; }
      sel = { start: 0, len: Math.min(10, buffer.duration) };
      trimView();
    };

    const trimView = () => {
      const maxLen = Math.min(MAX_SECONDS, buffer.duration);
      d.innerHTML = `<h2>Elegí el fragmento</h2>
        <p class="hint" style="margin-top:0">Tocá la onda donde querés que empiece. Total: ${fmtTime(buffer.duration)}.</p>
        <canvas class="wave"></canvas>
        <div class="row" style="justify-content:space-between"><span class="hint" data-range></span><button class="btn small" data-play>▶ Escuchar</button></div>
        <label class="field"><span>Duración: <b data-len></b></span><input type="range" min="1" max="${Math.max(1, Math.floor(maxLen))}" step="1" value="${Math.round(sel.len)}" data-lenin></label>
        <div class="actions"><button class="btn" data-back>Volver</button><button class="btn primary" data-save>Guardar</button></div>`;
      const canvas = d.querySelector('canvas');
      const upd = () => {
        sel.start = Math.max(0, Math.min(sel.start, buffer.duration - sel.len));
        drawWave(canvas, buffer, sel);
        d.querySelector('[data-range]').textContent = `${fmtTime(sel.start)} – ${fmtTime(sel.start + sel.len)}`;
        d.querySelector('[data-len]').textContent = `${Math.round(sel.len)} s`;
      };
      const pick = e => {
        const r = canvas.getBoundingClientRect();
        sel.start = Math.max(0, (e.clientX - r.left) / r.width * buffer.duration);
        stopPlay();
        upd();
      };
      let down = false;
      canvas.addEventListener('pointerdown', e => { down = true; canvas.setPointerCapture(e.pointerId); pick(e); });
      canvas.addEventListener('pointermove', e => { if (down) pick(e); });
      canvas.addEventListener('pointerup', () => { down = false; });
      d.querySelector('[data-lenin]').oninput = e => { sel.len = Math.min(+e.target.value, buffer.duration); stopPlay(); upd(); };
      d.querySelector('[data-play]').onclick = e => {
        if (playing) { stopPlay(); e.target.textContent = '▶ Escuchar'; return; }
        const ctx = new AudioContext();
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = () => { ctx.close(); if (playing === src) { playing = null; e.target.textContent = '▶ Escuchar'; } };
        src.start(0, sel.start, sel.len);
        playing = src;
        e.target.textContent = '■ Detener';
      };
      d.querySelector('[data-back]').onclick = chooseView;
      d.querySelector('[data-save]').onclick = async e => {
        e.target.disabled = true;
        stopPlay();
        try {
          const blob = await encodeWav(buffer, sel.start, sel.len);
          await save(blob, sel.len);
          close(true);
        } catch (err) { toast('No se pudo guardar el audio: ' + err.message, 5000); e.target.disabled = false; }
      };
      requestAnimationFrame(upd);
    };

    d.addEventListener('click', async e => {
      if (e.target.closest('[data-x]')) { cleanup(); close(false); }
      const src = e.target.closest('[data-src]');
      if (src) recordView(src.dataset.src);
      if (e.target.closest('[data-del]')) {
        try { await remove(); toast('Audio borrado'); cleanup(); close(true); } catch (err) { toast(err.message); }
      }
    });
    chooseView();
  });
}

// ---------------------------------------------------------------- reproductor (uno solo para toda la app)

let player = null, playerUrl = null, playerSlug = null;

/** Reproduce o detiene el audio de una canción. onState(estado, segundos) informa el avance. */
export async function togglePlay(slug, getBlob, onState) {
  if (player && playerSlug === slug && !player.paused) { player.pause(); onState('paused', player.currentTime); return; }
  if (!player || playerSlug !== slug) {
    stopPlayer();
    onState('loading', 0);
    let blob;
    try { blob = await getBlob(); }
    catch (err) { onState('error', 0); toast(err.message || 'No se pudo cargar el audio'); return; }
    playerUrl = URL.createObjectURL(blob);
    player = new Audio(playerUrl);
    playerSlug = slug;
  }
  player.ontimeupdate = () => { if (!player.paused) onState('playing', player.currentTime); };
  player.onended = () => { onState('ended', 0); player.currentTime = 0; };
  try { await player.play(); onState('playing', player.currentTime); } catch { onState('error', 0); }
}

export function stopPlayer() {
  if (player) { player.pause(); player.ontimeupdate = player.onended = null; }
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  player = playerUrl = playerSlug = null;
}
