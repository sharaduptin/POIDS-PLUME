const { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } = PDFLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ------------------------------------------------------------------ outils */

const $ = (s) => document.querySelector(s);
const nextTick = () => new Promise((r) => setTimeout(r, 0));

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' o';
  const ko = bytes / 1024;
  if (ko < 1000) return ko.toFixed(ko < 10 ? 1 : 0).replace('.', ',') + ' Ko';
  return (ko / 1024).toFixed(1).replace('.', ',') + ' Mo';
}

let toastTimer;
function toast(msg, chemin) {
  const t = $('#toast');
  const action = $('#toastAction');
  $('#toastText').textContent = msg;
  action.hidden = !chemin;
  action.onclick = chemin ? () => window.plume.montrer(chemin) : null;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), chemin ? 8000 : 4200);
}

// Déréférence un objet indirect (et les chaînes de références)
function deref(ctx, obj) {
  let o = obj, n = 0;
  while (o instanceof PDFRef && n++ < 8) o = ctx.lookup(o);
  return o;
}

const nameOf = (o) =>
  o && typeof o.asString === 'function' && o.asString()[0] === '/' ? o.asString().slice(1) : null;

// Le filtre d'un flux peut être un nom seul ou un tableau de noms
function filtersOf(ctx, dict) {
  const f = deref(ctx, dict.get(PDFName.of('Filter')));
  if (!f) return [];
  if (typeof f.asArray === 'function') {
    return f.asArray().map((x) => nameOf(deref(ctx, x))).filter(Boolean);
  }
  const n = nameOf(f);
  return n ? [n] : [];
}

// Nombre de composantes d'un espace de couleur (null = non géré)
function colorComponents(ctx, cs) {
  const o = deref(ctx, cs);
  const n = nameOf(o);
  if (n === 'DeviceGray' || n === 'CalGray' || n === 'G') return 1;
  if (n === 'DeviceRGB' || n === 'CalRGB' || n === 'RGB') return 3;
  if (n === 'DeviceCMYK' || n === 'CMYK') return 4;
  if (o && typeof o.asArray === 'function') {
    const arr = o.asArray();
    const head = nameOf(deref(ctx, arr[0]));
    if (head === 'ICCBased') {
      const s = deref(ctx, arr[1]);
      const N = s && s.dict && deref(ctx, s.dict.get(PDFName.of('N')));
      return N && typeof N.asNumber === 'function' ? N.asNumber() : null;
    }
    if (head === 'CalGray') return 1;
    if (head === 'CalRGB' || head === 'Lab') return 3;
  }
  return null; // Indexed, Separation, DeviceN… : on ne touche pas
}

// Composantes déclarées dans l'en-tête d'un JPEG (4 = CMYK, à éviter)
function jpegComponents(b) {
  let i = 2;
  while (i < b.length - 9) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xda) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b[i + 9];
    i += 2 + len;
  }
  return 3;
}

/* ------------------------------------------------- ré-encodage d'une image */

async function toJpeg(source, w, h, scale, quality, gray) {
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cw, ch); // le JPEG n'a pas de transparence : fond blanc
  if (gray) c.filter = 'grayscale(1)';

  if (source instanceof ImageData) {
    // putImageData ignore les filtres : on passe par un canvas intermédiaire
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d').putImageData(source, 0, 0);
    c.drawImage(tmp, 0, 0, cw, ch);
    tmp.width = tmp.height = 0;
  } else {
    c.drawImage(source, 0, 0, cw, ch);
  }

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  canvas.width = canvas.height = 0;
  if (!blob) return null;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: cw, height: ch };
}

function rawToImageData(raw, w, h, comps) {
  if (raw.length < w * h * comps) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += comps, q += 4) {
    if (comps === 1) {
      out[q] = out[q + 1] = out[q + 2] = raw[p];
    } else {
      out[q] = raw[p]; out[q + 1] = raw[p + 1]; out[q + 2] = raw[p + 2];
    }
    out[q + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/* --------------------------------------------------- moteur 1 : les images */

async function compressImages(doc, opts, report) {
  const ctx = doc.context;
  const entries = ctx.enumerateIndirectObjects();

  // Les masques de transparence doivent rester en gris non-JPEG : on les repère
  const masks = new Set();
  for (const [, obj] of entries) {
    const dict = obj && obj.dict;
    if (!dict || typeof dict.get !== 'function') continue;
    for (const key of ['SMask', 'Mask']) {
      const v = dict.get(PDFName.of(key));
      if (v instanceof PDFRef) masks.add(v.toString());
    }
  }

  const images = entries.filter(([ref, obj]) =>
    obj instanceof PDFRawStream &&
    nameOf(obj.dict.get(PDFName.of('Subtype'))) === 'Image' &&
    !masks.has(ref.toString()));

  let done = 0, changed = 0, saved = 0;

  for (const [ref, stream] of images) {
    report(done / Math.max(1, images.length));
    done++;
    try {
      const dict = stream.dict;
      const num = (k) => {
        const v = deref(ctx, dict.get(PDFName.of(k)));
        return v && typeof v.asNumber === 'function' ? v.asNumber() : null;
      };
      const w = num('Width'), h = num('Height');
      if (!w || !h || w * h < 8000) continue;            // vignettes : gain nul
      if (dict.get(PDFName.of('ImageMask'))) continue;   // masque binaire
      if (dict.get(PDFName.of('Mask'))) continue;        // masque par couleur-clé
      if (dict.get(PDFName.of('Decode'))) continue;      // inversion de couleurs

      const filters = filtersOf(ctx, dict);
      const bpc = num('BitsPerComponent');
      const scale = Math.min(1, opts.maxSide / Math.max(w, h));
      let source = null;

      if (filters.length === 1 && filters[0] === 'DCTDecode') {
        const jpg = stream.contents;
        if (jpegComponents(jpg) === 4) continue;         // CMYK : rendu canvas non fiable
        source = await createImageBitmap(new Blob([jpg], { type: 'image/jpeg' }));
      } else if (filters.length && filters.every((f) =>
                 f === 'FlateDecode' || f === 'LZWDecode' || f === 'RunLengthDecode')) {
        if (bpc !== 8) continue;
        const comps = colorComponents(ctx, dict.get(PDFName.of('ColorSpace')));
        if (comps !== 1 && comps !== 3) continue;
        source = rawToImageData(decodePDFRawStream(stream).decode(), w, h, comps);
        if (!source) continue;
      } else {
        continue; // JPX, JBIG2, CCITT… : formats spécialisés
      }

      const res = await toJpeg(source, w, h, scale, opts.quality, opts.gray);
      if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();
      if (!res) continue;

      const before = stream.contents.length;
      if (res.bytes.length >= before * 0.95) continue;   // gain insuffisant

      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.set(PDFName.of('Width'), PDFNumber.of(res.width));
      dict.set(PDFName.of('Height'), PDFNumber.of(res.height));
      dict.set(PDFName.of('Length'), PDFNumber.of(res.bytes.length));
      dict.delete(PDFName.of('DecodeParms'));
      // /SMask est conservé : le lecteur remet le masque à l'échelle de l'image
      ctx.assign(ref, PDFRawStream.of(dict, res.bytes));

      changed++;
      saved += before - res.bytes.length;
    } catch (e) {
      /* image illisible : on la laisse telle quelle */
    }
    if (done % 3 === 0) await nextTick();
  }

  return { images: images.length, changed, saved };
}

/* ---------------------------------------------- moteur 2 : rasterisation */

async function rasterize(bytes, opts, report) {
  const src = await pdfjsLib.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
  const out = await PDFDocument.create();
  const scale = opts.dpi / 72;

  for (let i = 1; i <= src.numPages; i++) {
    report((i - 1) / src.numPages);
    const page = await src.getPage(i);
    const view = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(view.width));
    canvas.height = Math.max(1, Math.round(view.height));
    const c = canvas.getContext('2d', { alpha: false });
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    // intent « print » : pdf.js n'utilise alors pas requestAnimationFrame,
    // sinon le travail se fige dès que l'onglet passe en arrière-plan.
    await page.render({ canvasContext: c, viewport: view, intent: 'print' }).promise;

    if (opts.gray) {
      c.filter = 'grayscale(1)';
      c.drawImage(canvas, 0, 0);
      c.filter = 'none';
    }

    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', opts.quality));
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const p = out.addPage([view.width / scale, view.height / scale]);
    p.drawImage(img, { x: 0, y: 0, width: p.getWidth(), height: p.getHeight() });

    canvas.width = canvas.height = 0;
    page.cleanup();
    await nextTick();
  }

  await src.destroy();
  return out;
}

/* ------------------------------------------------------ pilote principal */

async function compress(bytes, opts, report) {
  let doc, stats = null;

  if (opts.raster) {
    doc = await rasterize(bytes, opts, report);
  } else {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    stats = await compressImages(doc, opts, report);
  }

  if (opts.stripMeta) {
    try {
      doc.setTitle(''); doc.setAuthor(''); doc.setSubject('');
      doc.setKeywords([]); doc.setProducer(''); doc.setCreator('');
      doc.catalog.delete(PDFName.of('Metadata'));
    } catch (e) { /* sans conséquence */ }
  }

  report(0.98);
  const saved = await doc.save({ useObjectStreams: true, updateFieldAppearances: false });
  return { bytes: saved, stats };
}

/* --------------------------------------------- recherche d'un poids cible */

const PALIERS = [
  { quality: 0.82, maxSide: 2400 },
  { quality: 0.72, maxSide: 2000 },
  { quality: 0.62, maxSide: 1600 },
  { quality: 0.50, maxSide: 1300 },
  { quality: 0.40, maxSide: 1000 },
  { quality: 0.32, maxSide: 800 },
  { quality: 0.60, dpi: 130, raster: true },
  { quality: 0.50, dpi: 110, raster: true },
  { quality: 0.42, dpi: 90, raster: true },
  { quality: 0.35, dpi: 72, raster: true },
];

const palierLabel = (i) => PALIERS[i].raster
  ? 'pages rasterisées à ' + PALIERS[i].dpi + ' ppp'
  : 'images à ' + Math.round(PALIERS[i].quality * 100) + ' % · texte préservé';

/* Cherche par dichotomie le palier le plus doux qui tient sous la limite.
   Les paliers qui préservent le texte sont épuisés en premier. */
async function compressToTarget(bytes, opts, onAttempt, report) {
  const target = opts.target;
  const tried = new Map();
  let tries = 0, smallest = null;

  const attempt = async (idx) => {
    if (tried.has(idx)) return tried.get(idx);
    const s = PALIERS[idx];
    onAttempt(++tries);
    const r = await compress(bytes.slice(0), {
      ...opts,
      quality: s.quality,
      maxSide: s.maxSide || 1000,
      dpi: s.dpi || 110,
      raster: !!s.raster,
    }, report);
    const out = { bytes: r.bytes, stats: r.stats, step: idx };
    tried.set(idx, out);
    if (!smallest || out.bytes.length < smallest.bytes.length) smallest = out;
    return out;
  };

  const search = async (lo, hi) => {
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = await attempt(mid);
      if (r.bytes.length <= target) { found = r; hi = mid - 1; }
      else lo = mid + 1;
    }
    return found;
  };

  if (bytes.length <= target) {
    const r = await attempt(0);
    return { ...r, attempts: tries };
  }

  const premierRaster = PALIERS.findIndex((p) => p.raster);
  const dernier = PALIERS.length - 1;

  let best = await search(0, premierRaster - 1);
  if (!best) {
    // Avant d'enchaîner les rasterisations, qui sont lentes, on vérifie sur le
    // palier le plus agressif que la limite est seulement atteignable.
    const extreme = await attempt(dernier);
    if (extreme.bytes.length <= target) {
      best = (await search(premierRaster, dernier - 1)) || extreme;
    }
  }

  return { ...(best || smallest), attempts: tries };
}

/* ------------------------------------------------ enregistrement des fichiers */

// L'écriture sur le disque passe par le processus principal, seul habilité.
async function enregistrerUn(item) {
  try {
    const r = await window.plume.enregistrer(outName(item.file.name), item.out);
    if (r.statut === 'ok') toast('Enregistré : ' + nomDe(r.chemin), r.chemin);
    return r.statut;
  } catch (e) {
    toast("Enregistrement impossible : " + (e && e.message ? e.message : 'erreur disque'));
    return 'erreur';
  }
}

const nomDe = (chemin) => chemin.split(/[\/]/).pop();

const outName = (name) => name.replace(/\.pdf$/i, '') + '-allege.pdf';

/* --------------------------------------------------------------- interface */

const NIVEAUX = {
  leger:     { quality: 82, maxSide: 2400, raster: false, dpi: 150, gray: false },
  equilibre: { quality: 68, maxSide: 1700, raster: false, dpi: 130, gray: false },
  fort:      { quality: 50, maxSide: 1200, raster: false, dpi: 110, gray: false },
  extreme:   { quality: 55, maxSide: 1000, raster: true,  dpi: 110, gray: false },
};

const el = {
  drop: $('#drop'), picker: $('#picker'), files: $('#files'), sample: $('#sampleRow'),
  quality: $('#quality'), maxSide: $('#maxSide'), dpi: $('#dpi'), dpiField: $('#dpiField'),
  raster: $('#raster'), gray: $('#gray'), meta: $('#meta'),
  qOut: $('#qOut'), rOut: $('#rOut'), dOut: $('#dOut'),
  limitRow: $('#limitRow'), limitValue: $('#limitValue'), limitUnit: $('#limitUnit'),
  limitName: $('#limitName'), limitPresets: $('#limitPresets'),
  tBefore: $('#tBefore'), tAfter: $('#tAfter'), tSaved: $('#tSaved'),
  saveAll: $('#saveAll'), saveBeside: $('#saveBeside'), clear: $('#clear'),
};

const items = [];
let busy = false;
let targetMode = false;

const limitBytes = () => Math.max(1024, Math.round(+el.limitValue.value * +el.limitUnit.value));
const limitText = () =>
  String(+el.limitValue.value).replace('.', ',') + ' ' +
  (+el.limitUnit.value === 1048576 ? 'Mo' : 'Ko');

function readOpts() {
  return {
    quality: +el.quality.value / 100,
    maxSide: +el.maxSide.value,
    dpi: +el.dpi.value,
    raster: el.raster.checked,
    gray: el.gray.checked,
    stripMeta: el.meta.checked,
    target: targetMode ? limitBytes() : 0,
    targetText: limitText(),
  };
}

function syncManual() {
  el.qOut.textContent = el.quality.value + ' %';
  el.rOut.textContent = el.maxSide.value + ' px';
  el.dOut.textContent = el.dpi.value + ' ppp';
  el.dpiField.hidden = !el.raster.checked;
}

function syncLimit() {
  el.limitName.textContent = 'Moins de ' + limitText();
  const mo = +el.limitUnit.value === 1048576 ? +el.limitValue.value : null;
  el.limitPresets.querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.mo === mo)));
}

function selectLevel(name) {
  targetMode = name === 'cible';
  el.limitRow.hidden = !targetMode;
  document.querySelectorAll('.level')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.level === name)));
  if (targetMode) return; // les curseurs sont pilotés par la recherche automatique

  const p = NIVEAUX[name];
  el.quality.value = p.quality;
  el.maxSide.value = p.maxSide;
  el.dpi.value = p.dpi;
  el.raster.checked = p.raster;
  el.gray.checked = p.gray;
  syncManual();
}

$('#levels').addEventListener('click', (e) => {
  const b = e.target.closest('.level');
  if (b) selectLevel(b.dataset.level);
});

el.limitPresets.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  el.limitUnit.value = '1048576';
  el.limitValue.value = b.dataset.mo;
  syncLimit();
});
[el.limitValue, el.limitUnit].forEach((c) => c.addEventListener('input', syncLimit));

// Toucher un réglage manuel, c'est reprendre la main : on quitte les niveaux
[el.quality, el.maxSide, el.dpi, el.raster, el.gray].forEach((c) =>
  c.addEventListener('input', () => {
    syncManual();
    targetMode = false;
    el.limitRow.hidden = true;
    document.querySelectorAll('.level').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  }));

/* --- dépôt des fichiers --- */
el.drop.addEventListener('click', () => el.picker.click());
el.picker.addEventListener('change', () => { addFiles(el.picker.files); el.picker.value = ''; });

['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop' || !e.relatedTarget) el.drop.classList.remove('over');
  }));
window.addEventListener('drop', (e) => { if (e.dataTransfer) addFiles(e.dataTransfer.files); });

function addFiles(list) {
  const pdfs = [...list].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!pdfs.length) {
    if (list.length) toast('Seuls les fichiers PDF peuvent être compressés.');
    return;
  }
  if (el.sample) { el.sample.remove(); el.sample = null; }
  pdfs.forEach(addRow);
  el.clear.disabled = false;
  run();
}

const ROW = `
  <div class="thumb"><canvas></canvas></div>
  <div class="cell">
    <div class="row-top"><span class="name"></span><span class="tag">en attente</span></div>
    <div class="gauge"><i style="width:100%"></i><span class="gauge-limit"></span></div>
    <div class="measures">
      <span class="before"></span><span class="sep" hidden>→</span>
      <span class="after"></span><span class="delta"></span>
    </div>
    <p class="detail"></p>
  </div>
  <div class="row-actions">
    <button type="button" class="btn small save" hidden>Enregistrer</button>
    <button type="button" class="x" title="Retirer" aria-label="Retirer">✕</button>
  </div>`;

function addRow(file) {
  const li = document.createElement('li');
  li.className = 'row';
  li.innerHTML = ROW;
  const item = {
    file, node: li, state: 'queue', out: null,
    source: window.plume.cheminDe(file),   // dossier de l'original, si connu
    q: li.querySelector.bind(li),
  };

  item.q('.name').textContent = file.name;
  item.q('.before').textContent = fmtSize(file.size);
  item.q('.x').addEventListener('click', () => {
    if (item.state === 'work') return;
    items.splice(items.indexOf(item), 1);
    li.remove();
    updateTotals();
    el.clear.disabled = !items.length;
  });
  item.q('.save').addEventListener('click', () => { if (item.out) enregistrerUn(item); });

  el.files.appendChild(li);
  items.push(item);
  thumbnail(item);
}

async function thumbnail(item) {
  try {
    const buf = new Uint8Array(await item.file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const page = await doc.getPage(1);
    const v = page.getViewport({ scale: 1 });
    const view = page.getViewport({ scale: Math.min(76 / v.width, 100 / v.height) });
    const canvas = item.q('.thumb canvas');
    canvas.width = Math.round(view.width);
    canvas.height = Math.round(view.height);
    const c = canvas.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: c, viewport: view, intent: 'print' }).promise;
    await doc.destroy();
  } catch (e) { item.q('.thumb').classList.add('blank'); }
}

/* --- file d'attente --- */
async function run() {
  if (busy) return;
  busy = true;
  el.saveAll.disabled = true;
  el.saveBeside.disabled = true;

  for (;;) {
    const item = items.find((i) => i.state === 'queue');
    if (!item) break;

    item.state = 'work';
    const tag = item.q('.tag');
    const gauge = item.q('.gauge');
    const fill = item.q('.gauge i');
    tag.textContent = 'compression';
    tag.className = 'tag busy';
    gauge.className = 'gauge';
    item.q('.detail').textContent = '';
    await nextTick();

    const t0 = performance.now();
    const opts = readOpts();

    try {
      const bytes = new Uint8Array(await item.file.arrayBuffer());
      const progress = (p) => { fill.style.width = (100 - Math.round(Math.min(1, p) * 88)) + '%'; };

      const r = opts.target
        ? await compressToTarget(bytes, opts, (n) => { tag.textContent = 'essai ' + n; }, progress)
        : await compress(bytes, opts, progress);

      const out = r.bytes, stats = r.stats;
      const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
      const gain = 1 - out.length / item.file.size;
      item.state = 'done';
      item.out = out.length < item.file.size ? out : null;
      const finale = item.out ? out.length : item.file.size;

      // La jauge garde l'échelle du fichier d'origine
      fill.style.width = Math.max(2, Math.round((finale / item.file.size) * 100)) + '%';
      item.q('.sep').hidden = false;
      item.q('.after').textContent = fmtSize(finale);
      item.q('.delta').textContent = item.out ? '−' + Math.round(gain * 100) + ' %' : '';
      item.q('.save').hidden = !item.out;

      if (opts.target) {
        const ok = finale <= opts.target;
        const mark = item.q('.gauge-limit');
        mark.classList.add('on');
        mark.style.left = Math.min(100, (opts.target / item.file.size) * 100) + '%';
        gauge.className = 'gauge ' + (ok ? 'done' : 'over');
        tag.textContent = ok ? 'sous la limite' : 'limite non atteinte';
        tag.className = 'tag ' + (ok ? 'good' : 'bad');
        item.q('.detail').textContent = ok
          ? (item.out
              ? 'Objectif ' + opts.targetText + ' atteint en ' + r.attempts +
                (r.attempts > 1 ? ' essais' : ' essai') + ' · ' + palierLabel(r.step) + ' · ' + secs + ' s'
              : 'Ce fichier était déjà sous ' + opts.targetText + ' : il est laissé intact.')
          : 'Impossible de descendre sous ' + opts.targetText + ' : ' + fmtSize(finale) +
            ' est le minimum atteignable sans rendre le document illisible.';
      } else if (gain < 0.03) {
        gauge.className = 'gauge';
        tag.textContent = item.out ? 'gain minime' : 'déjà optimisé';
        tag.className = 'tag warn';
        item.q('.detail').textContent = opts.raster
          ? 'Ce PDF ne gagne plus rien à être compressé.'
          : "Peu ou pas d'images à compresser — le niveau Extrême transforme les pages en images.";
      } else {
        gauge.className = 'gauge done';
        tag.textContent = 'compressé';
        tag.className = 'tag good';
        item.q('.detail').textContent = stats
          ? (stats.changed
              ? stats.changed + ' image' + (stats.changed > 1 ? 's' : '') +
                ' ré-encodée' + (stats.changed > 1 ? 's' : '') + ' sur ' + stats.images +
                ' · texte préservé · ' + secs + ' s'
              : 'Structure du fichier réécrite · texte préservé · ' + secs + ' s')
          : 'Pages rasterisées à ' + opts.dpi + ' ppp · ' + secs + ' s';
      }
    } catch (err) {
      item.state = 'error';
      fill.style.width = '100%';
      gauge.className = 'gauge over';
      tag.textContent = 'échec';
      tag.className = 'tag bad';
      item.q('.detail').textContent = /encrypt|password/i.test(err && err.message || '')
        ? 'PDF protégé par mot de passe : impossible à traiter.'
        : 'Fichier illisible ou endommagé.';
      console.error(item.file.name, err);
    }

    updateTotals();
    await nextTick();
  }

  busy = false;
  updateTotals();
}

function updateTotals() {
  const done = items.filter((i) => i.state === 'done');
  const before = done.reduce((s, i) => s + i.file.size, 0);
  const after = done.reduce((s, i) => s + (i.out ? i.out.length : i.file.size), 0);
  el.tBefore.textContent = done.length ? fmtSize(before) : '—';
  el.tAfter.textContent = done.length ? fmtSize(after) : '—';
  el.tSaved.textContent = done.length && before > after
    ? fmtSize(before - after) + ' économisés (−' + Math.round((1 - after / before) * 100) + ' %)'
    : '';
  el.saveAll.disabled = busy || !items.some((i) => i.out);
  el.saveBeside.disabled = busy || !items.some((i) => i.out && i.source);
  el.clear.disabled = busy || !items.length;
}

/* --- enregistrements groupés : un choix de dossier, puis tout est écrit --- */

const prets = () => items.filter((i) => i.out);

el.saveAll.addEventListener('click', async () => {
  const liste = prets();
  if (!liste.length) return;
  if (liste.length === 1) { enregistrerUn(liste[0]); return; }

  const fichiers = liste.map((i) => ({ nom: outName(i.file.name), data: i.out }));
  try {
    const r = await window.plume.enregistrerLot(fichiers);
    if (r.statut === 'ok') toast(r.nombre + ' fichiers enregistrés dans ' + r.dossier, r.premier);
  } catch (e) {
    toast("Enregistrement impossible : " + (e && e.message ? e.message : 'erreur disque'));
  }
});

el.saveBeside.addEventListener('click', async () => {
  const liste = prets().filter((i) => i.source);
  if (!liste.length) return;
  const fichiers = liste.map((i) => ({ nom: outName(i.file.name), data: i.out, source: i.source }));
  try {
    const r = await window.plume.enregistrerACote(fichiers);
    if (r.statut === 'ok') {
      toast(r.nombre + (r.nombre > 1 ? ' fichiers écrits' : ' fichier écrit') +
            " à côté des originaux", r.premier);
    }
  } catch (e) {
    toast("Enregistrement impossible : " + (e && e.message ? e.message : 'erreur disque'));
  }
});

el.clear.addEventListener('click', () => {
  if (busy) return;
  items.length = 0;
  el.files.innerHTML = '';
  updateTotals();
  el.clear.disabled = true;
});

// Raccourcis attendus d'une application de bureau
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key === 'o') { e.preventDefault(); el.picker.click(); }
  if (ctrl && e.key === 's' && !el.saveAll.disabled) { e.preventDefault(); el.saveAll.click(); }
});

syncManual();
syncLimit();

/* -------------------------------------------------------- mises à jour

   Le processus principal surveille l'adresse de publication et prévient ici.
   Rien n'interrompt le travail : le bandeau informe, et l'utilisateur choisit
   le moment du redémarrage. À défaut, la mise à jour s'applique à la fermeture. */

(async () => {
  const barre = $('#maj');
  const texte = $('#majTexte');
  const jaugeBoite = $('#majBarre');
  const jauge = $('#majJauge');
  const action = $('#majAction');

  const infos = await window.plume.version();
  $('#versionTexte').textContent = 'Poids Plume ' + infos.version +
    (infos.installee ? '' : ' · version portable, non mise à jour automatiquement');

  $('#majFermer').addEventListener('click', () => { barre.hidden = true; });
  action.addEventListener('click', () => {
    action.disabled = true;
    action.textContent = 'Redémarrage…';
    window.plume.appliquerMiseAJour();
  });

  window.plume.surMiseAJour((m) => {
    if (m.etat === 'echec') return; // sans connexion, on n'affiche rien

    barre.hidden = false;
    if (m.etat === 'disponible') {
      texte.textContent = 'Version ' + m.version + ' disponible — téléchargement…';
      jaugeBoite.hidden = false;
    }
    if (m.etat === 'telechargement') {
      texte.textContent = 'Téléchargement ' + m.pourcent + ' %';
      jaugeBoite.hidden = false;
      jauge.style.width = m.pourcent + '%';
    }
    if (m.etat === 'prete') {
      barre.classList.add('prete');
      texte.textContent = 'Version ' + m.version + ' prête à être installée.';
      jaugeBoite.hidden = true;
      action.hidden = false;
    }
  });
})();
