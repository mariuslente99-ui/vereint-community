import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(process.cwd());
const port = Number(process.env.PORT || 4173);
const types = {
  '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp',
  '.svg':'image/svg+xml', '.mp4':'video/mp4', '.m4v':'video/mp4', '.mov':'video/quicktime', '.webm':'video/webm',
  '.heic':'image/heic'
};

function noCacheHeaders(contentType){
  return {
    'Content-Type': contentType,
    'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma':'no-cache',
    'Expires':'0',
    'Surrogate-Control':'no-store',
    'Accept-Ranges':'bytes'
  };
}

function eventSlugs(){
  const eventsDir = join(root, 'events');
  if (!existsSync(eventsDir)) return [];
  return readdirSync(eventsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => existsSync(join(eventsDir, slug, 'event.json')))
    .sort();
}

function sendFile(req, res, file, contentType){
  const stat = statSync(file);
  const range = req.headers.range;

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, {
          ...noCacheHeaders(contentType),
          'Content-Range': `bytes */${stat.size}`
        });
        res.end();
        return;
      }
      res.writeHead(206, {
        ...noCacheHeaders(contentType),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    ...noCacheHeaders(contentType),
    'Content-Length': stat.size
  });
  createReadStream(file).pipe(res);
}

createServer((req,res)=>{
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === '/events/manifest.json') {
    res.writeHead(200, noCacheHeaders('application/json; charset=utf-8'));
    res.end(JSON.stringify(eventSlugs(), null, 2));
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safe = normalize(pathname).replace(/^([/\\]*\.\.[/\\])+/, '');
  const file = resolve(join(root, safe));

  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, noCacheHeaders('text/plain; charset=utf-8'));
    res.end(`Not found: ${pathname}`);
    return;
  }

  sendFile(req, res, file, types[extname(file).toLowerCase()] || 'application/octet-stream');
}).listen(port, () => {
  console.log(`vereint local server läuft: http://localhost:${port}`);
  console.log('Events: event.json ändern → Browser refresh → Anzeige passt sofort.');
  console.log('Video: aftermovie.mp4 muss direkt neben index.html liegen.');
  console.log('Stoppen: CTRL + C im Terminal. Danach mit npm start erneut starten.');
});
