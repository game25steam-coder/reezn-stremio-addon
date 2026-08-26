'use strict';
// Minimal port of com.rmedia.rplayer.extractors.VixSrcExtractor (smali-verified logic)
// API -> embed page -> scrape window.video globals -> master playlist URL
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function mask(s) { return s ? String(s).slice(0, 4) + '***(' + s.length + ')' : 'NONE'; }

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://vixsrc.to',
    },
  });
  if (!r.ok) throw new Error(`api HTTP ${r.status}`);
  return r.json();
}

async function getText(url, referer) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: 'follow',
  });
  return { status: r.status, text: await r.text() };
}

function safeDate(unix) {
  const n = Number(unix);
  if (!n) return 'unknown';
  return new Date(n * 1000).toISOString();
}

async function resolveMovie(tmdbId) {
  console.log(`[STREMIO] Resolver: VixSrc start for tmdb=${tmdbId}`);
  const meta = await getJson(`https://vixsrc.to/api/movie/${tmdbId}?lang=en`);
  if (!meta || !meta.src) throw new Error('api response missing src');
  const embedUrl = `https://vixsrc.to${meta.src}`;
  console.log('[STREMIO] Source found: VixSrc');

  // retry once on HTTP 410 like the app does
  let page = await getText(embedUrl, 'https://vixsrc.to');
  if (page.status === 410) {
    const meta2 = await getJson(`https://vixsrc.to/api/movie/${tmdbId}?lang=en`);
    page = await getText(`https://vixsrc.to${meta2.src}`, 'https://vixsrc.to');
  }
  if (page.status !== 200) throw new Error(`embed HTTP ${page.status}`);

  const id = (page.text.match(/id:\s*'([^']+)'/) || [])[1];
  const token = (page.text.match(/'token':\s*'([^']+)'/) || [])[1];
  const expires = (page.text.match(/'expires':\s*'([^']+)'/) || [])[1];
  const canPlayFHD = page.text.includes('window.canPlayFHD = true');
  const hasB1 = page.text.includes('b=1');
  if (!id || !token || !expires) throw new Error('failed to extract exact tokens');
  console.log(`[STREMIO] Internal ID: ${id} (token=${mask(token)} expires=${mask(expires)} valid-until=${safeDate(expires)})`);

  const url = `https://vixsrc.to/playlist/${id}?token=${token}&expires=${expires}${hasB1 ? '&b=1' : ''}${canPlayFHD ? '&h=1' : ''}&lang=en`;

  // verify playlist is actually fetchable with the headers we hand to Stremio
  const pl = await getText(url, embedUrl);
  const isHls = pl.text.includes('#EXTM3U');
  const variants = (pl.text.match(/#EXT-X-STREAM-INF/g) || []).length;
  const audio = (pl.text.match(/#EXT-X-MEDIA:TYPE=AUDIO/g) || []).length;
  console.log(`[STREMIO] Resolver: ${isHls ? 'SUCCESS' : 'FAILED'} | type=${isHls ? 'HLS' : 'UNKNOWN'} http=${pl.status} variants=${variants} audioTracks=${audio}`);
  if (!isHls) throw new Error(`playlist not HLS (HTTP ${pl.status})`);

  return {
    internalId: id,
    url,
    headers: { 'User-Agent': UA, Referer: embedUrl, Origin: 'https://vixsrc.to' },
    expiresAt: safeDate(expires),
    quality: canPlayFHD ? 'up to FHD (adaptive)' : 'HD (adaptive)',
    variants,
  };
}

async function resolveSeries(tmdbId, season, episode) {
  console.log(`[STREMIO] Resolver: VixSrc start for tmdb=${tmdbId} S${season}E${episode}`);
  const meta = await getJson(`https://vixsrc.to/api/tv/${tmdbId}/${season}/${episode}?lang=en`);
  if (!meta || !meta.src) throw new Error('api response missing src');
  const embedUrl = `https://vixsrc.to${meta.src}`;
  console.log('[STREMIO] Source found: VixSrc');
  const page = await getText(embedUrl, 'https://vixsrc.to');
  if (page.status !== 200) throw new Error(`embed HTTP ${page.status}`);
  const id = (page.text.match(/id:\s*'([^']+)'/) || [])[1];
  const token = (page.text.match(/'token':\s*'([^']+)'/) || [])[1];
  const expires = (page.text.match(/'expires':\s*'([^']+)'/) || [])[1];
  const canPlayFHD = page.text.includes('window.canPlayFHD = true');
  const hasB1 = page.text.includes('b=1');
  if (!id || !token || !expires) throw new Error('failed to extract exact tokens');
  console.log(`[STREMIO] Internal ID: ${id} (episode-level, token=${mask(token)} valid-until=${safeDate(expires)})`);
  const url = `https://vixsrc.to/playlist/${id}?token=${token}&expires=${expires}${hasB1 ? '&b=1' : ''}${canPlayFHD ? '&h=1' : ''}&lang=en`;
  const pl = await getText(url, embedUrl);
  const isHls = pl.text.includes('#EXTM3U');
  console.log(`[STREMIO] Resolver: ${isHls ? 'SUCCESS' : 'FAILED'} | type=${isHls ? 'HLS' : 'UNKNOWN'} http=${pl.status}`);
  if (!isHls) throw new Error(`playlist not HLS (HTTP ${pl.status})`);
  return {
    internalId: id,
    url,
    headers: { 'User-Agent': UA, Referer: embedUrl, Origin: 'https://vixsrc.to' },
    expiresAt: safeDate(expires),
    quality: canPlayFHD ? 'up to FHD (adaptive)' : 'HD (adaptive)',
  };
}

module.exports = { resolveMovie, resolveSeries };
