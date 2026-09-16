/* Prépare une nouvelle version : construit l'installateur, puis rassemble dans
   « publication/ » les seuls fichiers à téléverser sur l'hébergement.

   Usage :  npm run publier
   Les anciennes versions sont conservées : c'est ce qui permet aux postes
   déjà installés de ne télécharger que les blocs modifiés. */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(racine, 'package.json'), 'utf8'));
const version = pkg.version;
const publication = pkg.build.publish[0];
const adresse = publication.url || null;
const sortie = path.join(racine, 'publication');

console.log('\n  Poids Plume ' + version + '\n');

if (publication.provider === 'github') {
  console.log('  Ce projet publie via GitHub : rien à téléverser à la main.\n');
  console.log('    npm version patch        (ou minor)');
  console.log('    git push --follow-tags\n');
  console.log('  GitHub construit puis publie la version, et les postes installés');
  console.log("  la récupèrent seuls. Ce script ne sert qu'à produire les fichiers");
  console.log('  localement, par exemple pour un hébergement de secours.\n');
}

if (adresse && /localhost|VOTRE-HEBERGEMENT|exemple/.test(adresse)) {
  console.log("  ⚠  L'adresse de publication est encore « " + adresse + " ».");
  console.log('     Changez « build.publish[0].url » dans package.json avant de diffuser,');
  console.log('     sinon les postes installés chercheront leurs mises à jour au mauvais endroit.\n');
}

console.log('  Construction…\n');
execSync('npx electron-builder --win', { cwd: racine, stdio: 'inherit' });

fs.mkdirSync(sortie, { recursive: true });

const installateur = `Poids-Plume-Installateur-${version}.exe`;
const aPublier = ['latest.yml', installateur, installateur + '.blockmap'];
const manquants = [];

for (const nom of aPublier) {
  const source = path.join(racine, 'dist', nom);
  if (!fs.existsSync(source)) { manquants.push(nom); continue; }
  fs.copyFileSync(source, path.join(sortie, nom));
}

if (manquants.length) {
  console.error('\n  ✗ Fichiers introuvables : ' + manquants.join(', '));
  process.exit(1);
}

const taille = (f) => (fs.statSync(path.join(sortie, f)).size / 1024 / 1024).toFixed(1) + ' Mo';

console.log('\n  À téléverser dans ' + adresse + '\n');
for (const nom of aPublier) console.log('    ' + nom + '   (' + taille(nom) + ')');
console.log('\n  Dossier prêt : ' + sortie);
console.log('  Ne supprimez pas les versions précédentes : leurs fichiers .blockmap');
console.log('  servent à ne télécharger que les différences.\n');
