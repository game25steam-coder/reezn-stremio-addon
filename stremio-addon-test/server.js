'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { resolveMovie, resolveSeries } = require('./lib/vixsrc');
const { resolveMovieByTitle, resolveSeriesByTitle } = require('./lib/hdbox');

const PORT = process.env.PORT ? Number(process.env.PORT) : 7000;
const HOST = process.env.HOST || '0.0.0.0';
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();
const metaCache = new Map();
function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() > e.at + CACHE_TTL_MS) { map.delete(key); return null; }
  return e;
}
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout ${ms}ms`)), ms)),
  ]);
}

async function imdbToTmdb(type, imdbId) {
  const ck = `${type}:${imdbId}`;
  const hit = cacheGet(metaCache, ck);
  if (hit) return hit;
  const url = `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cinemeta HTTP ${r.status}`);
  const data = await r.json();
  const meta = data.meta || data;
  const tmdb = meta.moviedb_id;
  if (!tmdb) throw new Error(`no TMDB mapping for ${imdbId} (${meta.name || '?'})`);
  const out = { tmdb: String(tmdb), name: meta.name, year: meta.year || meta.releaseInfo?.split('-')[0] || null };
  metaCache.set(ck, { ...out, at: Date.now() });
  return out;
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function handleStream(req, res, type, idParts) {
  const t0 = Date.now();
  const cacheKey = `${type}:${idParts.join(':')}`;
  const cHit = cacheGet(cache, cacheKey);
  if (cHit) {
    console.log(`[STREMIO] Requested: ${idParts[0]} (${type}) — CACHE HIT (${cHit.streams.length} stream(s), age ${Math.round((Date.now()-cHit.at)/1000)}s)`);
    return send(res, 200, { streams: cHit.streams });
  }
  try {
    let imdbId, tmdb, name, year, streams = [];
    if (type === 'movie') {
      imdbId = idParts[0];
      console.log(`[STREMIO] Requested: ${imdbId} (movie)`);
      const m = await imdbToTmdb('movie', imdbId);
      tmdb = m.tmdb; name = m.name; year = m.year;
      console.log(`[STREMIO] Detected movie: "${name}" | tmdb=${tmdb} year=${year}`);
      const results = await Promise.allSettled([
        withTimeout(resolveMovie(tmdb).then(r => ({ source: 'VixSrc', ...r })), 12000, 'VixSrc'),
        withTimeout(resolveMovieByTitle(name, year).then(r => ({ source: 'HDBox', ...r })), 15000, 'HDBox'),
      ]);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.source === 'HDBox' && v.streams && v.streams.length > 1) {
            for (const sq of v.streams) {
              const qRaw = String(sq.resolutions || sq.resolution || '').replace('p','');
              const qLabel = qRaw ? `${qRaw}p` : 'auto';
              const qUrl = sq.url || sq.link || sq.file;
              const isMp4 = String(qUrl).includes('.mp4');
              let streamUrl = qUrl;
              if (isMp4) {
                const host = req.headers.host || `localhost:${PORT}`;
                const proto = req.headers['x-forwarded-proto'] || 'http';
                const q = new URLSearchParams({ u: qUrl, Referer: v.headers.Referer || v.headers.referer || '', Origin: v.headers.Origin || v.headers.origin || '', 'User-Agent': v.headers['User-Agent'] || v.headers['user-agent'] || '' });
                streamUrl = `${proto}://${host}/proxy?${q.toString()}`;
              }
              streams.push({ name: `Reezn HDBox ${qLabel}`, title: `${name} • ${qLabel}`, url: streamUrl });
            }
            console.log(`[STREMIO] HDBox: SUCCESS ${v.streams.length} qualities: ${v.streams.map(s=>String(s.resolutions||s.resolution)+'p').join(', ')}`);
          } else {
            const isMp4 = v.url.includes('.mp4');
            console.log(`[STREMIO] ${v.source}: SUCCESS internal=${v.internalId} type=${v.url.includes('.m3u8')?'HLS':isMp4?'MP4':'UNKNOWN'}`);
            let streamUrl = v.url;
            let streamHeaders = v.headers;
            if (isMp4 && v.source === 'HDBox') {
              const host = req.headers.host || `localhost:${PORT}`;
              const proto = req.headers['x-forwarded-proto'] || 'http';
              const q = new URLSearchParams({ u: v.url, Referer: v.headers.Referer || v.headers.referer || '', Origin: v.headers.Origin || v.headers.origin || '', 'User-Agent': v.headers['User-Agent'] || v.headers['user-agent'] || '' });
              streamUrl = `${proto}://${host}/proxy?${q.toString()}`;
              streamHeaders = undefined;
              console.log(`[STREMIO] HDBox proxied -> ${streamUrl.slice(0,80)}...`);
            }
            streams.push({ name: `Reezn ${v.source}`, title: `${v.quality} | ${name} • ${v.source} • ${v.url.includes('.m3u8')?'HLS':'MP4'}`, url: streamUrl, ...(streamHeaders ? { headers: streamHeaders } : {}) });
          }
        } else {
          console.log(`[STREMIO] ${r.reason?.message?.includes('HDBox') ? 'HDBox' : 'VixSrc'}: FAILED ${r.reason.message}`);
        }
      }
    } else {
      const [id, season, episode] = idParts;
      imdbId = id;
      console.log(`[STREMIO] Requested: ${imdbId} S${season}E${episode} (series)`);
      const m = await imdbToTmdb('series', imdbId);
      tmdb = m.tmdb; name = m.name; year = m.year;
      console.log(`[STREMIO] Detected series: "${name}" | tmdb=${tmdb} year=${year}`);
      const results = await Promise.allSettled([
        withTimeout(resolveSeries(tmdb, season, episode).then(r => ({ source: 'VixSrc', ...r })), 12000, 'VixSrc'),
        withTimeout(resolveSeriesByTitle(name, year, season, episode).then(r => ({ source: 'HDBox', ...r })), 15000, 'HDBox'),
      ]);
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const v = r.value;
          if (v.source === 'HDBox' && v.streams && v.streams.length > 1) {
            for (const sq of v.streams) {
              const qRaw = String(sq.resolutions || sq.resolution || '').replace('p','');
              const qLabel = qRaw ? `${qRaw}p` : 'auto';
              const qUrl = sq.url || sq.link || sq.file;
              const isMp4 = String(qUrl).includes('.mp4');
              let streamUrl = qUrl;
              if (isMp4) {
                const host = req.headers.host || `localhost:${PORT}`;
                const proto = req.headers['x-forwarded-proto'] || 'http';
                const q = new URLSearchParams({ u: qUrl, Referer: v.headers.Referer || v.headers.referer || '', Origin: v.headers.Origin || v.headers.origin || '', 'User-Agent': v.headers['User-Agent'] || v.headers['user-agent'] || '' });
                streamUrl = `${proto}://${host}/proxy?${q.toString()}`;
              }
              streams.push({ name: `Reezn HDBox ${qLabel}`, title: `${name} S${season}E${episode} • ${qLabel}`, url: streamUrl });
            }
          } else {
            const isMp4 = v.url.includes('.mp4');
            let streamUrl = v.url;
            let streamHeaders = v.headers;
            if (isMp4 && v.source === 'HDBox') {
              const host = req.headers.host || `localhost:${PORT}`;
              const proto = req.headers['x-forwarded-proto'] || 'http';
              const q = new URLSearchParams({ u: v.url, Referer: v.headers.Referer || v.headers.referer || '', Origin: v.headers.Origin || v.headers.origin || '', 'User-Agent': v.headers['User-Agent'] || v.headers['user-agent'] || '' });
              streamUrl = `${proto}://${host}/proxy?${q.toString()}`;
              streamHeaders = undefined;
            }
            streams.push({ name: `Reezn ${v.source}`, title: `${name} S${season}E${episode} • ${v.quality}`, url: streamUrl, ...(streamHeaders ? { headers: streamHeaders } : {}) });
          }
        } else {
          console.log(`[STREMIO] FAILED ${r.reason.message}`);
        }
      }
    }
    if (!streams.length) throw new Error('all resolvers failed');
    cache.set(cacheKey, { streams, at: Date.now() });
    send(res, 200, { streams });
    console.log(`[STREMIO] Done in ${Date.now() - t0}ms — ${streams.length} stream(s) — cached 24h`);
  } catch (err) {
    console.log(`[STREMIO] Resolver FAILED: ${err.message}`);
    send(res, 200, { streams: [] });
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);
  console.log(`[REQ] ${req.method} ${u.pathname}${u.search} -> ${pathname}`);
  let m;
  if (pathname === '/manifest.json') return send(res, 200, MANIFEST);
  if (u.pathname === '/proxy') {
    const target = u.searchParams.get('u');
    if (!target) return send(res, 400, { err: 'missing u' });
    const headers = {};
    for (const k of ['Referer','Origin','User-Agent','referer','origin','user-agent']) {
      const v = u.searchParams.get(k);
      if (v) headers[k] = v;
    }
    const range = req.headers.range;
    if (range) headers['Range'] = range;
    fetch(target, { headers, redirect: 'follow' }).then(r => {
      const h = {};
      for (const [k,v] of r.headers) {
        if (['content-type','content-length','accept-ranges','content-range','cache-control'].includes(k.toLowerCase())) h[k] = v;
      }
      res.writeHead(r.status, h);
      if (req.method === 'HEAD' || !r.body) return res.end();
      const { Readable } = require('stream');
      try { Readable.fromWeb(r.body).pipe(res); } catch { r.body.pipeTo(new WritableStream({ write(c){ res.write(c); }, close(){ res.end(); } })); }
    }).catch(e => { console.log('[PROXY] fetch failed', e.message); try{ send(res, 502, { err: e.message }); }catch{} });
    return;
  }
  if ((m = pathname.match(/^\/stream\/movie\/([^/]+)\.json$/))) return handleStream(req, res, 'movie', m[1].split('/'));
  if ((m = pathname.match(/^\/stream\/series\/([^/]+)\/(\d+)\/(\d+)\.json$/))) return handleStream(req, res, 'series', m[1].split('/').concat(m[2], m[3]));
  if ((m = pathname.match(/^\/stream\/series\/([^:]+):(\d+):(\d+)\.json$/))) return handleStream(req, res, 'series', [m[1], m[2], m[3]]);
  send(res, 404, { err: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`[STREMIO] Add-on listening on http://${HOST}:${PORT}`);
  console.log('[STREMIO] Manifest:        http://localhost:' + PORT + '/manifest.json');
});
