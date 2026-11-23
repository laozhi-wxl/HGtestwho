export const meta = {
  id: "source.adultembed",
  name: "AdultEmbed 成人视频库",
  version: "1.0.0",
  protocol: 1,
  description: "通过 AdultEmbed 公共 API 搜索成人视频、演员、片商与标签；播放使用来源方网页播放器。",
  author: "HGtestwho",
  homepage: "https://adultembed.com/api/docs/",
  updateUrl: "https://raw.githubusercontent.com/laozhi-wxl/HGtestwho/main/plugins/adultembed.source.js",
  mature: true,
  settings: [
    { key: "orientation", type: "select", label: "内容方向", default: "all", options: [
      { value: "all", label: "全部" }, { value: "straight", label: "异性" },
      { value: "gay", label: "男同性" }, { value: "trans", label: "跨性别" },
      { value: "bi", label: "双性" }
    ]},
    { key: "pageSize", type: "select", label: "每页数量", default: "24", options: [
      { value: "12", label: "12 条" }, { value: "24", label: "24 条" }, { value: "48", label: "48 条" }
    ]}
  ]
};

const API = "https://adultembed.com/api/v1";
const PLAYER = "https://adultembed.com/player/embed/";

function fail(hg, code, message) {
  throw new hg.PluginError(code, message);
}
function listFrom(data) {
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  if (Array.isArray(data?.videos)) return data.videos;
  return [];
}
function pageNumber(cursor) {
  const n = Number(cursor || 1);
  return Number.isInteger(n) && n > 0 && n < 100000 ? n : 1;
}
function mapVideo(v) {
  const id = String(v.id ?? v.video_id ?? "");
  if (!id) return null;
  const performers = Array.isArray(v.performers) ? v.performers.map(x => typeof x === "string" ? x : x?.name).filter(Boolean) : [];
  const tags = Array.isArray(v.tags) ? v.tags.map(x => typeof x === "string" ? x : x?.name).filter(Boolean) : [];
  const studio = typeof v.studio === "string" ? v.studio : v.studio?.name;
  return {
    id: "ae:" + id,
    title: String(v.title || "Untitled"),
    type: "movie",
    cover: v.thumbnail || v.thumb || undefined,
    backdrop: v.tpdb_background_url || undefined,
    description: [v.description, performers.length ? "演员：" + performers.join("、") : "", studio ? "片商：" + studio : ""].filter(Boolean).join("\n"),
    tags: [...new Set([...tags, ...(studio ? [studio] : [])])].slice(0, 20),
    durationSec: Number(v.duration_seconds) > 0 ? Number(v.duration_seconds) : undefined,
    publishedAt: v.published_at ? Date.parse(v.published_at) : undefined,
    stats: Number(v.view_count) > 0 ? { plays: Number(v.view_count) } : undefined
  };
}
async function request(hg, path, query) {
  const res = await hg.http.fetch({
    url: API + path, query, responseType: "json", timeoutMs: 20000,
    cache: { ttlSec: 180, staleIfErrorSec: 1800 }, retry: 1
  });
  if (!res.ok) fail(hg, res.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR", "AdultEmbed 请求失败（HTTP " + res.status + "）");
  return res.data;
}
function pageResult(data, page, rawItems) {
  const items = rawItems.map(mapVideo).filter(Boolean);
  const hasMore = Boolean(data?.next || data?.has_more || (typeof data?.count === "number" && page * rawItems.length < data.count));
  return { items, next: hasMore ? String(page + 1) : null, total: Number(data?.count) || undefined };
}

export default function (hg) {
  const orientation = () => hg.settings.get("orientation") || "all";
  const pageSize = () => Number(hg.settings.get("pageSize") || 24);
  async function searchPage(query, cursor) {
    const page = pageNumber(cursor);
    const data = await request(hg, "/search", {
      query: query || undefined, orientation: orientation(), sort: query ? "newest" : "newest",
      page, per_page: pageSize(), quality: "complete"
    });
    const rows = listFrom(data);
    return pageResult(data, page, rows);
  }
  async function videoById(id) {
    const data = await request(hg, "/videos/" + encodeURIComponent(String(id)), {});
    return data?.video || data?.data?.video || data?.data || data;
  }
  return {
    home: {
      async getSections() {
        const data = await request(hg, "/videos/trending", { period: "week", orientation: orientation(), per_page: pageSize() });
        const rows = listFrom(data);
        return { items: [{ id: "trending", title: "本周热门", layout: "grid", items: rows.map(mapVideo).filter(Boolean) }], next: null };
      }
    },
    search: {
      async search({ query, cursor }) {
        return await searchPage(query, cursor);
      },
      async trending() {
        const data = await request(hg, "/videos/trending", { period: "week", orientation: orientation(), per_page: 12 });
        return listFrom(data).slice(0, 12).map(v => String(v.title || "")).filter(Boolean);
      }
    },
    media: {
      async getDetail({ id }) {
        const rawId = String(id).replace(/^ae:/, "");
        const v = await videoById(rawId);
        const item = mapVideo({ ...v, id: v.id ?? rawId });
        if (!item) fail(hg, "UPSTREAM_CHANGED", "AdultEmbed 返回了无法识别的视频数据");
        const embed = v?.embed?.url || v?.embed_url || (v?.id ? PLAYER + encodeURIComponent(String(v.id)) + "/" : "");
        const target = embed || v?.video_url;
        if (!target || !/^https:\/\//i.test(target)) fail(hg, "CONTENT_LOCKED", "该视频当前没有可用的网页播放器地址");
        return {
          ...item,
          playlists: [{ id: "main", label: "来源播放器", episodes: [{ id: "main", index: 1, label: "正片" }] }],
          related: []
        };
      },
      async resolvePlayback({ mediaId }) {
        const rawId = String(mediaId).replace(/^ae:/, "");
        const v = await videoById(rawId);
        const embed = v?.embed?.url || v?.embed_url || (v?.id ? PLAYER + encodeURIComponent(String(v.id)) + "/" : "");
        const target = embed || v?.video_url;
        if (!target || !/^https:\/\//i.test(target)) fail(hg, "CONTENT_LOCKED", "该视频当前没有可用的网页播放器地址");
        return { streams: [{ kind: "external", url: target, external: { app: "浏览器" } }] };
      }
    }
  };
}
