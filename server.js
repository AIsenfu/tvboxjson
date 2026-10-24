/**
 * 晚安影视 · 六站合集本地测试服务
 * ------------------------------------------------------------------
 * 零依赖，只用 Node 内置模块。
 *
 *   node server.js                              默认 8099（占用则自动 +1）
 *   PORT=9000 node server.js                    指定端口
 *   GUOBA_SITE=https://xxx CUPFOX_SITE=https://yyy node server.js   换镜像域名
 *
 * 提供：
 *   GET /vod.json            合并后的影视配置（六个站，一个链接）
 *   GET /js/<站点>.js         六个脚本，直接读本目录 js/ 下的副本（就是上传的那几份）
 *   GET /preview             数据预览，右上角可切站：首页 / 分类 / 详情 / 选集
 *   GET /selftest            六个站各跑一遍 home→分类→详情→播放→搜索，返回 JSON
 *   GET /                    使用说明 + 上传清单
 *
 * 说明：脚本用 curl 实现「同步请求」，跟 App 里 QuickJS 的 net.req 行为一致，
 *       所以能提前发现同步/异步不兼容的问题。
 *
 * js 位置：合集/js/ 里放的是**上传用的副本**，本地测试也读这份，
 *          保证「测的就是要传的」。源文件仍在各站目录（../guobayu/js/…），
 *          两边不一致时 /selftest 会报 drift，按提示重新同步即可。
 */

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PORT = Number(process.env.PORT || 8099);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CURL =
  process.platform === "win32" && fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe"))
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "curl.exe")
    : "curl";

/* ---------------------------- 站点表 ---------------------------- */

const SITES = [
  {
    key: "guobayu",
    name: "锅巴鱼影院",
    file: "guobayu.js",
    src: path.join(__dirname, "js", "guobayu.js"),
    origin: path.join(__dirname, "..", "guobayu", "js", "guobayu.js"),
    api: (process.env.GUOBA_SITE || "https://www.guobayu.com").replace(/\/+$/, ""),
  },
  {
    key: "cupfox7",
    name: "茶杯狐",
    file: "cupfox7.js",
    src: path.join(__dirname, "js", "cupfox7.js"),
    origin: path.join(__dirname, "..", "cupfox7", "js", "cupfox7.js"),
    api: (process.env.CUPFOX_SITE || "https://www.cupfox7.com").replace(/\/+$/, ""),
  },
  {
    key: "mahuabox",
    name: "麻花影视",
    file: "mahuabox.js",
    src: path.join(__dirname, "js", "mahuabox.js"),
    origin: path.join(__dirname, "..", "mahuabox", "js", "mahuabox.js"),
    api: (process.env.MAHUA_SITE || "https://www.mahuabox.com").replace(/\/+$/, ""),
  },
  {
    key: "nfg",
    name: "哒哒影漫",
    file: "nfg.js",
    src: path.join(__dirname, "js", "nfg.js"),
    origin: path.join(__dirname, "..", "nfg", "js", "nfg.js"),
    api: (process.env.NFG_SITE || "https://nfg.oddym.com").replace(/\/+$/, ""),
    // 聚合导航站：详情要跨到飞快TV / 暮色影院取 m3u8，比纯 HTML 站慢
    timeout: 30,
    keyword: "凡人修仙传",
  },
  {
    key: "kkjpliu",
    name: "金牌影院",
    file: "kkjpliu.js",
    src: path.join(__dirname, "js", "kkjpliu.js"),
    origin: path.join(__dirname, "..", "kkjpliu", "js", "kkjpliu.js"),
    api: (process.env.KKJPLIU_SITE || "https://www.kkjpliu.com").replace(/\/+$/, ""),
    keyword: "庆余年",
  },
  {
    key: "chicey",
    name: "策驰影院",
    file: "chicey.js",
    src: path.join(__dirname, "js", "chicey.js"),
    origin: path.join(__dirname, "js", "chicey.js"), // 本站只在合集里维护，没有独立源目录
    api: (process.env.CHICEY_SITE || "https://chicey.com").replace(/\/+$/, ""),
    keyword: "吞噬星空",
  },
  {
    // 特狗影视：后端 vr2.tegouzj.cloud（tcpdump 抓 TLS SNI 确认，MacCMS 结构）
    // 当前被 Cloudflare 依 DMCA 裁定返回 451，全站下架；恢复/换镜像改 TEGOU_SITE 或 site.txt
    key: "tegou",
    name: "特狗影视",
    file: "tegou.js",
    src: path.join(__dirname, "js", "tegou.js"),
    origin: path.join(__dirname, "js", "tegou.js"), // 只在合集里维护，无独立源目录
    api: (process.env.TEGOU_SITE || "https://vr2.tegouzj.cloud").replace(/\/+$/, ""),
    keyword: "庆余年",
  },
  {
    // 樱花影视：MacCMS v10 HTML，官方 JSON 接口 404，只能抓页面
    // 换镜像域名改 TIAOZHANJIA_SITE 或 site.txt
    key: "tiaozhanjia",
    name: "樱花影视",
    file: "tiaozhanjia.js",
    src: path.join(__dirname, "js", "tiaozhanjia.js"),
    origin: path.join(__dirname, "js", "tiaozhanjia.js"), // 只在合集里维护，无独立源目录
    api: (process.env.TIAOZHANJIA_SITE || "https://www.tiaozhanjia.com").replace(/\/+$/, ""),
    keyword: "功夫",
  },
];

function siteOf(key) {
  for (const s of SITES) if (s.key === key) return s;
  return SITES[0];
}

function json(res, body, code = 200) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** 一个链接六个站：sites 里六项，api 都是相对路径 */
function config() {
  return {
    name: "晚安影视",
    notice: "锅巴鱼 + 茶杯狐 + 麻花 + 哒哒影漫 + 金牌 + 策驰，一个链接六个站",
    sites: SITES.map((s) => ({
      key: s.key,
      name: s.name,
      type: 3,
      api: "./js/" + s.file,
      ext: { api: s.api },
      searchable: 1,
      quickSearch: 1,
      changeable: 1,
      timeout: s.timeout || 20,
    })),
    parses: [],
    flags: [],
  };
}

/* --------------------------- 同步请求（curl） --------------------------- */

function curlReq(url, opts) {
  const o = opts || {};
  const h = o.headers || {};
  const args = ["-sS", "-L", "-m", "25", "-A", h["User-Agent"] || UA, "-D", "-"];
  // 哒哒影漫的分类/搜索是 POST + JSON body，这里要跟着支持
  if (o.method && String(o.method).toUpperCase() !== "GET") {
    args.push("-X", String(o.method).toUpperCase());
  }
  if (o.body !== undefined && o.body !== null) {
    args.push("--data-binary", String(o.body));
  }
  Object.keys(h).forEach((k) => {
    if (k.toLowerCase() === "user-agent") return;
    args.push("-H", k + ": " + h[k]);
  });
  args.push(url);
  const buf = execFileSync(CURL, args, { maxBuffer: 64 * 1024 * 1024 });
  const text = buf.toString("utf8");

  // 本机可能挂着代理，curl 会先输出 "HTTP/1.1 200 Connection Established"，
  // 真正的响应头在后面。取【最后一段】HTTP 响应头，否则拿不到 Set-Cookie
  // （麻花影视要靠 Set-Cookie 过拦截页）。
  const marks = [];
  const re = /HTTP\/[\d.]+\s+(\d{3})/g;
  let mm;
  while ((mm = re.exec(text)) != null) marks.push({ at: mm.index, code: mm[1] });
  if (!marks.length) return { code: 0, headers: {}, content: text, error: "no header" };

  const last = marks[marks.length - 1];
  const sep = text.indexOf("\r\n\r\n", last.at);
  const head = text.slice(last.at, sep);
  const body = text.slice(sep + 4);

  const headers = {};
  head
    .split(/\r?\n/)
    .slice(1)
    .forEach((line) => {
      const i = line.indexOf(":");
      if (i < 0) return;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (!k) return;
      if (k === "set-cookie") headers[k] = headers[k] ? [].concat(headers[k], v) : [v];
      else headers[k] = v;
    });

  return { code: Number(last.code), headers, content: body };
}

/* ------------------------------ 载入爬虫 ------------------------------ */

function loadSpider(site) {
  const src = fs
    .readFileSync(site.src, "utf8")
    .replace(/export\s+default\s+api\s*;?\s*$/, "")
    .replace(/export\s+default\s+/g, "var __default = ");
  const factory = new Function("net", "req", "http", "joinUrl", "getUserAgent", src + "\nreturn api;");
  const spider = factory({ req: curlReq }, undefined, undefined, (a, b) => a + b, () => UA);
  spider.init({ api: site.api });
  return spider;
}

/* ------------------------------- 自检 ------------------------------- */

function testOne(site, keyword) {
  const t0 = Date.now();
  const out = { key: site.key, name: site.name, api: site.api, steps: {} };
  const spider = loadSpider(site);

  const home = JSON.parse(spider.home({}));
  out.steps.home = {
    classes: home.class.map((c) => c.type_name),
    cards: home.list.length,
    first: home.list[0] && home.list[0].vod_name,
  };

  const tid = home.class[0].type_id;
  const cat = JSON.parse(spider.category(tid, "1", false, {}));
  out.steps.category = {
    tid: tid + " " + home.class[0].type_name,
    cards: cat.list.length,
    pagecount: cat.pagecount,
    first: cat.list[0] && cat.list[0].vod_name,
  };

  const vid = cat.list[0].vod_id;
  const v = JSON.parse(spider.detail(vid)).list[0];
  const froms = String(v.vod_play_from || "").split("$$$");
  const firstLine = String(v.vod_play_url || "").split("$$$")[0] || "";
  out.steps.detail = {
    id: vid,
    name: v.vod_name,
    pic: v.vod_pic,
    lines: froms.length,
    episodes: firstLine.split("#").length,
  };

  const epId = (firstLine.split("#")[0] || "").split("$")[1];
  const play = JSON.parse(spider.play(froms[0], epId));
  out.steps.play = { flag: froms[0], id: epId, url: play.url, parse: play.parse };

  const s = JSON.parse(spider.search(keyword, true, "1"));
  out.steps.search = { key: keyword, cards: s.list.length, first: s.list[0] && s.list[0].vod_name };

  out.ok = !!(
    out.steps.home.cards &&
    out.steps.category.cards &&
    out.steps.detail.name &&
    out.steps.play.url &&
    out.steps.search.cards
  );
  out.ms = Date.now() - t0;
  return out;
}

/* ------------------------------ 副本检查 ------------------------------ */

/** 合集/js 是上传副本，源文件在各站目录；不一致就报出来，避免「测的和传的不是同一份」 */
function drift() {
  const out = [];
  for (const site of SITES) {
    const row = { key: site.key, file: site.file, ok: true, note: "" };
    try {
      const copy = fs.readFileSync(site.src, "utf8");
      if (!fs.existsSync(site.origin)) {
        row.ok = false;
        row.note = "源文件不存在：" + site.origin;
      } else {
        const src = fs.readFileSync(site.origin, "utf8");
        if (copy !== src) {
          row.ok = false;
          row.note = "副本与源不一致（合集 " + copy.length + " 字节 / 源 " + src.length + " 字节）";
        }
      }
    } catch (e) {
      row.ok = false;
      row.note = String((e && e.message) || e);
    }
    out.push(row);
  }
  return out;
}

function selfTest() {
  const t0 = Date.now();
  // 关键词各站取一个大概率有结果的（nfg 是聚合导航，用动画片名更稳）
  const KW = { guobayu: "庆余年", cupfox7: "庆余年", mahuabox: "庆余年", nfg: "凡人修仙传" };
  const sites = {};
  let ok = true;
  for (const site of SITES) {
    try {
      sites[site.key] = testOne(site, KW[site.key] || site.keyword || "庆余年");
      if (!sites[site.key].ok) ok = false;
    } catch (e) {
      ok = false;
      sites[site.key] = { key: site.key, name: site.name, ok: false, error: String(e && e.message ? e.message : e) };
    }
  }
  const dr = drift();
  return { ok: ok, ready: ok && dr.every((r) => r.ok), sites: sites, drift: dr, ms: Date.now() - t0 };
}

/* ------------------------------ 数据预览 ------------------------------ */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PREVIEW_CSS = `
body{font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#fafafa;color:#1f2328}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e5e7eb;padding:10px 16px;z-index:9}
header .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;max-width:1100px;margin:0 auto}
header b{font-size:15px;margin-right:6px}
a{color:#185fa5;text-decoration:none}
.tab{padding:4px 10px;border-radius:14px;background:#f1f3f5;font-size:13px}
.tab.on{background:#185fa5;color:#fff}
.tab.site{background:#eef6ff;border:1px solid #cfe4fb}
.tab.site.on{background:#0f5132;border-color:#0f5132;color:#fff}
main{max-width:1100px;margin:16px auto;padding:0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:14px}
.card{background:#fff;border:1px solid #eceef1;border-radius:8px;overflow:hidden}
.card .pic{aspect-ratio:2/3;background:#f1f3f5;display:block}
.card .pic img{width:100%;height:100%;object-fit:cover;display:block}
.card .t{padding:6px 8px 2px;font-size:13px;line-height:1.35;height:36px;overflow:hidden}
.card .r{padding:0 8px 8px;font-size:12px;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.meta{color:#6b7280;font-size:13px;margin:8px 0 16px}
.err{background:#fff5f5;border:1px solid #ffd7d7;color:#a4262c;padding:12px;border-radius:8px}
.detail{display:flex;gap:18px;margin-bottom:18px}
.detail img{width:180px;border-radius:8px}
.lines{margin-top:18px}
.lines h4{margin:14px 0 8px;font-size:13px;color:#374151}
.eps{display:flex;flex-wrap:wrap;gap:6px}
.eps a{padding:3px 9px;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;background:#fff}
pre{background:#fff;border:1px solid #eceef1;border-radius:8px;padding:12px;overflow:auto;font-size:12px}
form{display:flex;gap:6px;margin-left:auto}
input[type=text]{padding:4px 8px;border:1px solid #d0d7de;border-radius:6px;font-size:13px;width:150px}
`;

function cardHtml(v, site) {
  const pic = v.vod_pic
    ? `<img src="${esc(v.vod_pic)}" loading="lazy" referrerpolicy="no-referrer" alt="">`
    : "";
  return `<a class="card" href="/preview?site=${esc(site)}&id=${esc(v.vod_id)}" title="${esc(v.vod_name)}">
    <span class="pic">${pic}</span>
    <div class="t">${esc(v.vod_name)}</div>
    <div class="r">${esc(v.vod_remarks || "")}</div>
  </a>`;
}

function previewPage(url) {
  const site = siteOf(url.searchParams.get("site") || SITES[0].key);
  const id = url.searchParams.get("id") || "";
  const playId = url.searchParams.get("play") || "";
  const flag = url.searchParams.get("flag") || "";
  const tid = url.searchParams.get("tid") || "";
  const pg = url.searchParams.get("page") || "1";
  const kw = (url.searchParams.get("k") || "").trim();
  const t0 = Date.now();

  let main = "";
  let classTabs = [];
  try {
    const spider = loadSpider(site);
    let homeCache = null;
    const getHome = () => {
      if (!homeCache) homeCache = JSON.parse(spider.home({}));
      return homeCache;
    };

    if (playId) {
      const r = JSON.parse(spider.play(flag, playId));
      main = `<h3>播放地址 · ${esc(flag)} / ${esc(playId)}</h3>
        <p class="meta">parse=${esc(r.parse)}（0 表示直链，播放器直接播）· 站点：${esc(site.name)}</p>
        <pre>${esc(r.url)}</pre>
        <p><a href="${esc(r.url)}" target="_blank">在新窗口打开 m3u8</a>　<a href="javascript:history.back()">返回</a></p>`;
    } else if (id) {
      const v = JSON.parse(spider.detail(id)).list[0];
      const froms = String(v.vod_play_from || "").split("$$$");
      const urls = String(v.vod_play_url || "").split("$$$");
      let lines = "";
      froms.forEach((f, i) => {
        const eps = (urls[i] || "").split("#").filter(Boolean);
        lines +=
          `<h4>${esc(f)} · ${eps.length} 集</h4><div class="eps">` +
          eps
            .slice(0, 80)
            .map((e) => {
              const parts = e.split("$");
              return `<a href="/preview?site=${esc(site.key)}&play=${encodeURIComponent(parts[1] || "")}&flag=${encodeURIComponent(f)}">${esc(parts[0])}</a>`;
            })
            .join("") +
          (eps.length > 80 ? `<span class="meta">…共 ${eps.length} 集</span>` : "") +
          `</div>`;
      });
      main = `<div class="detail">
          <img src="${esc(v.vod_pic)}" referrerpolicy="no-referrer" alt="">
          <div>
            <h3 style="margin:0 0 6px">${esc(v.vod_name)}</h3>
            <p class="meta">${esc([v.vod_year, v.vod_area, v.vod_type, v.vod_remarks].filter(Boolean).join(" · "))}</p>
            <p class="meta">导演：${esc(v.vod_director || "-")}<br>主演：${esc((v.vod_actor || "-").slice(0, 80))}</p>
            <p>${esc((v.vod_content || "").slice(0, 240))}</p>
          </div>
        </div><div class="lines">${lines}</div>`;
    } else {
      let data, title;
      if (kw) {
        data = JSON.parse(spider.search(kw, true, pg));
        title = `搜索「${kw}」`;
      } else if (tid) {
        data = JSON.parse(spider.category(tid, pg, false, {}));
        const c = getHome().class.find((x) => x.type_id === tid);
        title = "分类 " + (c ? c.type_name : tid);
      } else {
        data = getHome();
        title = "首页推荐";
      }
      classTabs = getHome().class;

      const list = data.list || [];
      const pc = data.pagecount || 1;
      const nav = [];
      const q = new URLSearchParams({ site: site.key, page: "1" });
      if (kw) q.set("k", kw);
      if (tid) q.set("tid", tid);
      const mk = (n) => {
        const q2 = new URLSearchParams(q.toString());
        q2.set("page", String(n));
        return "?" + q2.toString();
      };
      if (Number(pg) > 1) nav.push(`<a href="${mk(Number(pg) - 1)}">上一页</a>`);
      if (Number(pg) < pc) nav.push(`<a href="${mk(Number(pg) + 1)}">下一页</a>`);
      main = `<h3 style="margin:0 0 4px">${esc(title)}</h3>
        <p class="meta">${list.length} 条 · 第 ${esc(pg)} 页 / 共 ${esc(pc)} 页 · 用时 ${Date.now() - t0}ms ${nav.join("　")}</p>
        <div class="grid">${list.map((v) => cardHtml(v, site.key)).join("")}</div>`;
    }
  } catch (e) {
    main = `<div class="err"><b>${esc(site.name)} 出错了</b><br>${esc(e && e.message ? e.message : e)}</div>`;
  }

  const siteTabs = SITES.map(
    (s) => `<a class="tab site ${s.key === site.key ? "on" : ""}" href="/preview?site=${s.key}">${esc(s.name)}</a>`
  ).join("");

  const head = `<header><div class="row">
      <b>六站合集 · 数据预览</b>${siteTabs}
      <span style="width:1px;height:18px;background:#e5e7eb"></span>
      <a class="tab ${!tid && !kw ? "on" : ""}" href="/preview?site=${site.key}">首页</a>
      ${classTabs
        .map((c) => `<a class="tab ${tid === c.type_id ? "on" : ""}" href="/preview?site=${site.key}&tid=${esc(c.type_id)}">${esc(c.type_name)}</a>`)
        .join("")}
      <form action="/preview" method="get">
        <input type="hidden" name="site" value="${esc(site.key)}">
        <input type="text" name="k" value="${esc(kw)}" placeholder="搜片名"><button>搜索</button>
      </form>
    </div></header>`;

  return `<!doctype html><meta charset="utf-8"><title>${esc(site.name)} · 数据预览</title>
    <style>${PREVIEW_CSS}</style>${head}<main>${main}</main>`;
}

/* ------------------------------- 服务 ------------------------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const ip = String(req.socket.remoteAddress || "")
    .replace("::ffff:", "")
    .replace("::1", "本机");
  console.log(`[${new Date().toLocaleTimeString()}] ${ip} ${req.method} ${p}${url.search}`);

  if (p === "/vod.json") return json(res, config());

  if (p.indexOf("/js/") === 0 && p.slice(-3) === ".js") {
    const name = path.basename(p);
    const site = SITES.find((s) => s.file === name);
    if (!site) return json(res, { msg: "缺少 " + p + "（合集只提供 " + SITES.map((s) => s.file).join(" / ") + "）" }, 404);
    if (!fs.existsSync(site.src)) return json(res, { msg: "源文件不存在：" + site.src }, 404);
    const text = fs.readFileSync(site.src, "utf8");
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    return res.end(text);
  }

  if (p === "/selftest") {
    // 只跑 GET：HEAD/探测请求直接回空，别把整条链路跑一遍卡住事件循环
    if (req.method !== "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end();
    }
    try {
      return json(res, selfTest());
    } catch (e) {
      return json(res, { ok: false, error: String(e && e.message ? e.message : e) }, 500);
    }
  }

  if (p === "/preview") {
    if (req.method !== "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end();
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(previewPage(url));
  }

  if (p === "/" || p === "/index.html") {
    const dr = drift();
    const driftHtml = dr.every((r) => r.ok)
      ? `<p style="color:#0f5132">js 副本与各站源文件一致 ✓</p>`
      : `<p style="color:#a4262c"><b>js 副本与源文件不一致：</b><br>${dr
          .filter((r) => !r.ok)
          .map((r) => `　${esc(r.file)}：${esc(r.note)}`)
          .join("<br>")}<br><small>重新从各站目录复制一份到 <code>合集/js/</code> 即可</small></p>`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      `<meta charset="utf-8"><title>六站合集 · 本地服务</title>
       <style>body{font:14px/1.7 system-ui;max-width:820px;margin:40px auto;padding:0 16px;color:#222}
       code{background:#f4f4f5;padding:2px 6px;border-radius:4px}a{color:#185fa5}
       table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid #e5e7eb;padding:4px 10px;font-size:13px;text-align:left}
       th{background:#fafafa}</style>
       <h3>六站合集 · 本地服务</h3>
       <p>配置地址（填进 App，一个链接六个站）：<code>http://${req.headers.host}/vod.json</code></p>
       <p><b>数据预览：<a href="/preview">/preview</a></b>（右上角切站，可看首页 / 分类 / 详情 / 选集）</p>
       <p>全链路自检：<a href="/selftest">/selftest</a>（六个站各跑一遍 home → 分类 → 详情 → 播放 → 搜索）</p>

       <h4>上传清单（这个目录里除 server.js / README.md 外都要传）</h4>
       <table>
         <tr><th>文件</th><th>说明</th></tr>
         <tr><td><code>vod.php</code></td><td>配置入口（PHP 版，读 site.txt）</td></tr>
         <tr><td><code>site.txt</code></td><td>六个站的域名</td></tr>
         <tr><td><code>js/${SITES.map((x) => x.file).join("</code><br><code>js/")}</code></td><td>六个脚本，必须和 vod.php 同级</td></tr>
         <tr><td><code>vod.json</code></td><td>可选：纯静态环境才用</td></tr>
       </table>

       <h4>站点</h4>
       <p>${SITES.map((x) => `　<code>${esc(x.name)}</code> ${esc(x.api)}　<a href="/js/${esc(x.file)}">/js/${esc(x.file)}</a>`).join("<br>")}</p>
       ${driftHtml}`
    );
  }

  return json(res, { msg: "not found: " + p }, 404);
});

let current = PORT;

server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  current += 1;
  if (current > PORT + 20) {
    console.error("连续 20 个端口都被占用，请用 PORT=xxxx node server.js 指定端口");
    process.exit(1);
  }
  console.log(`端口被占用，尝试 ${current} …`);
  server.listen(current, "0.0.0.0");
});

server.listen(current, "0.0.0.0", () => {
  const port = server.address().port;
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  console.log("六站合集 · 本地服务已启动");
  console.log(`  本机：  http://127.0.0.1:${port}/vod.json`);
  ips.forEach((ip) => console.log(`  局域网：http://${ip}:${port}/vod.json`));
  console.log(`  预览：  http://127.0.0.1:${port}/preview`);
  console.log(`  自检：  http://127.0.0.1:${port}/selftest`);
  SITES.forEach((s) => console.log(`  站点：  ${s.name}  ${s.api}`));
});
