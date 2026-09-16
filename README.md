# Poids Plume — application Windows

Compresseur de PDF en application de bureau : installation en un clic, mises à jour
automatiques, et aucune connexion nécessaire pour compresser.

## Utiliser

Deux façons, selon l'usage :

- **`dist/Poids-Plume-Installateur-x.y.z.exe`** — s'installe en un clic pour
  l'utilisateur courant (aucun mot de passe administrateur), crée les raccourcis, et
  **se met à jour tout seul** par la suite. C'est la version à diffuser.
- **`dist/Poids Plume x.y.z.exe`** — version portable : un fichier unique, déplaçable
  (clé USB, dossier partagé), qui n'écrit rien dans le registre mais ne se met pas
  à jour automatiquement.

Glissez vos PDF dans la fenêtre, choisissez un niveau, puis enregistrez :

| Bouton | Ce qu'il fait |
|---|---|
| **Enregistrer** (sur une ligne) | Boîte de dialogue Windows, vous choisissez le nom et l'endroit |
| **À côté des originaux** | Écrit chaque fichier allégé dans le dossier de son original |
| **Tout enregistrer…** | Vous choisissez un dossier, tout y est écrit d'un coup |

Les fichiers d'origine ne sont jamais modifiés, et un nom déjà pris devient
`nom (2).pdf` plutôt que d'écraser quoi que ce soit. Après un enregistrement,
le bandeau propose d'ouvrir le dossier concerné.

## Niveaux

| Niveau | Effet | Texte sélectionnable |
|---|---|---|
| Léger | Images ré-encodées en qualité 82 %, max 2400 px | oui |
| Équilibré | Qualité 68 %, max 1700 px — le bon compromis | oui |
| Fort | Qualité 50 %, max 1200 px | oui |
| Extrême | Chaque page devient une image (110 ppp) | **non** |
| Moins de 1 Mo | Poids maximal imposé, réglage cherché automatiquement | selon le besoin |

Le mode « poids maximal » essaie une échelle de dix paliers et retient le plus doux
qui tient sous la limite, en deux à quatre essais. Les six paliers qui préservent le
texte passent avant toute rasterisation.

## Mises à jour automatiques

L'application installée vérifie au démarrage, puis toutes les six heures, s'il existe
une version plus récente. Elle la télécharge en arrière-plan et affiche un bandeau
« Version X prête à être installée » avec un bouton **Redémarrer maintenant**. Si
l'utilisateur l'ignore, la mise à jour s'applique à la fermeture de l'application.
Rien n'est jamais interrompu, et sans connexion il ne se passe simplement rien.

**Seul le téléchargement des blocs modifiés a lieu.** Mesuré entre deux versions :

```
File has 58 changed blocks
Full: 80 763 Ko, To download: 1 230 Ko (2 %)
```

Soit 1,2 Mo au lieu de 79 Mo, en une seconde.

### Mettre une version en ligne

La publication passe par GitHub : le dépôt construit l'installateur lui-même et le
met en ligne. Rien à compiler ni à téléverser à la main.

```
npm version patch        # 1.1.0 -> 1.1.1  (ou « minor » pour 1.2.0)
git push --follow-tags
```

L'étiquette déclenche `.github/workflows/publier.yml` : GitHub construit sur une
machine Windows, crée la Release et y dépose l'installateur, son `.blockmap` et le
`latest.yml`. Une dizaine de minutes plus tard, chaque poste installé voit la
nouvelle version au démarrage suivant et ne télécharge que les blocs modifiés.

Les fichiers des versions précédentes restent dans leurs Releases : c'est ce qui
permet la comparaison par blocs. Ne les supprimez pas.

### Le dépôt doit être public

Les Releases d'un dépôt privé exigent un jeton d'accès pour être téléchargées, que
les postes de vos utilisateurs n'ont pas. Le dépôt doit donc être **public** pour que
les mises à jour fonctionnent. Le code y est visible, ce qui ne pose pas de problème
ici : il ne contient ni clé, ni mot de passe, ni donnée personnelle.

Si le code doit rester privé, il faut revenir à un hébergement de fichiers classique :
remplacer `build.publish` par
`[{ "provider": "generic", "url": "https://mondomaine.fr/poids-plume/" }]`,
puis `npm run publier` et téléverser le contenu de `publication/`. Cet hébergement
doit accepter les requêtes multi-plages (voir ci-dessous).

### Le volume téléchargé, selon l'hébergement

GitHub Releases **ne permet pas le téléchargement différentiel** : son CDN
(`release-assets.githubusercontent.com`) répond `501 Not Implemented` aux requêtes
multi-plages. L'application le constate, l'inscrit dans son journal
(« Cannot download differentially, fallback to full download ») et récupère
l'installateur entier — 79 Mo, en arrière-plan, sans que l'utilisateur ait rien à faire.

Pour retrouver les ~1,5 Mo par mise à jour, il faut servir les fichiers depuis un
hébergement qui accepte les requêtes multi-plages (Apache et nginx le font ; un
mutualisé OVH convient). Le code peut rester sur GitHub : seule l'adresse consultée
change. Dans `package.json` :

```json
"publish": [{ "provider": "generic", "url": "https://mondomaine.fr/poids-plume/" }]
```

puis `npm run publier` et téléverser le contenu de `publication/`.
Mesuré sur un tel hébergement : 58 blocs modifiés, 1 230 Ko sur 80 763 (2 %).

### Ce que l'hébergement doit savoir faire

Pour un hébergement classique (FTP, OVH, S3, nginx…), deux
conditions : servir les fichiers en HTTPS sans authentification, et accepter les
**requêtes multi-plages** (`Range: bytes=0-99, 500-999`) avec une réponse en
`multipart/byteranges`. Sans cela tout fonctionne encore, mais chaque mise à jour
retélécharge les 79 Mo — le piège rencontré pendant la mise au point :
`outils/servir-test.js` ne gérait qu'une plage à la fois, et le différentiel
retombait silencieusement sur le téléchargement complet.

### Éprouver le mécanisme sans rien mettre en ligne

```
node outils/servir-test.js
```

Sert `publication/` sur `http://localhost:5310` avec la gestion des plages multiples,
et journalise chaque octet transféré. Mettre temporairement cette adresse dans
`build.publish[0].url`, puis installer une version, en publier une plus récente et
relancer l'application.

Le journal de l'application se trouve dans
`%APPDATA%\poids-plume\logs\main.log` : il indique la version trouvée, le nombre
de blocs modifiés et le volume réellement téléchargé.

### Trois limites à connaître

- **La version portable ne se met pas à jour.** Seule l'installation par
  `Poids-Plume-Installateur-x.y.z.exe` le fait ; le pied de page de l'application
  l'indique à l'utilisateur.
- **La première mise à jour après une installation télécharge tout.** Le différentiel
  a besoin de l'installateur précédent, gardé en cache ; il n'existe qu'à partir de
  la deuxième mise à jour.
- **L'application n'est pas signée.** Au premier lancement, les autres postes
  verront l'avertissement « Windows a protégé votre ordinateur » (il faut cliquer
  sur « Informations complémentaires » puis « Exécuter quand même »). Le supprimer
  demande un certificat de signature de code payant.

## Reconstruire

```
npm install
npm run dist
```

L'exécutable est produit dans `dist/`. Deux pièges rencontrés sur cette machine :

- **electron-builder refuse un `.ico` contenant des PNG** (« shas unknown format »).
  On lui fournit `build/icone.png` en 256 × 256 ; il fabrique le `.ico` lui-même.
- **L'extraction de `winCodeSign` échoue** car l'archive contient des liens
  symboliques macOS que Windows ne crée pas sans le mode développeur. Contournement :
  extraire l'archive à la main dans
  `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`
  (les erreurs sur `darwin/` sont sans conséquence ici), puis relancer le build.

## Vérifier

```
npx electron test/verif.js
```

Démarre l'application réelle, fabrique un PDF illustré, le dépose dans l'interface,
contrôle la compression et l'écriture sur le disque, puis enregistre une capture
dans `test/apercu.png`.

## Organisation

```
src/main.js      fenêtre, boîtes de dialogue, écriture des fichiers
src/preload.js   pont : les quatre seules actions offertes à la page
src/app.js       moteurs de compression + interface
src/index.html   page unique de l'application
src/style.css    mise en forme, thèmes clair et sombre
src/vendor/      pdf-lib et pdf.js (copies locales)
src/polices/     IBM Plex, sous-ensembles latins (l'appli ne charge rien en ligne)
build/icone.png  source de l'icône
```

La page n'a aucun accès à Node : `contextIsolation`, `sandbox`, et une politique de
sécurité qui interdit le réseau, le code dynamique et le style en ligne.

## Les trois versions de l'outil

- cette application Windows ;
- le site en ligne : <https://claude.ai/code/artifact/155b1991-06a6-4312-bdaa-cabcd1cf22d0> ;
- la version servie en local, dans `../pdf-compresseur/` (port 5300).

Le moteur de compression est le même partout ; seule la façon de rendre le fichier
à l'utilisateur change.
