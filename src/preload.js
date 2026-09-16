/* Pont entre la page et le système : la page n'a accès qu'à ces quatre actions. */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('plume', {
  // Chemin réel d'un fichier glissé depuis l'explorateur (sert à proposer
  // « enregistrer à côté de l'original »). Vide si le fichier vient d'ailleurs.
  cheminDe(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  enregistrer: (nom, data, dossier) =>
    ipcRenderer.invoke('enregistrer', { nom, data, dossier }),

  enregistrerLot: (fichiers) =>
    ipcRenderer.invoke('enregistrer-lot', { fichiers }),

  enregistrerACote: (fichiers) =>
    ipcRenderer.invoke('enregistrer-a-cote', { fichiers }),

  montrer: (chemin) => ipcRenderer.invoke('montrer', { chemin }),

  // Mises à jour : la page est prévenue, et peut demander le redémarrage
  surMiseAJour(callback) {
    ipcRenderer.on('maj', (_e, infos) => callback(infos));
  },
  appliquerMiseAJour: () => ipcRenderer.invoke('appliquer-maj'),
  version: () => ipcRenderer.invoke('version'),
});
