/* Sert le dossier « publication/ » sur http://localhost:5310 pour éprouver
   le mécanisme de mise à jour sans rien mettre en ligne.

   Les requêtes « Range » sont indispensables : c'est ainsi que l'application
   ne récupère que les blocs modifiés au lieu des 79 Mo. Un hébergement qui ne
   les gère pas fonctionnera quand même, mais retéléchargera tout à chaque fois. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const RACINE = path.join(__dirname, '..', 'publication');
const PORT = 5310;

const TYPES = { '.yml': 'text/yaml', '.exe': 'application/octet-stream', '.blockmap': 'application/octet-stream' };

http.createServer((req, res) => {
  const nom = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '');
  const fichier = path.join(RACINE, nom);

  if (!fichier.startsWith(RACINE) || !fs.existsSync(fichier) || fs.statSync(fichier).isDirectory()) {
    res.writeHead(404).end('introuvable');
    console.log('  404  ' + nom);
    return;
  }

  const taille = fs.statSync(fichier).size;
  const type = TYPES[path.extname(fichier)] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    // Le téléchargement différentiel demande beaucoup de plages d'un coup :
    // il faut lui répondre en « multipart/byteranges », sinon il abandonne
    // et reprend le fichier entier.
    const plages = range.replace('bytes=', '').split(',').map((p) => {
      const [a, b] = p.trim().split('-');
      const d = parseInt(a, 10);
      return { d, f: b ? parseInt(b, 10) : taille - 1 };
    }).filter((p) => Number.isFinite(p.d));

    if (plages.length === 1) {
      const { d, f } = plages[0];
      res.writeHead(206, {
        'Content-Range': `bytes ${d}-${f}/${taille}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': f - d + 1,
        'Content-Type': type,
      });
      console.log('  206  ' + nom + '  ' + (f - d + 1) + ' octets');
      fs.createReadStream(fichier, { start: d, end: f }).pipe(res);
      return;
    }

    const limite = 'PLUME' + Date.now().toString(16);
    const entetes = plages.map((p) =>
      Buffer.from(`\r\n--${limite}\r\nContent-Type: ${type}\r\n` +
                  `Content-Range: bytes ${p.d}-${p.f}/${taille}\r\n\r\n`));
    const cloture = Buffer.from(`\r\n--${limite}--\r\n`);
    const total = plages.reduce((s, p, i) => s + entetes[i].length + (p.f - p.d + 1), 0) + cloture.length;

    res.writeHead(206, {
      'Content-Type': `multipart/byteranges; boundary=${limite}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': total,
    });
    const octets = plages.reduce((s, p) => s + (p.f - p.d + 1), 0);
    console.log('  206  ' + nom + '  ' + plages.length + ' plages, ' + octets + ' octets utiles');

    const fd = fs.openSync(fichier, 'r');
    (function suivante(i) {
      if (i === plages.length) { fs.closeSync(fd); res.end(cloture); return; }
      res.write(entetes[i]);
      const flux = fs.createReadStream('', { fd, start: plages[i].d, end: plages[i].f, autoClose: false });
      flux.on('end', () => suivante(i + 1));
      flux.pipe(res, { end: false });
    })(0);
    return;
  }

  res.writeHead(200, { 'Content-Length': taille, 'Accept-Ranges': 'bytes', 'Content-Type': type });
  console.log('  200  ' + nom + '  ' + taille + ' octets');
  fs.createReadStream(fichier).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log('publication servie sur http://localhost:' + PORT + '/');
});
