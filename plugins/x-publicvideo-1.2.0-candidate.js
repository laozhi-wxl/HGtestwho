export const meta = {
  id: 'hghub.x.publicvideo',
  name: 'X 公开视频',
  version: '1.2.0',
  protocol: 1,
  mature: true,
  description: '关键词搜索 X 公开帖子，筛选真实视频并使用 HGhub 原生播放器播放',
};

const SEARCH_API = 'https://mcp.parallel.ai/mcp';
const SYNDICATION_API = 'https://cdn.syndication.twimg.com/tweet-result';
const MAX_RESULTS = 12;

function fail(hg, code, message) {
  throw new hg.PluginError(code, message);
}

function postIdFromUrl(value) {
  const m = String(value || '').match(/(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{5,25})/i);
  return m ? m[1] : null;
}

async function fetchJson(hg, url, ctx, headers = {}) {
  const r = await hg.http.fetch({
    url,
    headers: { Accept: 'application/json', ...headers },
    responseType: 'json',
    signal: ctx.signal,
  });
  if (!r.ok) fail(hg, 'UPSTREAM_ERROR', '上游接口请求失败（HTTP ' + r.status + '）');
  if (!r.data || typeof r.data !== 'object') fail(hg, 'UPSTREAM_ERROR', '上游返回了无效 JSON');
  return r.data;
}

function mcpText(result) {
  const blocks = Array.isArray(result && result.content) ? result.content : [];
  return blocks.map(x => x && typeof x.text === 'string' ? x.text : '').join('\n');
}

function parseSearchPayload(payload) {
  if (payload.error) throw new Error(payload.error.message || 'Parallel MCP 请求失败');
  const result = payload.result || payload;
  if (result.isError) throw new Error(mcpText(result) || 'Parallel 搜索失败');
  let body = result.structuredContent;
  if (!body) {
    const raw = mcpText(result);
    try { body = JSON.parse(raw); } catch (_) { body = null; }
  }
  const rows = body && Array.isArray(body.results) ? body.results : [];
  const ids = [];
  for (const row of rows) {
    const id = postIdFromUrl(row && row.url);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function searchIds(hg, query, ctx) {
  const payload = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: {
        objective: 'Find public X posts that match this exact user keyword query. Return direct x.com status URLs when available: ' + query,
        search_queries: ['site:x.com ' + query],
      },
    },
  };
  const r = await hg.http.fetch({
    url: SEARCH_API,
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: { json: payload },
    responseType: 'text',
    signal: ctx.signal,
  });
  if (!r.ok) fail(hg, 'UPSTREAM_ERROR', 'Parallel 搜索暂不可用（HTTP ' + r.status + '）');
  const raw = String(r.data || '').trim();
  if (!raw) fail(hg, 'UPSTREAM_ERROR', 'Parallel 搜索返回空响应');
  let parsed = null;
  if (raw.startsWith('{')) {
    try { parsed = JSON.parse(raw); } catch (_) {}
  } else {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try {
        const item = JSON.parse(line.slice(5).trim());
        if (item.result || item.error) { parsed = item; break; }
      } catch (_) {}
    }
  }
  if (!parsed) fail(hg, 'UPSTREAM_ERROR', '无法解析 Parallel MCP 搜索响应');
  try { return parseSearchPayload(parsed).slice(0, MAX_RESULTS); }
  catch (e) { fail(hg, 'UPSTREAM_ERROR', 'X 关键词搜索失败：' + String(e.message || e)); }
}

async function getStatus(hg, id, ctx) {
  const url = SYNDICATION_API + '?id=' + encodeURIComponent(id) + '&token=a';
  const data = await fetchJson(hg, url, ctx, { Referer: 'https://x.com/' });
  if (!data.id_str) fail(hg, 'NOT_FOUND', '帖子不存在、已删除或不可公开访问');
  return data;
}

function videoVariants(status) {
  const details = Array.isArray(status.mediaDetails) ? status.mediaDetails : [];
  if (details.some(x => x && x.type === 'animated_gif')) return [];
  const video = status.video;
  if (!video || !Array.isArray(video.variants)) return [];
  return video.variants.filter(v => {
    if (!v || typeof v.url !== 'string' || !/^https:\/\//i.test(v.url)) return false;
    const type = String(v.content_type || v.contentType || '').toLowerCase();
    return type.includes('mp4') || type.includes('mpegurl') || /\.m3u8(?:[?#]|$)/i.test(v.url);
  }).map(v => {
    const type = String(v.content_type || v.contentType || '').toLowerCase();
    const hls = type.includes('mpegurl') || /\.m3u8(?:[?#]|$)/i.test(v.url);
    return { url: v.url, format: hls ? 'hls' : 'progressive', bitrate: Number(v.bitrate) || 0 };
  });
}

function cardFromStatus(status) {
  const variants = videoVariants(status);
  if (!variants.some(v => v.format === 'progressive' || v.format === 'hls')) return null;
  const user = status.user || {};
  const id = String(status.id_str || status.id);
  const text = String(status.text || '');
  const created = Date.parse(status.created_at || '');
  const details = Array.isArray(status.mediaDetails) ? status.mediaDetails : [];
  const poster = status.video && (status.video.posterImageUrl || status.video.poster_image_url || status.video.posterImage);
  const videoCount = Math.max(1, details.filter(x => x && x.type === 'video').length);
  return {
    id,
    title: text.trim().slice(0, 120) || ('@' + (user.screen_name || 'X') + ' 视频'),
    type: 'short',
    cover: poster || undefined,
    description: text,
    tags: ['X', '公开视频', '@' + (user.screen_name || 'unknown')],
    author: {
      id: String(user.id_str || user.screen_name || 'x'),
      name: String(user.name || user.screen_name || 'X'),
      avatar: user.profile_image_url_https || undefined,
    },
    publishedAt: Number.isFinite(created) ? created : undefined,
    episodeCount: videoCount,
  };
}

async function resolveStatus(hg, id, ctx) {
  return getStatus(hg, id, ctx);
}

export default hg => ({
  search: {
    async search({ query, limit }, ctx) {
      const q = String(query || '').trim();
      if (!q) return { items: [], next: null };
      const directId = postIdFromUrl(q);
      let ids = directId ? [directId] : await searchIds(hg, q, ctx);
      const cap = Math.min(Math.max(Number(limit) || 20, 1), MAX_RESULTS);
      const statuses = await Promise.all(ids.slice(0, cap).map(async id => {
        try { return await getStatus(hg, id, ctx); } catch (_) { return null; }
      }));
      const items = statuses.map(s => s && cardFromStatus(s)).filter(Boolean);
      return { items, next: null };
    },
  },
  media: {
    async getDetail({ id }, ctx) {
      const status = await resolveStatus(hg, id, ctx);
      const card = cardFromStatus(status);
      if (!card) fail(hg, 'NOT_FOUND', '这条帖子没有可播放的真实视频');
      return {
        ...card,
        playlists: [{
          id: 'videos',
          label: '视频',
          kind: 'main',
          episodes: [{ id: 'video-0', index: 1, label: '播放' }],
        }],
      };
    },
    async resolvePlayback({ mediaId }, ctx) {
      const status = await resolveStatus(hg, mediaId, ctx);
      const card = cardFromStatus(status);
      if (!card) fail(hg, 'NOT_FOUND', '这条帖子没有可播放的视频');
      const variants = videoVariants(status);
      const streams = variants.map(v => ({
        url: v.url,
        format: v.format,
        label: v.format === 'hls' ? 'HLS' : 'MP4',
        bitrate: v.bitrate || undefined,
      }));
      if (!streams.length) fail(hg, 'UNSUPPORTED', '没有可供 HGhub 原生播放器使用的 MP4/HLS 视频流');
      return {
        streams,
        durationSec: status.video && Number(status.video.durationMs) > 0
          ? Number(status.video.durationMs) / 1000 : undefined,
      };
    },
  },
});
