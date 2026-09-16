/* Poids Plume — processus principal.

   L'application est entièrement hors ligne : aucune requête réseau n'est faite,
   et la fenêtre ne charge que des fichiers locaux. Le rendu n'a aucun accès à
   Node ; il passe par les quelques messages déclarés ci-dessous. */

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const journal = require('electron-log');
const path = require('path');
const fs = require('fs/promises');

const PAGE = path.join(__dirname, 'index.html');
let fenetre = null;

function creerFenetre() {
  fenetre = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 700,
    minHeight: 560,
    title: 'Poids Plume',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#13161B' : '#F2F4F6',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icone.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  fenetre.once('ready-to-show', () => fenetre.show());
  fenetre.loadFile(PAGE);

  // Rien ne doit pouvoir emmener la fenêtre ailleurs que sur sa propre page
  fenetre.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  fenetre.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Une seule instance : un second lancement réveille la fenêtre existante
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!fenetre) return;
    if (fenetre.isMinimized()) fenetre.restore();
    fenetre.focus();
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    creerFenetre();
    surveillerMisesAJour();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) creerFenetre();
    });
  });

  app.on('window-all-closed', () => app.quit());
}

/* -------------------------------------------------------- mises à jour

   L'adresse consultée est celle de « build.publish.url » dans package.json ;
   electron-builder l'inscrit dans l'application au moment de la construction.
   Seule la version installée depuis l'installateur peut se mettre à jour :
   la version portable, elle, ignore tout ceci. */

const SIX_HEURES = 6 * 60 * 60 * 1000;

function dire(etat, infos) {
  if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send('maj', { etat, ...infos });
}

function surveillerMisesAJour() {
  // Journal dans %APPDATA%/Poids Plume/logs : la trace de ce qui s'est passé
  journal.transports.file.level = 'info';
  autoUpdater.logger = journal;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true; // on publie un installateur complet, pas un téléchargeur

  autoUpdater.on('update-available', (i) => dire('disponible', { version: i.version }));
  autoUpdater.on('download-progress', (p) => dire('telechargement', {
    pourcent: Math.round(p.percent),
    octets: p.transferred,
    total: p.total,
  }));
  autoUpdater.on('update-downloaded', (i) => dire('prete', { version: i.version }));
  autoUpdater.on('error', (e) => {
    // Une mise à jour injoignable ne doit jamais gêner le travail en cours
    console.error('mise à jour :', e && e.message);
    dire('echec', { message: e && e.message ? e.message : 'inconnu' });
  });

  const verifier = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(verifier, 4000);          // laisse la fenêtre s'ouvrir d'abord
  setInterval(verifier, SIX_HEURES);   // puis discrètement, pendant l'usage
}

ipcMain.handle('appliquer-maj', () => {
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return { statut: 'redemarrage' };
});

ipcMain.handle('version', () => ({
  version: app.getVersion(),
  installee: app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR,
}));

/* ------------------------------------------------------ enregistrement */

const FILTRES = [{ name: 'Document PDF', extensions: ['pdf'] }];

// Enregistrer un fichier, l'utilisateur choisit où
ipcMain.handle('enregistrer', async (_e, { nom, data, dossier }) => {
  let cible;
  if (dossier) {
    cible = path.join(dossier, nom);
  } else {
    const r = await dialog.showSaveDialog(fenetre, {
      title: 'Enregistrer le PDF allégé',
      defaultPath: nom,
      filters: FILTRES,
    });
    if (r.canceled || !r.filePath) return { statut: 'annule' };
    cible = r.filePath;
  }
  await fs.writeFile(cible, Buffer.from(data));
  return { statut: 'ok', chemin: cible };
});

// Enregistrer plusieurs fichiers d'un coup dans un dossier choisi
ipcMain.handle('enregistrer-lot', async (_e, { fichiers }) => {
  const r = await dialog.showOpenDialog(fenetre, {
    title: 'Choisir le dossier de destination',
    buttonLabel: 'Enregistrer ici',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { statut: 'annule' };

  const dossier = r.filePaths[0];
  const ecrits = [];
  for (const f of fichiers) {
    const cible = await nomLibre(dossier, f.nom);
    await fs.writeFile(cible, Buffer.from(f.data));
    ecrits.push(cible);
  }
  return { statut: 'ok', dossier, nombre: ecrits.length, premier: ecrits[0] };
});

// Écrire à côté du fichier d'origine, sans rien écraser
ipcMain.handle('enregistrer-a-cote', async (_e, { fichiers }) => {
  const ecrits = [];
  for (const f of fichiers) {
    if (!f.source) continue;
    const cible = await nomLibre(path.dirname(f.source), f.nom);
    await fs.writeFile(cible, Buffer.from(f.data));
    ecrits.push(cible);
  }
  if (!ecrits.length) return { statut: 'annule' };
  return { statut: 'ok', nombre: ecrits.length, premier: ecrits[0] };
});

ipcMain.handle('montrer', async (_e, { chemin }) => {
  if (chemin) shell.showItemInFolder(chemin);
});

// « rapport.pdf » existe déjà ? on écrit « rapport (2).pdf » plutôt que d'écraser
async function nomLibre(dossier, nom) {
  const ext = path.extname(nom);
  const base = path.basename(nom, ext);
  let candidat = path.join(dossier, nom);
  for (let i = 2; i < 500; i++) {
    try {
      await fs.access(candidat);
    } catch {
      return candidat; // le fichier n'existe pas : le nom est libre
    }
    candidat = path.join(dossier, `${base} (${i})${ext}`);
  }
  return candidat;
}
