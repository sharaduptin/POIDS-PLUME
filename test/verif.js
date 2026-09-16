/* Vérification de l'application réelle : on démarre main.js, on pilote la fenêtre,
   puis on enregistre une capture. Lancer avec :  npx electron test/verif.js  */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

require('../src/main.js'); // démarre l'application telle qu'elle est livrée

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await attendre(1200);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('ECHEC : aucune fenêtre'); app.exit(1); return; }
  await attendre(800);

  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'plume-'));

  const resultat = await win.webContents.executeJavaScript(`(async () => {
    const out = { pont: typeof window.plume, libs: {
      pdfLib: typeof PDFLib, pdfjs: typeof pdfjsLib, worker: typeof window.pdfjsWorker } };

    // Un PDF illustré, fabriqué sur place
    const { PDFDocument, StandardFonts } = PDFLib;
    const cv = document.createElement('canvas'); cv.width = 2000; cv.height = 1400;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 2000, 1400);
    g.addColorStop(0, '#e94'); g.addColorStop(1, '#27c');
    c.fillStyle = g; c.fillRect(0, 0, 2000, 1400);
    for (let i = 0; i < 400; i++) {
      c.fillStyle = 'rgba(' + (Math.random()*255|0) + ',' + (Math.random()*255|0) + ',' + (Math.random()*255|0) + ',.5)';
      c.beginPath(); c.arc(Math.random()*2000, Math.random()*1400, Math.random()*60+8, 0, 7); c.fill();
    }
    const jpg = new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.97))).arrayBuffer());
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    const im = await d.embedJpg(jpg);
    for (let i = 0; i < 3; i++) {
      const p = d.addPage([595, 842]);
      p.drawImage(im, { x: 20, y: 330, width: 555, height: 380 });
      p.drawText('Catalogue page ' + (i + 1), { x: 20, y: 270, size: 18, font: f });
    }
    const pdf = await d.save();
    out.origine = pdf.length;

    // On le dépose dans l'interface comme le ferait l'utilisateur
    const dt = new DataTransfer();
    dt.items.add(new File([pdf], 'catalogue-test.pdf', { type: 'application/pdf' }));
    addFiles(dt.files);
    for (let i = 0; i < 80 && (!items[0] || items[0].state !== 'done'); i++) {
      await new Promise(r => setTimeout(r, 150));
    }

    const it = items[0];
    out.etat = it.state;
    out.etiquette = it.q('.tag').textContent;
    out.mesures = it.q('.measures').textContent.replace(/\\s+/g, ' ').trim();
    out.detail = it.q('.detail').textContent;
    out.compresse = it.out ? it.out.length : null;

    // Écriture sur le disque via le processus principal (sans boîte de dialogue)
    if (it.out) {
      const r = await window.plume.enregistrer('catalogue-test-allege.pdf', it.out, ${JSON.stringify(dossier)});
      out.ecriture = r;
    }

    // Le mode « poids maximal » doit aussi fonctionner
    selectLevel('cible');
    out.limiteVisible = !document.querySelector('#limitRow').hidden;
    const cible = await compressToTarget(pdf.slice(0), readOpts(), () => {}, () => {});
    out.cible = { octets: cible.bytes.length, essais: cible.attempts, palier: palierLabel(cible.step) };
    selectLevel('equilibre');
    return out;
  })()`);

  // Contrôle côté disque
  if (resultat.ecriture && resultat.ecriture.chemin) {
    resultat.fichierSurDisque = fs.statSync(resultat.ecriture.chemin).size;
  }

  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, 'apercu.png'), image.toPNG());

  console.log(JSON.stringify(resultat, null, 1));
  fs.rmSync(dossier, { recursive: true, force: true });
  app.exit(0);
});
