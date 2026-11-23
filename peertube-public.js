export const meta = {
  id: 'hghub.peertube.public',
  name: 'PeerTube 公共视频',
  version: '1.0.0',
  protocol: 1,
  mature: false,
  timeouts: { read: 30, playback: 60 },
  description: '通过 SepiaSearch 搜索 PeerTube 联邦公开视频，播放源由视频所属实例提供',
};

const SEARCH_API = 'https://sepiasearch.org/api/v1/search/videos';

function fail(hg, code, message) {
  throw new hg.PluginError(code, message);
}

async function requestJson(hg, url, ctx, timeoutMs = 15000) {
  const r = await hg.http.fetch({
    url,
    method: 'GET',
    headers: { Accept: 'application/json' },
    responseType: 'text',
    timeoutMs,
    signal: ctx.signal,
  });
  if (!r.ok) fail(hg, 'UPSTREAM_ERROR', 'PeerTube 请求失败（HTTP ' + r.status + '）');
  const raw = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  try { return JSON.parse(raw); }
  catch (_) { fail(hg, 'UPSTREAM_ERROR', 'PeerTube 返回了无效 JSON'); }
}

function absoluteUrl(origin, value) {
  const s = String(value || '');
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  return origin.replace(/\/$/, '') + (s.startsWith('/') ? '' : '/') + s;
}

function originFromVideo(video) {
  const candidates = [
    video && video.url,
    video && video.channel && video.channel.url,
    video && video.account && video.account.url,
  ];
  for (const value of candidates) {
    const m = String(value || '').match(/^https?:\/\/[^/]+/i);
    if (m) return m[0];
  }
  return null;
}

function videoId(video) {
  return String(video && (video.uuid || video.shortUUID || video.id) || '');
}

function card(video) {
  const origin = originFromVideo(video);
  const thumbnail = video.thumbnailUrl || video.thumbnailPath || video.thumbnailPathUrl;
  const author = video.channel || video.account || {};
  return {
    id: videoId(video) + '@' + (origin ? origin.split('://')[1] : ''),
    title: String(video.name || 'PeerTube 视频'),
    type: 'video',
    cover: thumbnail ? absoluteUrl(origin || 'https://sepiasearch.org', thumbnail) : undefined,
    description: String(video.description || ''),
    tags: ['PeerTube', video.licence && video.licence.label].filter(Boolean),
    author: {
      id: String(author.id || author.name || 'PeerTube'),
      name: String(author.displayName || author.name || author.host || 'PeerTube 创作者'),
      avatar: author.avatars && author.avatars[0] ? absoluteUrl(origin || 'https://sepiasearch.org', author.avatars[0].url || author.avatars[0].path) : undefined,
    },
    publishedAt: video.publishedAt ? Date.parse(video.publishedAt) : undefined,
    episodeCount: 1,
  };
}

function parseCursor(cursor) {
  const n = Number(cursor || 0);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function playbackStreams(detail, origin) {
  const streams = [];
  const add = (url, format, label, height, bitrate) => {
    const full = absoluteUrl(origin, url);
    if (!full || !/^https:\/\//i.test(full) || streams.some(x => x.url === full)) return;
    streams.push({
      url: full,
      format,
      label: label || format.toUpperCase(),
      height: Number(height) || undefined,
      bitrate: Number(bitrate) || undefined,
    });
  };

  for (const file of (detail.files || [])) {
    const url = file.fileUrl || file.fileUrl;
    if (url) add(url, 'progressive', (file.resolution && file.resolution.label) || 'MP4', file.resolution && file.resolution.id, file.size);
  }

  for (const playlist of (detail.streamingPlaylists || [])) {
    if (playlist.playlistUrl) add(playlist.playlistUrl, 'hls', 'HLS');
    for (const file of (playlist.files || [])) {
      if (file.fileUrl) add(file.fileUrl, 'hls', (file.resolution && file.resolution.label) || 'HLS', file.resolution && file.resolution.id, file.size);
    }
  }
  return streams;
}

export default hg => ({
  search: {
    async search({ query, cursor, limit }, ctx) {
      const q = String(query || '').trim();
      if (!q) return { items: [], next: null };
      const start = parseCursor(cursor);
      const count = Math.min(Math.max(Number(limit) || 20, 1), 30);
      const params = new URLSearchParams({
        search: q,
        start: String(start),
        count: String(count),
        sort: '-match',
        nsfw: 'false',
      });
      const data = await requestJson(hg, SEARCH_API + '?' + params.toString(), ctx, 20000);
      const rows = Array.isArray(data.data) ? data.data : [];
      const items = rows
        .filter(v => v && videoId(v) && originFromVideo(v) && Number(v.privacy && v.privacy.id || 1) === 1)
        .map(card);
      const nextStart = start + rows.length;
      return { items, next: nextStart < Number(data.total || 0) && rows.length ? String(nextStart) : null };
    },
  },

  media: {
    async getDetail({ id }, ctx) {
      const value = String(id || '');
      const match = value.match(/^([^@]+)@([^/]+)$/);
      if (!match) fail(hg, 'INVALID_ID', '视频标识无效，请从搜索结果进入');
      const uuid = match[1];
      const origin = 'https://' + match[2];
      const detail = await requestJson(hg, origin + '/api/v1/videos/' + encodeURIComponent(uuid), ctx);
      const streams = playbackStreams(detail, origin);
      if (!streams.length) fail(hg, 'UNSUPPORTED', '该视频没有公开的 MP4/HLS 播放文件');
      const author = detail.channel || detail.account || {};
      const item = card({
        ...detail,
        url: detail.url || origin + '/videos/watch/' + uuid,
        channel: { ...author, url: author.url || origin },
      });
      return {
        ...item,
        playlists: [{
          id: 'main',
          label: '视频',
          kind: 'main',
          episodes: [{
            id: 'video',
            index: 1,
            label: '播放',
            durationSec: Number(detail.duration) || undefined,
            thumbnail: item.cover,
          }],
        }],
      };
    },

    async resolvePlayback({ mediaId }, ctx) {
      const value = String(mediaId || '');
      const match = value.match(/^([^@]+)@([^/]+)$/);
      if (!match) fail(hg, 'INVALID_ID', '视频标识无效');
      const uuid = match[1];
      const origin = 'https://' + match[2];
      const detail = await requestJson(hg, origin + '/api/v1/videos/' + encodeURIComponent(uuid), ctx);
      const streams = playbackStreams(detail, origin);
      if (!streams.length) fail(hg, 'UNSUPPORTED', '该视频没有公开的 MP4/HLS 播放文件');
      return { streams, durationSec: Number(detail.duration) || undefined };
    },
  },
});
