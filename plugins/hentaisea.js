export const meta = {
  id: "hentaisea.source",
  name: "HentaiSea",
  version: "1.0.1",
  protocol: 1,
  description: "日本动画成人内容目录；读取公开页面并解析公开 MP4/HLS 播放地址。不绕过登录、付费或访问验证。",
  author: "HGtestwho",
  homepage: "https://hentaisea.com/",
  mature: true,
  defaultHeaders: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9"
  },
  timeouts: { read: 20, playback: 35 }
};

const BASE = "https://hentaisea.com/";
const AJAX = "https://hentaisea.com/wp-admin/admin-ajax.php";
const BLOCKED = ["shota", "loli", "yaoi"];

function abs(value, base = BASE) {
  try { return new URL(value, base).href; } catch { return ""; }
}
function clean(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ").trim();
}
function allowed(text) {
  const s = String(text || "").toLowerCase();
  return !BLOCKED.some(term => s.includes(term));
}
function extractVideos(html) {
  const out = [], seen = new Set();
  const blocks = String(html || "").match(/<article\b[^>]*>[\s\S]{0,16000}?<\/article>/gi) || [];
  for (const block of blocks) {
    const href = block.match(/<a\b[^>]+href=["']([^"']*\/(?:episodes|watch)\/[^"']+\/)["']/i)?.[1];
    if (!href) continue;
    const url = abs(href);
    if (!url || seen.has(url)) continue;
    const img = block.match(/<img\b[^>]*>/i)?.[0] || "";
    const titleRaw = block.match(/<h3\b[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>\s*<\/h3>/i)?.[1]
      || img.match(/\b(?:alt|title)=["']([^"']+)["']/i)?.[1] || "";
    const title = clean(titleRaw);
    if (!title || !allowed(title + " " + url)) continue;
    const thumbRaw = img.match(/\b(?:data-src|data-lazy-src|src)=["']([^"']+)["']/i)?.[1] || "";
    const thumb = abs(thumbRaw, url);
    const duration = clean(block.match(/<span\b[^>]+class=["'][^"']*\b(?:runtime|duration)\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    seen.add(url);
    out.push({ id: url, title, type: "anime", cover: thumb || undefined, description: title, tags: ["Hentai", "Japan"], badge: duration || undefined });
  }
  return out;
}
function getTitle(page, fallback) {
  return clean(page.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || page.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || fallback);
}
async function fetchText(hg, url, ctx, referer = BASE) {
  const r = await hg.http.fetch({
    url,
    method: "GET",
    responseType: "text",
    headers: {
      "User-Agent": meta.defaultHeaders["User-Agent"],
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Referer": referer,
      "Accept-Language": "en-US,en;q=0.9"
    },
    timeoutMs: 20000,
    signal: ctx.signal
  });
  if (!r.ok || typeof r.data !== "string" || !r.data) throw new hg.PluginError("UPSTREAM_ERROR", "HentaiSea 页面暂时无法访问");
  const low = r.data.toLowerCase();
  if (low.includes("cf-chl-") || low.includes("just a moment")) throw new hg.PluginError("UPSTREAM_ERROR", "站点要求额外访问验证，插件不会尝试绕过");
  return r.data;
}
async function resolveEpisode(hg, episodeUrl, ctx) {
  const page = await fetchText(hg, episodeUrl, ctx, BASE);
  const postId = page.match(/\ba\s*:\s*['"]?(\d+)['"]?/i)?.[1];
  if (!postId) throw new hg.PluginError("UPSTREAM_CHANGED", "没有找到播放器条目");
  for (let option = 1; option <= 4; option++) {
    const r = await hg.http.fetch({
      url: AJAX,
      method: "POST",
      responseType: "text",
      headers: {
        "User-Agent": meta.defaultHeaders["User-Agent"],
        "Referer": episodeUrl,
        "Accept": "*/*",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: { form: { action: "get_player_contents", a: postId, i: String(option) } },
      timeoutMs: 20000,
      signal: ctx.signal
    });
    if (!r.ok || typeof r.data !== "string") continue;
    let frames;
    try { frames = JSON.parse(r.data); } catch { continue; }
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      const iframeRaw = String(frame || "").match(/<iframe\b[^>]+src=["']([^"']+)["']/i)?.[1];
      if (!iframeRaw) continue;
      const iframeUrl = abs(iframeRaw, episodeUrl);
      if (!iframeUrl || !iframeUrl.startsWith("https://")) continue;
      const iframeHtml = await fetchText(hg, iframeUrl, ctx, episodeUrl);
      const normalized = iframeHtml.replace(/\\\//g, "/");
      let stream = "";
      const jw = normalized.match(/var\s+jw\s*=\s*(\{[\s\S]*?\});/i)?.[1];
      if (jw) {
        try { stream = JSON.parse(jw).file || ""; } catch {}
      }
      if (!stream) stream = normalized.match(/["']?(?:file|src)["']?\s*:\s*["'](https?:\/\/[^"']+\.(?:mp4|m3u8)(?:\?[^"']*)?)["']/i)?.[1] || "";
      if (!stream) stream = normalized.match(/(https?:\/\/[^"'\s<>]+\.(?:mp4|m3u8)(?:\?[^"'\s<>]*)?)/i)?.[1] || "";
      stream = stream.replace(/\\\//g, "/");
      if (!stream.startsWith("https://")) continue;
      const format = /\.m3u8(?:[?#]|$)/i.test(stream) ? "hls" : /\.mp4(?:[?#]|$)/i.test(stream) ? "progressive" : "";
      if (!format) continue;
      return { url: stream, format, headers: { "Referer": iframeUrl, "User-Agent": meta.defaultHeaders["User-Agent"] } };
    }
  }
  throw new hg.PluginError("UPSTREAM_CHANGED", "没有找到可直接播放的 MP4/HLS 地址");
}

export default function (hg) {
  async function list(url, ctx) {
    return extractVideos(await fetchText(hg, url, ctx, BASE));
  }
  return {
    home: {
      async getSections({ cursor }, ctx) {
        if (cursor) return { items: [], next: null };
        const items = await list(BASE + "episodes/", ctx);
        return { items: [{ id: "latest", title: "最新更新", layout: "grid", imageAspect: "portrait", items, more: true }], next: null };
      },
      async listSection({ cursor }, ctx) {
        const pageNo = Math.max(1, Number(cursor || "1"));
        const url = BASE + "episodes/" + (pageNo > 1 ? "page/" + pageNo + "/" : "");
        const items = await list(url, ctx);
        return { items, next: items.length ? String(pageNo + 1) : null };
      }
    },
    search: {
      async search({ query, cursor }, ctx) {
        const pageNo = Math.max(1, Number(cursor || "1"));
        const url = BASE + "?s=" + encodeURIComponent(query) + (pageNo > 1 ? "&paged=" + pageNo : "");
        const items = await list(url, ctx);
        return { items, next: items.length ? String(pageNo + 1) : null };
      }
    },
    media: {
      async getDetail({ id }, ctx) {
        const page = await fetchText(hg, id, ctx, BASE);
        const episode = page.match(/href=["']([^"']*\/episodes\/[^"']+\/)["']/i)?.[1];
        const episodeUrl = episode ? abs(episode, id) : id;
        const title = getTitle(page, id);
        const description = clean(page.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)?.[1] || title);
        return {
          id, title, type: "anime", description,
          playlists: [{ id: "main", label: "正片", episodes: [{ id: episodeUrl, index: 1, label: "播放" }] }]
        };
      },
      async resolvePlayback({ episodeId }, ctx) {
        const resolved = await resolveEpisode(hg, episodeId, ctx);
        return { streams: [{ kind: "media", url: resolved.url, format: resolved.format, label: resolved.format === "hls" ? "HLS" : "MP4", headers: resolved.headers }] };
      }
    }
  };
}
