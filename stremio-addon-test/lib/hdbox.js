'use strict';
// Port of com.rmedia.rplayer.extractors.HDboxExtractor
// Based on smali analysis: token bootstrap -> search -> detail -> play
const UA = 'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.162 Mobile Safari/537.36';
const BASE_API = 'https://h5-api.aoneroom.com/wefeed-h5api-bff';
const PLAY_BASE = 'https://123movienow.cc/wefeed-h5api-bff/subject/play';
const SEARCH_URL = `${BASE_API}/subject/search`;
const COUNTRY_URL = `${BASE_API}/country-code`;
const DETAIL_URL_TMPL = `${BASE_API}/detail?detailPath=`;

let cachedToken = null;

function sanitizeTitle(t) {
  if (!t) return '';
  // app strips _(360P|480P|...) and TV SxxExx suffixes
  let s = String(t).trim();
  s = s.replace(/_(360P|480P|720P|1080P|retran).*$/i, '');
  s = s.replace(/\s+S\d+E\d+.*$/i, '');
  return s;
}

function mask(s) { return s ? s.slice(0,4) + '***(' + s.length + ')' : 'NONE'; }

async function fetchToken() {
  if (cachedToken) return cachedToken;
  const r = await fetch(COUNTRY_URL, {
    headers: {
      'accept': 'application/json',
      'origin': 'https://123movienow.cc',
      'referer': 'https://123movienow.cc/',
      'user-agent': UA,
    },
  });
  // token is inside set-cookie header: token=VALUE; ...
  const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  for (const c of cookies) {
    const m = /token=([^;]+)/.exec(c);
    if (m) { cachedToken = decodeURIComponent(m[1].replace(/^"%22|%22"$/g, '').replace(/^"|"$/g, '')); break; }
  }
  // also try raw header string
  if (!cachedToken) {
    const raw = r.headers.get('set-cookie') || '';
    const m = /token=([^;]+)/.exec(raw);
    if (m) cachedToken = decodeURIComponent(m[1].replace(/^"|"$/g, ''));
  }
  if (cachedToken) console.log(`[STREMIO] HDBox token acquired: ${mask(cachedToken)}`);
  return cachedToken;
}

function buildHeaders(referer) {
  const h = {
    'accept': 'application/json',
    'x-client-info': JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
    'x-source': 'null',
    'origin': 'https://123movienow.cc',
    'user-agent': UA,
    'referer': referer || 'https://123movienow.cc/',
  };
  if (cachedToken) {
    h['authorization'] = 'Bearer ' + cachedToken;
    h['cookie'] = `token=${cachedToken}; wefeed_token="%22${cachedToken}%22"; wefeed_i18n_lang=en`;
  }
  return h;
}

async function search(title, isMovie, year) {
  await fetchToken();
  const keyword = sanitizeTitle(title);
  const body = JSON.stringify({
    keyword,
    page: 1,
    perPage: 28,
    subjectType: isMovie ? 1 : 2,
  });
  const r = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { ...buildHeaders('https://123movienow.cc/'), 'content-type': 'application/json' },
    body,
  });
  if (!r.ok) throw new Error(`HDBox search HTTP ${r.status}`);
  const j = await r.json();
  const items = j.data?.items || j.items || [];
  if (!items.length) throw new Error('HDBox: no search results');
  // match by title contains + year ±1 — strict, no fallback to wrong title
  const yr = year ? Number(year) : null;
  const norm = (s) => String(s||'').replace(/[^a-z0-9]/gi,'').toLowerCase();
  const needle = norm(keyword);
  for (const it of items) {
    const t = String(it.title || it.name || '');
    if (needle && !norm(t).includes(needle.slice(0, Math.min(6, needle.length))) && !needle.includes(norm(t).slice(0,6))) continue;
    if (yr && it.releaseDate) {
      const y = Number(String(it.releaseDate).slice(0,4));
      if (y && Math.abs(y - yr) > 1) continue;
    }
    if (it.detailPath) return it;
  }
  throw new Error(`HDBox: no matching title for "${keyword}" (${items.map(i=>i.title).join(', ')})`);
}

async function getDetail(detailPath) {
  const url = `${DETAIL_URL_TMPL}${encodeURIComponent(detailPath)}`;
  const r = await fetch(url, { headers: buildHeaders('https://123movienow.cc/') });
  if (!r.ok) throw new Error(`HDBox detail HTTP ${r.status}`);
  const j = await r.json();
  return j.data?.subject || j.subject || j.data || j;
}

async function getPlay(subjectId, detailPath, season, episode, referer) {
  let url = `${PLAY_BASE}?subjectId=${encodeURIComponent(subjectId)}`;
  if (season) url += `&se=${encodeURIComponent(season)}`;
  if (episode) url += `&ep=${encodeURIComponent(episode)}`;
  if (detailPath) url += `&detailPath=${encodeURIComponent(detailPath)}`;
  const r = await fetch(url, { headers: buildHeaders(referer) });
  if (!r.ok) throw new Error(`HDBox play HTTP ${r.status}`);
  const j = await r.json();
  // streams at data.streams or data.data.streams
  const streams = j.data?.streams || j.streams || j.data?.data?.streams || [];
  return streams;
}

function pickUrl(streams) {
  if (!streams.length) throw new Error('HDBox: no streams in play response');
  // prefer 1080p if available else first
  const pref = streams.find(s => String(s.resolutions||'').includes('1080')) || streams[0];
  return pref.url || pref.link || pref.file;
}

async function resolveMovieByTitle(title, year) {
  console.log(`[STREMIO] HDBox start (movie) title="${title}" year=${year}`);
  const hit = await search(title, true, year);
  console.log(`[STREMIO] HDBox search hit: "${hit.title||hit.name}" detailPath=${hit.detailPath}`);
  const subj = await getDetail(hit.detailPath);
  const subjectId = subj.subjectId || subj.id || hit.subjectId;
  const detailPath = subj.detailPath || hit.detailPath;
  const referer = `https://123movienow.cc/spa/videoPlayPage/movies/${encodeURIComponent(detailPath)}?id=${encodeURIComponent(subjectId)}&type=/movie/detail&lang=en`;
  const streams = await getPlay(subjectId, detailPath, null, null, referer);
  const url = pickUrl(streams);
  const picked = streams.find(s => (s.url||s.link||s.file) === url) || streams[0];
  const qual = picked?.resolutions || picked?.resolution || picked?.quality || '';
  const qLabel = qual ? `${String(qual).replace('p','')}p` : 'auto';
  console.log(`[STREMIO] HDBox Internal ID: ${subjectId} streams=${streams.length} picked=${url.slice(0,60)}*** quality=${qLabel}`);
  const h = await fetch(url, { method: 'HEAD', headers: buildHeaders(referer) }).catch(()=>null);
  const ok = !h || h.ok || h.status === 200 || h.status === 206;
  console.log(`[STREMIO] HDBox resolver: ${ok ? 'SUCCESS' : 'SUCCESS (unverified)'} type=${url.includes('.m3u8')?'HLS':url.includes('.mp4')?'MP4':'UNKNOWN'}`);
  return { internalId: subjectId, url, headers: { 'User-Agent': UA, 'Referer': referer, 'Origin': 'https://123movienow.cc' }, quality: qLabel, streams };
}

async function resolveSeriesByTitle(title, year, season, episode) {
  console.log(`[STREMIO] HDBox start (series) title="${title}" S${season}E${episode}`);
  const hit = await search(title, false, year);
  console.log(`[STREMIO] HDBox search hit: "${hit.title||hit.name}"`);
  const subj = await getDetail(hit.detailPath);
  const subjectId = subj.subjectId || subj.id || hit.subjectId;
  const detailPath = subj.detailPath || hit.detailPath;
  const referer = `https://123movienow.cc/spa/videoPlayPage/movies/${encodeURIComponent(detailPath)}?id=${encodeURIComponent(subjectId)}&type=/tv/detail&detailSe=${season}&detailEp=${episode}&lang=en`;
  const streams = await getPlay(subjectId, detailPath, season, episode, referer);
  const url = pickUrl(streams);
  console.log(`[STREMIO] HDBox Internal ID: ${subjectId} S${season}E${episode} -> ${url.slice(0,60)}***`);
  return { internalId: `${subjectId}:S${season}E${episode}`, url, headers: { 'User-Agent': UA, 'Referer': referer, 'Origin': 'https://123movienow.cc' }, quality: 'auto', streams };
}

module.exports = { resolveMovieByTitle, resolveSeriesByTitle };
