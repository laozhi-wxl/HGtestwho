export const meta = {
  id: 'hghub.x.publicvideo',
  name: 'X 公开视频',
  version: '1.0.0',
  protocol: 1,
  mature: true,
  description: '通过 FxTwitter 公共 API 浏览公开账号视频，并在 HGhub 原生播放器播放 MP4/HLS',
};

const API = 'https://api.fxtwitter.com/2';

function fail(hg, code, message) {
  throw new hg.PluginError(code, message);
}

function postIdFromUrl(value) {
  const m = String(value || '').match(/(?:x|twitter)\\.com\\/[^\\s/]+\\/status\\/(\\d{2,20})/i);
  return m ? m[1] : null;
}

function handleFromQuery(value) {
  const q = String(value || '').trim();
  const url = q.match(/(?:x|twitter)\\.com\\/([A-Za-z0-9_]{1,15})(?:\\/|$)/i);
  if (url && !['home','search','i'].includes(url[1].toLowerCase())) return url[1];
  const m = q.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

async function request(hg, url, ctx) {
  const r = await hg.http.fetch({
    url,
    headers: { 'User-Agent': 'HGhub-X-PublicVideo/1.0' },
    responseType: 'json',
    signal: ctx.signal,
  });
  if (!r.ok) fail(hg, 'UPSTREAM_ERROR', 'X 视频接口暂时不可用，请稍后重试');
  const data = r.data;
  if (!data || (typeof data.code === 'number' && data.code >= 400)) {
    fail(hg, 'UPSTREAM_ERROR', data && data.message ? String(data.message) : 'X 返回了错误响应');
  }
  return data;
}

function videoList(status) {
  const media = status && status.media;
  if (!media) return [];
  const source = Array.isArray(media.videos) ? media.videos : [];
  return source.filter(v => v && (v.type === 'video' || v.type === 'gif') && Array.isArray(v.formats) && v.formats.length);
}

function cardFromStatus(status) {
  const videos = videoList(status);
  if (!videos.length) return null;
  const author = status.author || {};
  const cover = videos[0].thumbnail_url || undefined;
  const created = status.created_timestamp ? Number(status.created_timestamp) * 1000 : Date.parse(status.created_at || '');
  return {
    id: String(status.id),
    title: String(status.text || '').trim().slice(0, 120) || ('@' + (author.screen_name || 'X') + ' 视频'),
    type: 'video',
    cover,
    description: String(status.text || ''),
    tags: ['X', '公开视频', '@' + (author.screen_name || 'unknown')],
    author: { id: String(author.id || author.screen_name || 'x'), name: String(author.name || author.screen_name || 'X'), avatar: author.avatar_url || undefined },
    publishedAt: Number.isFinite(created) ? created : undefined,
    episodeCount: videos.length,
  };
}

async function getStatus(hg, id, ctx) {
  const data = await request(hg, API + '/status/' + encodeURIComponent(id), ctx);
  if (!data.status || !data.status.id) fail(hg, 'NOT_FOUND', '帖子不存在、已删除或不可公开访问');
  return data.status;
}

export default hg => ({
  search: {
    async search({ query, cursor, limit }, ctx) {
      const q = String(query || '').trim();
      const postId = postIdFromUrl(q);
      if (postId) {
        const status = await getStatus(hg, postId, ctx);
        const card = cardFromStatus(status);
        return { items: card ? [card] : [], next: null };
      }

      const handle = handleFromQuery(q);
      if (!handle) {
        return {
          items: [],
          next: null,
          message: '输入 X 用户名（例如 @username）或公开帖子链接。全站关键词搜索目前受 X 上游 API 限制。',
        };
      }

      const params = 'count=' + Math.min(Math.max(Number(limit) || 20, 1), 50) +
        (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const data = await request(hg, API + '/profile/' + encodeURIComponent(handle) + '/media?' + params, ctx);
      const rows = Array.isArray(data.results) ? data.results : [];
      const items = rows.map(cardFromStatus).filter(Boolean);
      return { items, next: data.cursor && data.cursor.bottom ? String(data.cursor.bottom) : null };
    },
  },

  media: {
    async getDetail({ id }, ctx) {
      const status = await getStatus(hg, id, ctx);
      const card = cardFromStatus(status);
      if (!card) fail(hg, 'NOT_FOUND', '这条帖子没有可播放的视频');
      const videos = videoList(status);
      return {
        ...card,
        playlists: [{
          id: 'videos',
          label: '视频',
          kind: 'main',
          episodes: videos.map((v, i) => ({
            id: 'video-' + i,
            index: i + 1,
            label: videos.length > 1 ? '视频 ' + (i + 1) : '播放',
            durationSec: Number(v.duration) || undefined,
            thumbnail: v.thumbnail_url || undefined,
          })),
        }],
      };
    },

    async resolvePlayback({ mediaId, episodeId, maxHeight }, ctx) {
      const status = await getStatus(hg, mediaId, ctx);
      const videos = videoList(status);
      const match = String(episodeId || '').match(/^video-(\\d+)$/);
      const index = match ? Number(match[1]) : 0;
      const video = videos[index];
      if (!video) fail(hg, 'NOT_FOUND', '视频分集不存在或已不可用');

      const formats = Array.isArray(video.formats) ? video.formats.slice() : [];
      const usable = formats.filter(f => f && typeof f.url === 'string' && /^https:\\/\\//i.test(f.url));
      usable.sort((a, b) => {
        const ah = Number(a.height) || 0, bh = Number(b.height) || 0;
        const max = Number(maxHeight) || 0;
        if (max && ah && bh && (ah <= max) !== (bh <= max)) return ah <= max ? -1 : 1;
        return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
      });
      const streams = [];
      for (const f of usable) {
        const container = String(f.container || '').toLowerCase();
        if (container !== 'mp4' && container !== 'm3u8') continue;
        const stream = {
          url: f.url,
          format: container === 'm3u8' ? 'hls' : 'progressive',
          label: (Number(f.height) ? Number(f.height) + 'p' : container.toUpperCase()) + (f.codec ? ' · ' + f.codec : ''),
          height: Number(f.height) || undefined,
          bitrate: Number(f.bitrate) || undefined,
          codec: f.codec || undefined,
        };
        if (!streams.some(s => s.url === stream.url)) streams.push(stream);
      }
      if (!streams.length) fail(hg, 'UNSUPPORTED', '该帖子没有可供 HGhub 原生播放器使用的 MP4/HLS 视频流');
      return { streams, durationSec: Number(video.duration) || undefined };
    },
  },
});
