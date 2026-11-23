export const meta = {
  id: 'hghub.x.publicvideo',
  name: 'X 公开视频',
  version: '2.0.1',
  protocol: 1,
  mature: true,
  description: '关键词搜索 X 公开帖子，只收录含真实 MP4/HLS 视频流的帖子，并使用 HGhub 原生播放器',
};

const SEARCH_API = 'https://mcp.parallel.ai/mcp';
const TWEET_API = 'https://cdn.syndication.twimg.com/tweet-result';

function fail(hg, code, message) {
  throw new hg.PluginError(code, message);
}

function postIdFromUrl(value) {
  const m = String(value || '').match(/(?:x|twitter)\.com\/[^\s/]+\/status(?:es)?\/(\d{2,25})/i);
  return m ? m[1] : null;
}

async function fetchText(hg, url, ctx, options = {}) {
  const r = await hg.http.fetch({
    url,
    method: options.method || 'GET',
    headers: options.headers || { Accept: 'application/json' },
    body: options.body,
    responseType: 'text',
    signal: ctx.signal,
  });
  if (!r.ok) fail(hg, 'UPSTREAM_ERROR', '上游请求失败（HTTP ' + r.status + '）');
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
}

function parseJsonOrSse(body) {
  const raw = String(body || '').trim();
  if (!raw) throw new Error('empty response');
  if (raw[0] === '{') return JSON.parse(raw);
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const item = JSON.parse(line.slice(5).trim());
      if (item && (item.result || item.error)) return item;
    } catch (_) {}
  }
  throw new Error('unrecognized MCP response');
}

function unwrapMcp(payload) {
  if (payload.error) throw new Error(payload.error.message || 'MCP error');
  const result = payload.result || payload;
  if (result.isError) {
    const msg = (result.content || []).map(x => x.text || '').join(' ');
    throw new Error(msg || 'Search tool error');
  }
  let structured = result.structuredContent;
  if (!structured) {
    const text = (result.content || []).map(x => x.text || '').join('\n');
    try { structured = JSON.parse(text); } catch (_) { structured = {}; }
  }
  return structured || {};
}

function extractHits(data) {
  const rows = Array.isArray(data.results) ? data.results : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const url = String(row && row.url || '');
    const m = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{2,25})/i);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ id: m[2], username: m[1], title: String(row.title || ''), snippet: (row.excerpts || []).join(' ') });
  }
  return out;
}

async function searchX(hg, query, ctx) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: {
        objective: 'Find public X/Twitter posts matching the following keyword query. Return direct x.com status URLs only: ' + query,
        search_queries: [query + ' site:x.com'],
      },
    },
  };
  const body = await fetchText(hg, SEARCH_API, ctx, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  return extractHits(unwrapMcp(parseJsonOrSse(body)));
}

async function getTweet(hg, id, ctx) {
  const url = TWEET_API + '?id=' + encodeURIComponent(id) + '&token=a&lang=en';
  const body = await fetchText(hg, url, ctx);
  let raw;
  try { raw = JSON.parse(body); } catch (_) { fail(hg, 'UPSTREAM_ERROR', 'X 公开视频数据不是有效 JSON'); }
  if (!raw || !raw.id_str) fail(hg, 'NOT_FOUND', '帖子不存在、已删除或不可公开访问');
  return raw;
}

function realVideos(raw) {
  const video = raw.video;
  if (!video || !Array.isArray(video.variants)) return [];
  const streams = video.variants.filter(v =>
    v && typeof v.url === 'string' && /^https:\/\//i.test(v.url) &&
    (v.content_type === 'video/mp4' || v.content_type === 'application/x-mpegURL' ||
     v.content_type === 'application/vnd.apple.mpegurl')
  );
  if (!streams.length) return [];
  return [{ video, streams }];
}

function timestamp(value) {
  const n = Date.parse(value || '');
  return Number.isFinite(n) ? n : undefined;
}

function cardFromTweet(raw) {
  const videos = realVideos(raw);
  if (!videos.length) return null;
  const user = raw.user || {};
  const username = String(user.screen_name || 'X');
  return {
    id: String(raw.id_str),
    title: String(raw.text || '').trim().slice(0, 120) || ('@' + username + ' 视频'),
    type: 'short',
    cover: raw.video && (raw.video.posterImageUrl || raw.video.poster_image_url || raw.video.posterImage) || undefined,
    description: String(raw.text || ''),
    tags: ['X', '公开视频', '@' + username],
    author: {
      id: String(user.id_str || username),
      name: String(user.name || username),
      avatar: user.profile_image_url_https || undefined,
    },
    publishedAt: timestamp(raw.created_at),
    episodeCount: videos.length,
  };
}

function streamsFor(video, maxHeight) {
  const max = Number(maxHeight) || 0;
  const usable = video.variants.filter(v => {
    if (!v || typeof v.url !== 'string' || !/^https:\/\//i.test(v.url)) return false;
    return v.content_type === 'video/mp4' ||
      v.content_type === 'application/x-mpegURL' ||
      v.content_type === 'application/vnd.apple.mpegurl';
  });
  usable.sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));
  const result = [];
  for (const item of usable) {
    const hls = item.content_type !== 'video/mp4';
    if (result.some(s => s.url === item.url)) continue;
    result.push({
      url: item.url,
      format: hls ? 'hls' : 'progressive',
      label: hls ? 'HLS' : (item.bitrate ? Math.round(item.bitrate / 1000) + ' kbps' : 'MP4'),
      bitrate: Number(item.bitrate) || undefined,
    });
  }
  return result;
}

export default hg => ({
  search: {
    async search({ query, cursor, limit }, ctx) {
      const q = String(query || '').trim();
      if (!q) return { items: [], next: null };
      const directId = postIdFromUrl(q);
      const count = Math.min(Math.max(Number(limit) || 20, 1), 30);
      let hits;
      if (directId) {
        hits = [{ id: directId }];
      } else {
        try { hits = await searchX(hg, q, ctx); }
        catch (error) {
          fail(hg, 'UPSTREAM_ERROR', 'X 关键词搜索暂时失败：' + String(error && error.message || error).slice(0, 180));
        }
      }
      const offset = Math.max(0, Number(cursor) || 0);
      const selected = hits.slice(offset, offset + count);
      const items = [];
      for (const hit of selected) {
        try {
          const raw = await getTweet(hg, hit.id, ctx);
          const card = cardFromTweet(raw);
          if (card) items.push(card);
        } catch (error) {
          if (ctx.signal && ctx.signal.aborted) throw error;
        }
      }
      const next = offset + count < hits.length ? String(offset + count) : null;
      return { items, next };
    },
  },

  media: {
    async getDetail({ id }, ctx) {
      const raw = await getTweet(hg, String(id), ctx);
      const card = cardFromTweet(raw);
      if (!card) fail(hg, 'NOT_FOUND', '这条帖子没有真实 MP4/HLS 视频流（图片和 GIF 已过滤）');
      const videos = realVideos(raw);
      return {
        ...card,
        playlists: [{
          id: 'videos',
          label: '视频',
          kind: 'main',
          episodes: videos.map((entry, i) => ({
            id: 'video-' + i,
            index: i + 1,
            label: videos.length > 1 ? '视频 ' + (i + 1) : '播放',
            durationSec: Number(entry.video.durationMs || 0) / 1000 || undefined,
            thumbnail: card.cover,
          })),
        }],
      };
    },

    async resolvePlayback({ mediaId, episodeId, maxHeight }, ctx) {
      const raw = await getTweet(hg, String(mediaId), ctx);
      const videos = realVideos(raw);
      const match = String(episodeId || '').match(/^video-(\d+)$/);
      const index = match ? Number(match[1]) : 0;
      const entry = videos[index];
      if (!entry) fail(hg, 'NOT_FOUND', '视频分集不存在或已不可用');
      const streams = streamsFor(entry.video, maxHeight);
      if (!streams.length) fail(hg, 'UNSUPPORTED', '该帖子没有可用的 MP4/HLS 视频流');
      return {
        streams,
        durationSec: Number(entry.video.durationMs || 0) / 1000 || undefined,
      };
    },
  },
});
