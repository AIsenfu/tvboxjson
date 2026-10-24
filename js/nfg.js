/**
 * 哒哒影漫 (nfg.oddym.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是个「影视聚合导航」：React 单页 + 纯 JSON 接口，自己没有片源。
 * 它把豆瓣的影视条目聚合起来，再挂上 10 家第三方站（厂长资源 / 飞快TV /
 * 暮色影院 / 爱壹帆 …）的落地页链接。
 *
 * 所以这个脚本分两层：
 *   第一层（发现）  nfg 自己的接口，拿到条目元数据 + 「哪些站有这部片」
 *   第二层（播放）  顺着 code+id 落到第三方 MacCMS 站的 JSON 接口取 m3u8
 *
 * nfg 的接口（都是同域，不需要 cookie）：
 *   GET  /api/v1/ranking/home      首页榜单（all / movie / tv / shows / acg 五组）
 *   GET  /api/v1/config            站点配置，filterMeta 里是全部筛选项
 *   POST /api/v1/filter/list       分类 / 搜索（同一个接口，from 区分）
 *   GET  /api/v1/detail/{id}       详情：豆瓣信息 + list[]（每项 code/id/episode）
 *
 * 第三方的接口（MacCMS v10 标准接口，实测可用）：
 *   GET  {站}/api.php/provide/vod/?ac=detail&ids={id}
 *   GET  {站}/api.php/provide/vod/?ac=detail&wd={片名}
 *   返回里的 vod_play_from / vod_play_url 就是线路和 m3u8 直链，不用再解析 HTML。
 *
 * 播放怎么定：
 *   nfg 的 list[] 里 code 命中后端（飞快TV=feikuai、暮色影院=msdy）就直接按 id 取；
 *   取不到（没这条、或片被删）就退回按片名到后端搜一次，挑同名同年份的那条。
 *   两个后端都没有这部片时，详情页给一条「无播放源」占位，不会白屏。
 *
 * 兼容性（跟 测试/js/demo.js、kkys、guobayu、cupfox7 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 出错时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://nfg.oddym.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 播放后端。nfg 只给 code+id，真正出 m3u8 的是这些站。
 * 想加一个站：往这里塞 { code, name, api } 就行，code 必须和 nfg 的 rules 对上。
 * 实测：vidhub2 / zhaodapan / youzisp 本机连不上，4kcz 直接 403，
 *      ayfox 的 api.php 关掉了，hqvod 只留了 ajax 接口 —— 都没放进默认列表。
 */
var BACKENDS = [
  { code: "feikuai", name: "飞快TV", api: "https://feikuai.in" },
  { code: "msdy", name: "暮色影院", api: "https://www.msyy.tv" },
];

var CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv", type_name: "电视剧" },
  { type_id: "shows", type_name: "综艺" },
  { type_id: "acg", type_name: "动漫" },
];

var conf = {
  api: BASE,
  ua: UA,
  pic: "", // 封面代理模板，写 "https://xxx/?url={url}" 这种；留空=直接用豆瓣原图
  play: "", // 只启用部分后端，如 "feikuai"；留空=全部
  maxLines: 3, // 每个后端最多挂几条线路（飞快TV 一个片能给 6 条，全挂太吵）
  meta: null, // /api/v1/config 的 filterMeta 缓存
  cache: {}, // 详情结果缓存：id → JSON 字符串
  keys: [], // 缓存键，超 30 条就丢最早的那个
};
var lastError = "";

/* ============================== 基础工具 ============================== */

function J(o) {
  return JSON.stringify(o);
}

function errText(e) {
  if (e == null) return "unknown";
  if (typeof e === "string") return e;
  return String(e.message || e);
}

function backend() {
  if (typeof net === "object" && net && typeof net.req === "function") return "net.req";
  if (typeof req === "function") return "req";
  if (typeof http === "function") return "http";
  return "none";
}

function capsText() {
  return "net=" + typeof net + " req=" + typeof req + " http=" + typeof http;
}

function headers(referer, isJson) {
  var h = {
    "User-Agent": conf.ua || UA,
    Accept: isJson ? "application/json, text/plain, */*" : "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (isJson) h["Content-Type"] = "application/json";
  if (referer) h.Referer = referer;
  return h;
}

function bodyOf(r, url) {
  if (r == null) throw new Error("无响应：" + url);
  if (typeof r === "string") return r;
  if (typeof r === "object") {
    if (r.error) throw new Error("请求失败 " + url + " → " + r.error);
    if (typeof r.content === "string") return r.content;
    if (typeof r.body === "string") return r.body;
    if (typeof r.text === "string") return r.text;
  }
  throw new Error("无法识别的响应：" + String(r).substring(0, 80));
}

/** 同步 GET；相对路径按 BASE 拼 */
function httpGet(url, referer, isJson) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { headers: headers(referer, isJson), timeout: 20000 });
  else if (b === "req") r = req(full, { headers: headers(referer, isJson), timeout: 20000 });
  else if (b === "http") r = http(full, { headers: headers(referer, isJson), timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  return bodyOf(r, full);
}

/** 同步 POST（nfg 的分类/搜索是 POST + JSON body） */
function httpPost(url, payload, referer) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var body = JSON.stringify(payload || {});
  var h = headers(referer, true);
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { method: "POST", headers: h, body: body, timeout: 20000 });
  else if (b === "req") r = req(full, { method: "POST", headers: h, body: body, timeout: 20000 });
  else if (b === "http")
    r = http(full, { method: "POST", headers: h, body: body, timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  return bodyOf(r, full);
}

function parseJson(text, url) {
  var s = String(text == null ? "" : text).replace(/^\s+|\s+$/g, "");
  if (!s) throw new Error("空响应：" + url);
  if (s.charAt(0) !== "{") throw new Error("返回的不是 JSON（开头：" + s.substring(0, 50) + "）：" + url);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error("JSON 解析失败：" + url);
  }
}

/** nfg 的接口：{"message":"","data":...}，只要 data */
function nfgGet(path) {
  var url = BASE + path;
  var o = parseJson(httpGet(url, BASE + "/", true), url);
  if (o.data === undefined || o.data === null) throw new Error("接口没有 data：" + url);
  return o.data;
}

function nfgPost(path, payload) {
  var url = BASE + path;
  var o = parseJson(httpPost(url, payload, BASE + "/"), url);
  if (o.data === undefined || o.data === null) throw new Error("接口没有 data：" + url);
  return o.data;
}

/** MacCMS 的接口：{"code":1,"list":[...]}，要整包 */
function maccmsGet(bk, query) {
  var url = bk.api + "/api.php/provide/vod/?ac=detail&" + query;
  var o = parseJson(httpGet(url, bk.api + "/", true), url);
  if (!o.list || !o.list.length) return null;
  return o;
}

function decodeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (a, d) {
      var code = Number(d);
      if (!code) return a;
      return String.fromCharCode(code);
    });
}

function stripTags(s) {
  return decodeHtml(
    String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

function htmlText(s) {
  return decodeHtml(
    String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

/** 播放地址里带中文的（部分线路是 /第01集/index.m3u8）要转义，否则播放器拒播 */
function fixUrl(u) {
  var s = String(u == null ? "" : u).replace(/^\s+|\s+$/g, "");
  if (!s) return s;
  if (s.indexOf("//") === 0) s = "https:" + s;
  if (/[^\x00-\x7F]/.test(s)) {
    try {
      s = encodeURI(s);
    } catch (e) {}
  }
  return s;
}

/** 封面：豆瓣图床对外链有防盗（无 Referer 回 418），必要时用 ext.pic 套一层代理 */
function poster(u) {
  var s = String(u == null ? "" : u).replace(/^\s+|\s+$/g, "");
  if (!s) return "";
  if (s.indexOf("//") === 0) s = "https:" + s;
  if (conf.pic) return conf.pic.replace("{url}", s);
  return s;
}

/* ============================== 卡片 ============================== */

function remarksOf(v) {
  var parts = [];
  if (v.typeName) parts.push(String(v.typeName));
  var rate = Number(v.rate);
  if (rate > 0) parts.push(rate + "分");
  return parts.join(" · ");
}

function toVod(v) {
  return {
    vod_id: String(v.id),
    vod_name: stripTags(v.title),
    vod_pic: poster(v.poster || v.cover),
    vod_remarks: remarksOf(v),
  };
}

function listOf(data) {
  var out = [];
  var arr = (data && data.list) || [];
  for (var i = 0; i < arr.length; i++) {
    if (!arr[i] || arr[i].id === undefined) continue;
    out.push(toVod(arr[i]));
  }
  return out;
}

/** 分类/搜索共用一个接口，靠 from 区分 */
function queryList(payload) {
  var data = nfgPost("/api/v1/filter/list", payload);
  var size = Number(data.pageSize) || 36;
  var total = Number(data.total) || 0;
  return {
    list: listOf(data),
    limit: size,
    total: total,
    pagecount: Math.max(1, Math.ceil(total / size) || 1),
  };
}

/* ============================== 筛选项 ============================== */

/** 筛选项全部来自 /api/v1/config 的 filterMeta，抓一次缓存住 */
function metaFilters() {
  if (conf.meta) return conf.meta;
  var out = {};
  try {
    var fm = nfgGet("/api/v1/config").filterMeta || [];
    for (var i = 0; i < fm.length; i++) {
      var tid = String(fm[i].key);
      var arr = [];
      var metas = fm[i].metas || [];
      for (var k = 0; k < metas.length; k++) {
        var m = metas[k];
        var opts = [];
        var list = m.list || [];
        for (var j = 0; j < list.length; j++) {
          opts.push({
            n: String(list[j].value),
            v: list[j].key === undefined || list[j].key === null ? "" : String(list[j].key),
          });
        }
        if (opts.length > 1) arr.push({ key: String(m.key), name: String(m.value), value: opts });
      }
      if (arr.length) out[tid] = arr;
    }
  } catch (e) {
    lastError = "筛选项拉取失败：" + errText(e);
  }
  conf.meta = out;
  return out;
}

/* ============================== 播放源 ============================== */

function epNum(s) {
  var t = String(s == null ? "" : s);
  var m = /(\d+)\s*[集话話期]/.exec(t);
  if (m) return Number(m[1]);
  m = /(\d+)/.exec(t);
  return m ? Number(m[1]) : 0;
}

function normTitle(s) {
  return String(s == null ? "" : s)
    .replace(/[\s\u3000\u200b-\u200f]/g, "")
    .replace(/[：:·・、,，.。\-—_（）()【】\[\]「」《》"'"'!！?？]/g, "")
    .toLowerCase();
}

/** 一条线路的 "第01集$https://.../index.m3u8#第02集$..." 拆成 [{name,url}] */
function parseEps(str) {
  var out = [];
  var arr = String(str == null ? "" : str).split("#");
  for (var i = 0; i < arr.length; i++) {
    var item = arr[i];
    if (!item) continue;
    var at = item.indexOf("$");
    var name = at >= 0 ? item.substring(0, at) : "";
    var url = at >= 0 ? item.substring(at + 1) : item;
    url = String(url).replace(/^\s+|\s+$/g, "");
    if (!url || url.indexOf("://") < 0) continue;
    out.push({ name: stripTags(name) || "第" + (out.length + 1) + "集", url: fixUrl(url) });
  }
  return out;
}

/** 按 id 直取；这个站没有这条片就返回 null */
function fetchById(bk, id) {
  if (id === undefined || id === null || id === "") return null;
  var o = maccmsGet(bk, "ids=" + enc(id));
  if (!o) return null;
  for (var i = 0; i < o.list.length; i++) {
    if (o.list[i] && o.list[i].vod_play_url) return o.list[i];
  }
  return null;
}

/** 按片名搜，挑同名同年份的那条 */
function fetchByTitle(bk, title, year) {
  var t = String(title == null ? "" : title).replace(/^\s+|\s+$/g, "");
  if (!t) return null;
  var o = maccmsGet(bk, "wd=" + enc(t));
  if (!o) return null;
  var want = normTitle(t);
  var best = null;
  var bestScore = -1;
  for (var i = 0; i < o.list.length; i++) {
    var v = o.list[i];
    if (!v || !v.vod_play_url) continue;
    var got = normTitle(v.vod_name);
    var score = 0;
    if (got === want) score += 10;
    else if (got.indexOf(want) === 0 || want.indexOf(got) === 0) score += 5;
    else if (got.indexOf(want) >= 0 || want.indexOf(got) >= 0) score += 2;
    else continue;
    if (year && String(v.vod_year) === String(year)) score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/** 把一条后端的片拆成若干线路，每个后端最多 conf.maxLines 条 */
function pushLines(out, bk, v, used) {
  var froms = String(v.vod_play_from || "").split("$$$");
  var urls = String(v.vod_play_url || "").split("$$$");
  var added = 0;
  for (var i = 0; i < urls.length && added < conf.maxLines; i++) {
    var eps = parseEps(urls[i]);
    if (!eps.length) continue;
    var ln = stripTags(froms[i] || "").replace(/m3u8$/i, "");
    if (!ln) ln = "线路" + (i + 1);
    var name = bk.name + "·" + ln;
    if (used[name]) name = name + "-" + (i + 1);
    used[name] = 1;
    out.push({ name: name, eps: eps });
    added++;
  }
}

function activeBackends() {
  if (!conf.play) return BACKENDS;
  var want = String(conf.play).split(/[,，\s]+/);
  var out = [];
  for (var i = 0; i < BACKENDS.length; i++) {
    for (var k = 0; k < want.length; k++) {
      if (want[k] && want[k] === BACKENDS[i].code) {
        out.push(BACKENDS[i]);
        break;
      }
    }
  }
  return out.length ? out : BACKENDS;
}

/**
 * 详情 → 线路。返回 { lines:[{name,eps}], pic, hits:[...] }
 * hits 只用来写诊断信息（哪几个后端出了片）。
 */
function resolveLines(d) {
  var out = [];
  var used = {};
  var hits = [];
  var pic = "";
  var sources = d.list || [];
  var bks = activeBackends();
  var i, k;

  // 第一轮：nfg 已经告诉我们这部片在这个站是哪一条，直接用 id 取。
  // 这一轮每站只花一个请求，正常片子（nfg 挂了这个站）到这就够了。
  var byId = {};
  for (i = 0; i < bks.length; i++) {
    var bk = bks[i];
    var cands = [];
    for (k = 0; k < sources.length; k++) {
      if (String(sources[k].code) === bk.code) cands.push(sources[k]);
    }
    cands.sort(function (a, b) {
      return epNum(b.episode) - epNum(a.episode);
    });
    for (var c = 0; c < cands.length && !byId[bk.code]; c++) {
      try {
        byId[bk.code] = fetchById(bk, cands[c].id);
      } catch (e) {
        lastError = bk.name + " 取详情失败：" + errText(e);
      }
    }
    if (byId[bk.code]) takeBackend(out, used, hits, byId[bk.code], bk, true);
  }

  // 第二轮：一个都没命中（nfg 没挂这两个站，或片被删了）才按片名搜。
  // 只要有一个后端搜到了就停手，别把两个站都搜一遍 —— 每次搜索要 2~4 秒。
  if (!out.length) {
    for (i = 0; i < bks.length; i++) {
      var v = null;
      try {
        v = fetchByTitle(bks[i], d.title, d.year);
      } catch (e) {
        lastError = bks[i].name + " 搜索失败：" + errText(e);
      }
      if (v) {
        takeBackend(out, used, hits, v, bks[i], false);
        break;
      }
    }
  }

  for (i = 0; i < out.length && !pic; i++) pic = out[i].pic || "";
  return { lines: out, pic: pic, hits: hits };
}

/** 把一条后端的片转成线路，顺手记下它的封面（后端图床不会防盗链） */
function takeBackend(out, used, hits, v, bk, byId) {
  var n = out.length;
  pushLines(out, bk, v, used);
  if (out.length === n) return;
  hits.push(bk.name + (byId ? "（按 id）" : "（按片名）"));
  var p = String(v.vod_pic || "");
  if (p && !/^https?:\/\//i.test(p)) p = bk.api + (p.charAt(0) === "/" ? p : "/" + p);
  for (var i = n; i < out.length; i++) out[i].pic = p;
}

/* ============================== 诊断 ============================== */

/** 详情缓存，只留最近 30 条，别把内存吃光 */
function remember(key, text) {
  if (!conf.cache[key]) conf.keys.push(key);
  conf.cache[key] = text;
  while (conf.keys.length > 30) {
    var old = conf.keys.shift();
    delete conf.cache[old];
  }
}

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("base = " + BASE, ""));
  rows.push(diagCard("后端 = " + backend(), capsText()));
  rows.push(diagCard("播放后端 = " + activeBackends().length + " 个", conf.play || "全部"));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var groups = nfgGet("/api/v1/ranking/home");
    var n = 0;
    for (var i = 0; i < groups.length; i++) n += (groups[i].list || []).length;
    rows.push(diagCard("首页榜单 " + groups.length + " 组 / " + n + " 条", ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var q = queryList({ searchStr: null, type: "movie", category: "", country: "", year: "", pageIndex: 1, order: "new", from: "type" });
    rows.push(diagCard("分类 36 条？实际 " + q.list.length + " 条", "共 " + q.pagecount + " 页"));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
  }
  try {
    var f = metaFilters();
    var keys = [];
    for (var k in f) keys.push(k);
    rows.push(diagCard("筛选项 " + keys.length + " 组", keys.join(" / ")));
  } catch (e) {
    rows.push(diagCard("筛选项异常：" + errText(e), ""));
  }
  for (var b = 0; b < BACKENDS.length; b++) {
    try {
      var o = maccmsGet(BACKENDS[b], "wd=" + enc("凡人修仙传"));
      rows.push(diagCard(BACKENDS[b].name + " 搜索 " + (o ? o.list.length : 0) + " 条", BACKENDS[b].api));
    } catch (e) {
      rows.push(diagCard(BACKENDS[b].name + " 异常：" + errText(e), BACKENDS[b].api));
    }
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

function diagDetail() {
  var lines = [
    "base = " + BASE,
    "后端 = " + backend(),
    "能力 = " + capsText(),
    "播放后端 = " + activeBackends().length + " 个",
    "最后错误 = " + (lastError || "(无)"),
  ];
  return {
    list: [
      {
        vod_id: "__diag",
        vod_name: "诊断信息",
        vod_pic: "",
        vod_content: lines.join("\n"),
        vod_play_from: "诊断",
        vod_play_url: "第1集$__diag",
      },
    ],
  };
}

/* ============================== 爬虫主体 ============================== */

function readExt(ext) {
  var out = { api: "", ua: "", pic: "", play: "", maxLines: 0 };
  var raw = ext;
  // 旧式 __jsEvalReturn 会给 { stype, skey, ext }
  if (raw && typeof raw === "object" && raw.ext !== undefined && (raw.stype !== undefined || raw.skey !== undefined)) {
    raw = raw.ext;
  }
  if (raw == null) return out;
  if (typeof raw === "object") {
    if (raw.api) out.api = String(raw.api);
    if (raw.ua) out.ua = String(raw.ua);
    if (raw.pic) out.pic = String(raw.pic);
    if (raw.play) out.play = String(raw.play);
    if (raw.maxLines) out.maxLines = Number(raw.maxLines) || 0;
    return out;
  }
  var text = String(raw).replace(/^\s+|\s+$/g, "");
  if (!text) return out;
  if (text.charAt(0) === "{") {
    try {
      var o = JSON.parse(text);
      if (o && o.ext !== undefined && (o.stype !== undefined || o.skey !== undefined)) o = o.ext;
      if (o && o.api) out.api = String(o.api);
      if (o && o.ua) out.ua = String(o.ua);
      if (o && o.pic) out.pic = String(o.pic);
      if (o && o.play) out.play = String(o.play);
      if (o && o.maxLines) out.maxLines = Number(o.maxLines) || 0;
      return out;
    } catch (e) {
      lastError = "ext 解析失败：" + errText(e);
      return out;
    }
  }
  out.api = text;
  return out;
}

var api = {
  init: function (ext) {
    var e = readExt(ext);
    conf = {
      api: (e.api || BASE).replace(/\/+$/, ""),
      ua: e.ua || UA,
      pic: e.pic || "",
      play: e.play || "",
      maxLines: e.maxLines > 0 ? e.maxLines : 3,
      meta: null,
      cache: {},
      keys: [],
    };
    BASE = conf.api;
    lastError = "";
  },

  home: function (filter) {
    try {
      var groups = nfgGet("/api/v1/ranking/home");
      var list = [];
      var seen = {};
      for (var g = 0; g < groups.length; g++) {
        var items = groups[g].list || [];
        for (var i = 0; i < items.length; i++) {
          var v = items[i];
          if (!v || v.id === undefined) continue;
          var vid = String(v.id);
          if (seen[vid]) continue;
          seen[vid] = 1;
          list.push(toVod(v));
        }
      }
      if (!list.length) throw new Error("首页榜单是空的，可能接口变了");
      return J({ class: CLASSES, filters: metaFilters(), list: list });
    } catch (e) {
      lastError = errText(e);
      return J({
        class: [{ type_id: "__diag", type_name: "诊断" }],
        filters: {},
        list: [diagCard(lastError, "后端：" + backend())],
      });
    }
  },

  homeVod: function () {
    try {
      var groups = nfgGet("/api/v1/ranking/home");
      var list = [];
      var seen = {};
      for (var g = 0; g < groups.length; g++) {
        var items = groups[g].list || [];
        for (var i = 0; i < items.length; i++) {
          var v = items[i];
          if (!v || v.id === undefined) continue;
          if (seen[String(v.id)]) continue;
          seen[String(v.id)] = 1;
          list.push(toVod(v));
        }
      }
      return J({ list: list });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var e = extend || {};
    var page = Math.max(1, Number(pg) || 1);
    try {
      var r = queryList({
        searchStr: null,
        type: String(e.type || tid || "movie"),
        category: String(e.category || e.class || ""),
        country: String(e.country || ""),
        year: e.year ? String(e.year) : "",
        pageIndex: page,
        order: String(e.order || "new"),
        from: "type",
      });
      return J({ list: r.list, page: page, pagecount: r.pagecount, limit: r.limit, total: r.total });
    } catch (err) {
      lastError = errText(err);
      return J({
        list: [diagCard("分类失败：" + errText(err), "tid=" + tid)],
        page: page,
        pagecount: page,
      });
    }
  },

  detail: function (id) {
    if (id === "__diag") return J(diagDetail());
    var key = String(id);
    // 详情要跨 1~3 个后端，慢的能到 4 秒；App 来回翻详情页时别再跑一遍
    if (conf.cache[key]) return conf.cache[key];
    var d = nfgGet("/api/v1/detail/" + enc(id));
    var r = resolveLines(d);
    var lines = r.lines;

    var from = [];
    var urls = [];
    for (var i = 0; i < lines.length; i++) {
      from.push(lines[i].name);
      var eps = [];
      for (var k = 0; k < lines[i].eps.length; k++) {
        eps.push(lines[i].eps[k].name + "$" + lines[i].eps[k].url);
      }
      urls.push(eps.join("#"));
    }

    var vod = {
      vod_id: String(id),
      vod_name: stripTags(d.title) || "未知标题",
      vod_pic: r.pic || poster(d.poster),
      vod_remarks: String(d.episode || (Number(d.rate) > 0 ? d.rate + "分" : "")),
      vod_year: d.year ? String(d.year) : "",
      vod_area: (d.country || []).join(" / "),
      vod_type: (d.category || []).join(" / "),
      vod_director: (d.director || []).join(" "),
      vod_actor: (d.actor || []).join(" "),
    };

    var text = htmlText(d.content || "");
    if (Number(d.rate) > 0) text += "\n豆瓣评分：" + d.rate;
    if (vod.vod_director) text += "\n导演：" + vod.vod_director;
    if (vod.vod_actor) text += "\n演员：" + vod.vod_actor;
    text += "\n\n播放源：" + (r.hits.length ? r.hits.join("、") : "暂无（飞快TV / 暮色影院 都没这部片）");
    vod.vod_content = text;

    if (from.length) {
      vod.vod_play_from = from.join("$$$");
      vod.vod_play_url = urls.join("$$$");
    } else {
      // 没源也给一条占位，避免 App 里详情页下半截空白
      vod.vod_play_from = "无播放源";
      vod.vod_play_url = "飞快TV / 暮色影院 都没这部片$__none";
    }
    var out = J({ list: [vod] });
    remember(key, out);
    return out;
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var r = queryList({
        searchStr: String(key == null ? "" : key),
        type: "",
        category: "",
        country: "",
        year: "",
        pageIndex: page,
        order: "new",
        from: "search",
      });
      if (!r.list.length) {
        return J({ list: [diagCard("没有搜到：" + key, "换个关键词试试")], page: page, pagecount: 1 });
      }
      return J({ list: r.list, page: page, pagecount: r.pagecount, limit: r.limit, total: r.total });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], page: page, pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    if (id === "__none") throw new Error("这部片在飞快TV / 暮色影院 都没有，换一部试试");
    var url = String(id == null ? "" : id);
    if (url.indexOf("://") < 0) throw new Error("选集地址为空（线路：" + flag + "）");
    return J({
      parse: 0,
      url: fixUrl(url),
      header: { "User-Agent": conf.ua || UA },
    });
  },

  destroy: function () {},
};

export default api;
