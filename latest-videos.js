// Netlify Function: GET /api/latest-videos  (див. netlify.toml)
// Env: YOUTUBE_API_KEY (секрет, тільки на сервері), YOUTUBE_CHANNEL_ID (UC...)
const API = 'https://www.googleapis.com/youtube/v3';
const TTL = 2 * 60 * 60 * 1000; // 2 години
let cache = null;               // { at, videos }
let uploadsId = null;

async function yt(path, params, key) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('YouTube API status ' + r.status); // URL не логуємо: там ключ
    return await r.json();
  } finally { clearTimeout(timer); }
}

const bestThumb = (t = {}) => {
  const x = t.maxres || t.standard || t.high || t.medium || t.default;
  return x && x.url ? x.url : null;
};

async function fetchLatest(key, channelId) {
  if (!uploadsId) {
    const ch = await yt('/channels', { part: 'contentDetails', id: channelId }, key);
    uploadsId = ch.items && ch.items[0] && ch.items[0].contentDetails.relatedPlaylists.uploads;
    if (!uploadsId) throw new Error('Channel or uploads playlist not found');
  }
  const pl = await yt('/playlistItems', { part: 'snippet,contentDetails', playlistId: uploadsId, maxResults: '3' }, key);
  return (pl.items || [])
    .filter(it => it.snippet && it.contentDetails && it.contentDetails.videoId
      && !/^(Private|Deleted) video$/i.test(it.snippet.title) && bestThumb(it.snippet.thumbnails))
    .map(it => ({
      id: it.contentDetails.videoId,
      title: it.snippet.title,
      thumbnail: bestThumb(it.snippet.thumbnails),
      publishedAt: it.contentDetails.videoPublishedAt || it.snippet.publishedAt
    }))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

const reply = (statusCode, body, cacheControl) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  body: JSON.stringify(body)
});
const CACHED = 'public, max-age=300, s-maxage=7200, stale-while-revalidate=3600';

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'method_not_allowed' }, 'no-store');
  const key = process.env.YOUTUBE_API_KEY;
  const channelId = process.env.YOUTUBE_CHANNEL_ID;
  if (!key || !/^UC[\w-]{22}$/.test(channelId || '')) return reply(500, { error: 'not_configured' }, 'no-store');
  if (cache && Date.now() - cache.at < TTL) return reply(200, { videos: cache.videos }, CACHED);
  try {
    const videos = await fetchLatest(key, channelId);
    cache = { at: Date.now(), videos };
    return reply(200, { videos }, CACHED);
  } catch (e) {
    console.error('latest-videos failed:', e.message);
    if (cache) return reply(200, { videos: cache.videos, stale: true }, 'public, s-maxage=300');
    return reply(502, { error: 'upstream_failed' }, 'no-store');
  }
};
