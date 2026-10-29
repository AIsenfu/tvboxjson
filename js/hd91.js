/**
 * 91HD (866893.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 入口域名说明（2026-10）：
 *   http://91hd.com/、http://91hd.top/ 都是跳转页，真正的站是 https://866893.com
 *   https://34.150.15.39:20443/?u=…&p=… 那类网关也只是返回一段 JS 跳转（atob 后跳到 866893.com），
 *   抓不到内容，所以 BASE 直接写真实站点，需要换域名改 ext.api 即可。
 *
 * 站点是 MacCMS v10 + stui 主题，但只开了网页解析：
 *   /api.php/provide/vod/?ac=list → `closed`
 *   /voddetail/{id}.html          → HTTP 500，没有独立详情页
 *
 * 可用路径：
 *   首页     /                                     30 张卡片（热播视频 + 最近更新）
 *   分类     /vodshow/{tid}--------{page}---.html  36 条/页
 *   标签筛选 /vodshow/{tid}--------{page}--{tag}-.html
 *   详情     /vodplay/{id}-1-1.html                页面即详情页
 *   搜索     /vodsearch/{kw}----------{page}---.html  36 条/页
 *   总页数   <span class="num">1/51</span>
 *
 * 卡片结构（stui 主题，海报在 style 里而不是 img 标签，很容易漏）：
 *   <a class="stui-vodlist__thumb" href="/vodplay/1247-1-1.html" title="标题"
 *      style="background-image: url('https://…/cover.jpg');">
 *     <span class="pic-text text-right">🍌 31729</span></a>
 *   <div class="stui-vodlist__detail"><h4 class="title"><a …>标题</a></h4>
 *     <p class="sub"><span class="pull-right">102.0k次播放</span></p></div>
 *
 * 播放：
 *   play 页内联 var player_aaaa={…,"encrypt":0,"url":"https:\/\/…\/index.m3u8"}，
 *   实测 encrypt=0（明文，JSON 转义斜杠），另外两种（1=百分号编码、2=base64+百分号）也一并兼容。
 *   m3u8 是 HLS 直链，**不需要 Referer**（带不带都 200）。
 *
 * 封面：
 *   play 页里没有本片海报，但路径和 m3u8 同构 ——
 *     m3u8  https://aiyibo.xujiali.com/videos/202403/13/{hash}/87688c/index.m3u8
 *     封面  https://chhtpnooktp.piengks.net/videos/202403/13/{hash}/cover.jpg
 *   所以按 m3u8 前四段路径 + 图床域名推导；列表页解析到的海报会顺手缓存，命中就用缓存。
 *
 * ⚠️ 重要：这个站挂在 Cloudflare 后面，按 **TLS 指纹** 放行 ——
 *   同 IP 同 UA 下，curl 默认 TLS → 403（Cf-Mitigated: challenge），Chrome/Safari 指纹 → 200。
 *   所以脚本里任何一步都可能拿到「请稍候…」的验证页，这时会给诊断卡写明原因。
 *
 * 兼容性（跟合集里其它脚本同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串
 *   - 不依赖 getUserAgent / atob，UA 与 base64 都自己实现
 *   - 任何一步失败都给「诊断」卡片，不静默空白
 */

var BASE = "https://866893.com";
var IMG_HOST = "https://chhtpnooktp.piengks.net";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = { api: BASE, ua: UA };
var lastError = "";

/** id → 海报，列表页解析时顺手存下来，详情页命中就不用推导 */
var PICS = {};

/* ============================== 基础工具 ============================== */

function J(o) {
  return JSON.stringify(o);
}

function errText(e) {
  if (e == null) return "unknown";
  if (typeof e === "string") return e;
  return String(e.message || e);
}

function trim(s) {
  return String(s == null ? "" : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
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

function headers(referer) {
  var h = {
    "User-Agent": conf.ua || UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
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

/** Cloudflare 的「Just a moment / 请稍候」验证页，认出来才能给出人话提示 */
function isChallenge(txt) {
  var s = String(txt == null ? "" : txt);
  if (s.length > 20000) return false;
  return (
    s.indexOf("Just a moment") >= 0 ||
    s.indexOf("请稍候") >= 0 ||
    s.indexOf("challenges.cloudflare.com") >= 0 ||
    s.indexOf("cf-mitigated") >= 0
  );
}

/** 同步 GET；相对路径按 BASE 拼 */
function httpGet(url, referer, minLen) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { headers: headers(referer), timeout: 30000 });
  else if (b === "req") r = req(full, { headers: headers(referer), timeout: 30000 });
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 30000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var txt = bodyOf(r, full);
  if (isChallenge(txt)) {
    throw new Error("被 Cloudflare 人机验证拦截（返回「请稍候…」验证页）：" + full);
  }
  var need = minLen == null ? 200 : minLen;
  if (!txt || txt.length < need) {
    throw new Error("返回内容过短（" + (txt ? txt.length : 0) + " 字节，可能是空页/404）：" + full);
  }
  return txt;
}

function fetchHtml(url, referer, minLen) {
  try {
    return httpGet(url, referer, minLen);
  } catch (e) {
    lastError = errText(e);
    if (errText(e).indexOf("过短") >= 0 || errText(e).indexOf("Cloudflare") >= 0) throw e;
    return httpGet(url, referer, minLen);
  }
}

function one(s, re) {
  var m = re.exec(String(s == null ? "" : s));
  return m ? m[1] : "";
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
    })
    .replace(/&#x([0-9a-f]+);/gi, function (a, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
}

function stripTags(s) {
  return decodeHtml(
    String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
}

function attr(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(tag);
  if (m) return decodeHtml(m[1]);
  m = new RegExp("\\b" + name + "\\s*=\\s*'([^']*)'", "i").exec(tag);
  return m ? decodeHtml(m[1]) : "";
}

function absUrl(u) {
  var s = trim(u);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.charAt(0) === "/") return BASE + s;
  return BASE + "/" + s;
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

/* ---- base64 / 百分号解码（QuickJS 不保证有 atob） ---- */

var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64d(s) {
  var str = String(s == null ? "" : s).replace(/[^A-Za-z0-9+/=]/g, "");
  var out = "";
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === "=") break;
    var v = B64CHARS.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  return out;
}

function utf8Decode(bin) {
  var out = "";
  for (var i = 0; i < bin.length; i++) {
    var c = bin.charCodeAt(i);
    if (c < 0x80) out += String.fromCharCode(c);
    else if (c >= 0xc0 && c < 0xe0 && i + 1 < bin.length)
      out += String.fromCharCode(((c & 0x1f) << 6) | (bin.charCodeAt(++i) & 0x3f));
    else if (c >= 0xe0 && c < 0xf0 && i + 2 < bin.length)
      out += String.fromCharCode(
        ((c & 0x0f) << 12) | ((bin.charCodeAt(++i) & 0x3f) << 6) | (bin.charCodeAt(++i) & 0x3f)
      );
    else out += String.fromCharCode(c);
  }
  return out;
}

function pctDecode(s) {
  var str = String(s == null ? "" : s);
  if (str.indexOf("%") < 0) return str;
  var bin = str.replace(/%([0-9A-Fa-f]{2})/g, function (a, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  return utf8Decode(bin);
}

/* ============================== 列表解析 ============================== */

/**
 * 卡片以 <a class="stui-vodlist__thumb" href="/vodplay/{id}-1-1.html" …> 为锚点。
 * 海报写在 style="background-image: url('…')" 里（不是 <img>，容易漏），
 * 播放量在紧随其后的 <p class="sub"> 里。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var src = String(html == null ? "" : html);
  var re = /<a\b[^>]*class="stui-vodlist__thumb"[^>]*>/gi;
  var m;
  while ((m = re.exec(src)) != null) {
    var tag = m[0];
    var id = one(attr(tag, "href"), /\/vodplay\/(\d+)-/);
    if (!id || seen[id]) continue;
    var tail = src.substring(m.index, m.index + 1200);
    var name = trim(attr(tag, "title"));
    if (!name) name = stripTags(one(tail, /<h4 class="title">([\s\S]*?)<\/h4>/));
    if (!name) continue;

    var pic = one(attr(tag, "style"), /url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    if (pic && pic.indexOf("data:image") === 0) pic = "";
    var views = stripTags(one(tail, /<p class="sub"[^>]*>([\s\S]*?)<\/p>/));
    if (pic) PICS[id] = absUrl(pic);

    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(pic),
      vod_remarks: views,
    });
  }
  return out;
}

/** 总页数：<span class="num">1/51</span> */
function pageCount(html, page) {
  var m = /<span class="num">\s*\d+\s*\/\s*(\d+)\s*<\/span>/.exec(String(html == null ? "" : html));
  if (m) {
    var pc = Number(m[1]);
    if (pc > 0) return pc;
  }
  return Number(page) || 1;
}

/* ============================== 频道与筛选 ============================== */

/** 站点导航顺序原样搬过来（21 热门在最前，20 国产在第二，别按数字排序） */
var CLASSES = [
  { type_id: "21", type_name: "热门" },
  { type_id: "20", type_name: "国产" },
  { type_id: "22", type_name: "萝莉" },
  { type_id: "23", type_name: "学生" },
  { type_id: "24", type_name: "巨乳" },
  { type_id: "25", type_name: "制服" },
  { type_id: "26", type_name: "美穴" },
  { type_id: "27", type_name: "无码" },
  { type_id: "28", type_name: "欧美" },
  { type_id: "29", type_name: "动漫" },
  { type_id: "30", type_name: "同性" },
];

/** 首页侧栏的「热门标签」，对应 /vodshow/{tid}----------{tag}-.html */
var TAGS = ["探花", "极品", "中文字幕", "女神", "妹子", "巨乳"];

function filtersFor(tid) {
  var value = [{ n: "全部", v: "" }];
  for (var i = 0; i < TAGS.length; i++) value.push({ n: TAGS[i], v: TAGS[i] });
  return [{ key: "tag", name: "标签", value: value }];
}

function cateUrl(tid, tag, page) {
  var p = Number(page) > 0 ? Number(page) : 1;
  if (tag) return "/vodshow/" + tid + "--------" + p + "--" + enc(tag) + "-.html";
  return "/vodshow/" + tid + "--------" + p + "---.html";
}

function searchUrl(kw, page) {
  var p = Number(page) > 0 ? Number(page) : 1;
  return "/vodsearch/" + enc(kw) + "----------" + p + "---.html";
}

/* ============================== 详情与播放 ============================== */

function playPageUrl(id) {
  return "/vodplay/" + id + "-1-1.html";
}

/** player_aaaa → 真实地址；encrypt 0 明文 / 1 百分号 / 2 base64+百分号 */
function decodePlayer(html) {
  var src = String(html == null ? "" : html);
  var m = /var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(src);
  if (!m) return "";
  var raw = m[1];
  var s = trim(one(raw, /"url"\s*:\s*"([^"]*)"/).replace(/\\\//g, "/"));
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) {
    var t = b64d(s);
    if (t && (t.indexOf("%") === 0 || /^https?:\/\//i.test(t))) s = t;
  }
  if (s.indexOf("%") >= 0) s = pctDecode(s);
  s = trim(s).replace(/\\\//g, "/");
  return /^https?:\/\//i.test(s) ? s : "";
}

/** 由 m3u8 路径推封面：https://cdn/videos/202403/13/{hash}/xxx/index.m3u8 → 图床 + /videos/202403/13/{hash}/cover.jpg */
function coverFromUrl(u) {
  var m = /^https?:\/\/[^\/]+(\/videos\/\d{6}\/\d{1,2}\/[0-9a-zA-Z]+)\//i.exec(String(u || ""));
  return m ? IMG_HOST + m[1] + "/cover.jpg" : "";
}

function buildDetail(id) {
  var html = fetchHtml(playPageUrl(id), BASE + "/", 500);

  if (html.indexOf("player_aaaa") < 0) {
    throw new Error("不是播放页（影片可能已删除，或 id=" + id + " 不存在）");
  }

  // 标题：取「播放器之前最后一个 h3.title」。
  // 页面上有三个同名 h3.title —— 侧栏「热门标签」、正文片名、底部「相关视频」，
  // 按 DOM 顺序正文片名正好是播放器前的那一个。
  var pv = html.indexOf("stui-player__video");
  var name = "";
  var hre = /<h3 class="title">([\s\S]*?)<\/h3>/g;
  var hm;
  while ((hm = hre.exec(html)) != null) {
    if (pv > 0 && hm.index > pv) break;
    name = stripTags(hm[1]);
  }
  if (!name) {
    name = stripTags(one(html, /<title>([\s\S]*?)<\/title>/)).replace(/\s*[-–—]\s*91HD\s*$/i, "");
  }

  var views = one(html, /<span class="text-red">\s*(\d+)\s*<\/span>\s*次播放/);
  var date = one(html, /时间：\s*([\d\-: ]+)/);
  var tags = [];
  var re = /<a\b[^>]*class="stui-tag"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(html)) != null) {
    var t = stripTags(m[1]);
    if (t && tags.indexOf(t) < 0) tags.push(t);
  }

  var m3u8 = "";
  try {
    m3u8 = decodePlayer(html);
  } catch (e) {
    lastError = errText(e);
  }

  var pic = PICS[id] || coverFromUrl(m3u8);

  var lines = [];
  if (date) lines.push("发布：" + date);
  if (views) lines.push("播放：" + views);
  if (tags.length) lines.push("标签：" + tags.join(" "));
  lines.push("播放地址：" + (m3u8 ? "m3u8 直连（无需 Referer）" : "未解析到，播放时重试"));

  var vod = {
    vod_id: String(id),
    vod_name: name || "未知标题",
    vod_pic: pic,
    vod_remarks: views ? views + " 次播放" : "",
    vod_content: lines.join("\n"),
  };

  // 单线路单集（sid/nid 恒为 1/1）：地址解出来就直接塞选集，点开即播；否则塞 id 让 play() 再取一次
  vod.vod_play_from = "线路1";
  vod.vod_play_url = "正片$" + (m3u8 || String(id));
  return vod;
}

/* ============================== 诊断卡 ============================== */

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("base = " + BASE, ""));
  rows.push(diagCard("后端 = " + backend(), capsText()));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var html = fetchHtml("/", BASE + "/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var lh = fetchHtml(cateUrl("21", "", 1), BASE + "/");
    rows.push(diagCard("分类解析到 " + parseCards(lh).length + " 张卡片", "共 " + pageCount(lh, 1) + " 页"));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
  }
  try {
    var sh = fetchHtml(searchUrl("探花", 1), BASE + "/");
    rows.push(diagCard("搜索解析到 " + parseCards(sh).length + " 张卡片", "共 " + pageCount(sh, 1) + " 页"));
  } catch (e) {
    rows.push(diagCard("搜索异常：" + errText(e), ""));
  }
  try {
    var ph = fetchHtml(playPageUrl("1247"), BASE + "/", 500);
    var u = decodePlayer(ph);
    rows.push(diagCard(u ? "播放地址解析成功" : "播放地址解析失败", u ? u.substring(0, 60) : ""));
  } catch (e) {
    rows.push(diagCard("详情页异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

/* ============================== 爬虫主体 ============================== */

function readExt(ext) {
  var out = { api: "", ua: "" };
  var raw = ext;
  if (raw && typeof raw === "object" && raw.ext !== undefined && (raw.stype !== undefined || raw.skey !== undefined)) {
    raw = raw.ext;
  }
  if (raw == null) return out;
  if (typeof raw === "object") {
    if (raw.api) out.api = String(raw.api);
    if (raw.ua) out.ua = String(raw.ua);
    return out;
  }
  var text = trim(raw);
  if (!text) return out;
  if (text.charAt(0) === "{") {
    try {
      var o = JSON.parse(text);
      if (o && o.ext !== undefined && (o.stype !== undefined || o.skey !== undefined)) o = o.ext;
      if (o && o.api) out.api = String(o.api);
      if (o && o.ua) out.ua = String(o.ua);
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
    BASE = (e.api || "https://866893.com").replace(/\/+$/, "");
    conf = { api: BASE, ua: e.ua || UA };
  },

  home: function (filter) {
    try {
      var html = fetchHtml("/", BASE + "/");
      var list = parseCards(html);
      if (!list.length) throw new Error("首页没有解析到任何影片，可能页面结构变了");
      var filters = {};
      for (var i = 0; i < CLASSES.length; i++) filters[CLASSES[i].type_id] = filtersFor(CLASSES[i].type_id);
      return J({ class: CLASSES, filters: filters, list: list });
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
      return J({ list: parseCards(fetchHtml("/", BASE + "/")) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var e = extend || {};
    var page = Math.max(1, Number(pg) || 1);
    var tag = String(e.tag || "");
    var html;
    try {
      html = fetchHtml(cateUrl(String(tid), tag, page), BASE + "/");
    } catch (err) {
      lastError = errText(err);
      return J({ list: [], page: page, pagecount: page, limit: 36, total: (page - 1) * 36 });
    }
    var pc = pageCount(html, page);
    return J({ list: parseCards(html), page: page, pagecount: pc, limit: 36, total: pc * 36 });
  },

  detail: function (id) {
    if (id === "__diag") {
      return J({
        list: [
          {
            vod_id: "__diag",
            vod_name: "诊断信息",
            vod_pic: "",
            vod_content: ["base = " + BASE, "后端 = " + backend(), "能力 = " + capsText(), "最后错误 = " + (lastError || "(无)")].join("\n"),
            vod_play_from: "诊断",
            vod_play_url: "第1集$__diag",
          },
        ],
      });
    }
    try {
      return J({ list: [buildDetail(id)] });
    } catch (e) {
      lastError = errText(e);
      return J({
        list: [
          {
            vod_id: String(id),
            vod_name: "打不开：" + id,
            vod_pic: PICS[id] || "",
            vod_content: "详情页取不到：" + errText(e) + "\nbase = " + BASE + "\n后端 = " + backend(),
            vod_play_from: "诊断",
            vod_play_url: "第1集$__diag",
          },
        ],
      });
    }
  },

  search: function (key, quick, pg) {
    var k = trim(key);
    if (!k) return J({ list: [diagCard("关键词为空", "请输入片名")], pagecount: 1 });
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = fetchHtml(searchUrl(k, page), BASE + "/");
      var list = parseCards(html);
      var pc = pageCount(html, page);
      if (!list.length) {
        if (page > 1) return J({ list: [], page: page, pagecount: page - 1, limit: 36 });
        return J({ list: [diagCard("没有搜到：" + k, "换个关键词试试")], pagecount: 1 });
      }
      return J({ list: list, page: page, pagecount: pc, limit: 36, total: pc * 36 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var s = trim(id);
    if (!s) throw new Error("选集地址为空（线路：" + flag + "）");

    if (!/^https?:\/\//i.test(s)) {
      var html = fetchHtml(playPageUrl(s), BASE + "/", 500);
      var u = decodePlayer(html);
      if (!u) throw new Error("没解析到播放地址（id=" + s + "），player_aaaa 可能改了");
      s = u;
    }

    // 直链本身不校验 Referer，带上只是保险
    return J({
      parse: 0,
      url: s,
      header: {
        "User-Agent": conf.ua || UA,
        Referer: BASE + "/",
      },
    });
  },

  destroy: function () {},
};

export default api;
