export const meta = {
  id: "source.adultembed",
  name: "AdultEmbed 成人视频库",
  version: "1.0.1",
  protocol: 1,
  description: "通过 AdultEmbed 官方 API 搜索成人视频；播放交由来源方网页播放器。",
  author: "HGtestwho",
  homepage: "https://adultembed.com/api/docs/",
  updateUrl: "https://raw.githubusercontent.com/laozhi-wxl/HGtestwho/main/plugins/adultembed.source.js",
  mature: true,
  settings: [
    {
      key: "orientation",
      type: "select",
      label: "内容方向",
      default: "all",
      options: [
        { value: "all", label: "全部" },
        { value: "straight", label: "异性" },
        { value: "gay", label: "男同性" },
        { value: "trans", label: "跨性别" },
        { value: "bi", label: "双性" }
      ]
    }
  ]
};

const API = "https://adultembed.com/api/v1";
const PLAYER = "https://adultembed.com/player/embed/";

function raise(hg, code, message) {
  throw new hg.PluginError(code, message);
}

function rowsOf(data) {
  return Array.isArray(data?.results) ? data.results : [];
}

function mapVideo(v) {
  const rawId = v?.id;
  if (rawId === undefined || rawId === null) return null;

  const performers = Array.isArray(v.performers)
    ? v.performers.map(x => typeof x === "string" ? x : x?.name).filter(Boolean)
    : [];
  const tags = Array.isArray(v.tags)
    ? v.tags.map(x => typeof x === "string" ? x : x?.name).filter(Boolean)
    : [];
  const studio = typeof v.studio === "string" ? v.studio : v.studio?.name;
  const duration = Number(v.duration_seconds);

  return {
    id: "ae:" + String(rawId),
    title: String(v.title || "未命名视频"),
    type: "movie",
    cover: typeof v.thumbnail === "string" ? v.thumbnail : undefined,
    backdrop: typeof v.tpdb_background_url === "string" ? v.tpdb_background_url : undefined,
    description: [
      v.description,
      performers.length ? "演员：" + performers.join("、") : "",
      studio ? "片商：" + studio : ""
    ].filter(Boolean).join("\n"),
    tags: [...new Set([...tags, ...(studio ? [studio] : [])])].slice(0, 30),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    publishedAt: v.published_at ? Date.parse(v.published_at) : undefined,
    stats: Number(v.view_count) > 0 ? { plays: Number(v.view_count) } : undefined
  };
}

async function getJson(hg, path, query) {
  const response = await hg.http.fetch({
    url: API + path,
    query,
    responseType: "json",
    timeoutMs: 20000,
    cache: { ttlSec: 120, staleIfErrorSec: 600 },
    retry: 1
  });
  if (!response.ok) {
    raise(
      hg,
      response.status === 404 ? "NOT_FOUND" : "UPSTREAM_ERROR",
      "AdultEmbed 请求失败（HTTP " + response.status + "）"
    );
  }
  return response.data;
}

function pageOf(data, page, perPage) {
  const sourceRows = rowsOf(data);
  const items = sourceRows.map(mapVideo).filter(Boolean);
  const total = Number(data?.count);
  const pages = Number(data?.pages);
  const hasMore = Number.isFinite(pages) && pages > 0
    ? page < pages
    : Number.isFinite(total) && total >= 0
      ? page * perPage < total
      : Boolean(data?.next);
  return {
    items,
    next: hasMore ? String(page + 1) : null,
    total: Number.isFinite(total) && total >= 0 ? total : undefined
  };
}

function getPage(cursor) {
  const value = Number(cursor || 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function getRawId(id) {
  return String(id || "").replace(/^ae:/, "");
}

async function getVideo(hg, id) {
  const data = await getJson(hg, "/videos/" + encodeURIComponent(id), {});
  return data?.video || data?.data?.video || data?.data || data;
}

function playerUrl(id) {
  return PLAYER + encodeURIComponent(String(id)) + "/";
}

export default function (hg) {
  const orientation = () => hg.settings.get("orientation") || "all";
  const perPage = 24;

  async function listVideos(query, cursor) {
    const page = getPage(cursor);
    const data = await getJson(hg, "/search", {
      query: query || undefined,
      orientation: orientation(),
      sort: "newest",
      quality: "complete",
      page,
      per_page: perPage
    });
    return pageOf(data, page, perPage);
  }

  return {
    home: {
      async getSections() {
        const data = await getJson(hg, "/videos/trending", {
          period: "week",
          orientation: orientation(),
          quality: "complete",
          per_page: perPage
        });
        return {
          items: [{
            id: "weekly-trending",
            title: "本周热门",
            layout: "grid",
            items: rowsOf(data).map(mapVideo).filter(Boolean)
          }],
          next: null
        };
      }
    },

    search: {
      async search({ query, cursor }) {
        return await listVideos(query, cursor);
      },
      async trending() {
        const data = await getJson(hg, "/videos/trending", {
          period: "week",
          orientation: orientation(),
          quality: "complete",
          per_page: 12
        });
        return rowsOf(data).map(v => String(v.title || "")).filter(Boolean);
      }
    },

    media: {
      async getDetail({ id }) {
        const rawId = getRawId(id);
        const video = await getVideo(hg, rawId);
        const item = mapVideo({ ...video, id: video?.id ?? rawId });
        if (!item) raise(hg, "UPSTREAM_CHANGED", "AdultEmbed 详情数据格式无法识别");

        return {
          ...item,
          playlists: [{
            id: "main",
            label: "来源播放器",
            episodes: [{ id: "main", index: 1, label: "正片" }]
          }]
        };
      },

      async resolvePlayback({ mediaId }) {
        const rawId = getRawId(mediaId);
        const video = await getVideo(hg, rawId);
        if (!video || video.id === undefined) {
          raise(hg, "NOT_FOUND", "AdultEmbed 中已找不到该视频");
        }

        return {
          streams: [{
            kind: "external",
            url: playerUrl(video.id),
            external: { app: "浏览器" },
            label: "来源网页播放器"
          }]
        };
      }
    }
  };
}
