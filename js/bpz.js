/**
 * 搜剧AI (bpz.app / souju.ai) —— FongMi/TV 爬虫脚本
 * ==================================================================
 * 站点是 React 单页（AI 影视搜索/发现），没有 MacCMS 那套接口，走自家 REST：
 *
 *   首页    GET /v1/feed/home                      sections[] -> cards[]
 *   分类    GET /v1/browse/catalog?kind=&page=     kind=movie/series/anime/variety/short_drama/documentary/sports
 *   搜索    GET /v1/browse/catalog?q=&page=
 *   详情    GET /v1/catalog/{id}                   episodes[]（每集带 token，一次给全）
 *   播放    GET /v1/playback/resolve/{episode.token}   line_options[] 里 url 就是 m3u8 直链
 *
 * 关键点（都实测过）：
 *   1) 所有 /v1/ 接口都要请求签名：三个头
 *        x-ai-movie-timestamp / x-ai-movie-nonce / x-ai-movie-signature
 *      签名 = HMAC_SHA256(SECRET, "METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE") 的十六进制。
 *      SECRET 是前端 bundle 里的常量（下面 ci）。QuickJS 没有 crypto，所以本文件内置
 *      纯 JS 的 SHA256/HMAC 实现（已与 Node crypto 逐字节对齐）。
 *   2) 详情里的 episode.token 是播放标识；拿它 GET /v1/playback/resolve/{token}
 *      返回 line_options[]，每项 {label, url, url_kind}，url_kind=m3u8 时 url 就是直链
 *      （1080zyk / 西瓜 / 暴风 / 电影天堂 / 量子 / 非凡 …），实测 m3u8 返回 200。
 *      url_kind=resolve_ticket 的线路要再 resolve 一次（下面 play 里处理）。
 *   3) 首页/分类/搜索的卡片 id 就是 catalog 详情 id；海报是百度图床代理（带 referrerpolicy）。
 *
 * 兼容性（跟合集里其它脚本同一套策略）：全同步、方法返回 JSON 字符串、
 * net.req → req → http 依次探测、解析失败给诊断卡。
 */

var BASE = "https://bpz.app";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var SECRET = "f39d73aa7a6426203cdee1ef17b31d3b7ea8c23f4c59c62a3a8aa0f39ee5e79d";

var conf = { api: BASE, ua: UA };
var lastError = "";

/* ============================== 纯 JS SHA256 / HMAC ============================== */

var K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

function sha256Bytes(bytes) {
  var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var b = bytes.slice();
  var bitLen = bytes.length * 8;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  var hi = Math.floor(bitLen / 0x100000000);
  var lo = bitLen >>> 0;
  b.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  for (var i = 0; i < b.length; i += 64) {
    var w = new Array(64);
    for (var t = 0; t < 16; t++) w[t] = ((b[i + t * 4] << 24) | (b[i + t * 4 + 1] << 16) | (b[i + t * 4 + 2] << 8) | b[i + t * 4 + 3]) >>> 0;
    for (var t2 = 16; t2 < 64; t2++) {
      var s0 = (rotr(w[t2 - 15], 7) ^ rotr(w[t2 - 15], 18) ^ (w[t2 - 15] >>> 3)) >>> 0;
      var s1 = (rotr(w[t2 - 2], 17) ^ rotr(w[t2 - 2], 19) ^ (w[t2 - 2] >>> 10)) >>> 0;
      w[t2] = (((w[t2 - 16] + s0) | 0) + (w[t2 - 7] | 0) + (s1 | 0)) >>> 0;
    }
    var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (var t3 = 0; t3 < 64; t3++) {
      var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      var ch = ((e & f) ^ (~e & g)) >>> 0;
      var t1 = (((h + S1) | 0) + ((ch + K256[t3]) | 0) + (w[t3] | 0)) >>> 0;
      var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      var maj = ((a & bb) ^ (a & c) ^ (bb & c)) >>> 0;
      var t4 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = bb; bb = a; a = (t1 + t4) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + bb) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  var out = [];
  for (var j = 0; j < 8; j++) out.push((H[j] >>> 24) & 255, (H[j] >>> 16) & 255, (H[j] >>> 8) & 255, H[j] & 255);
  return out;
}

function strBytes(s) {
  var a = [];
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 128) a.push(c);
    else if (c < 2048) a.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0xd800 || c >= 0xe000) a.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      i++;
      var c2 = s.charCodeAt(i);
      var cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      a.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
  }
  return a;
}

function bytesHex(a) {
  var s = "";
  for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? "0" : "") + a[i].toString(16);
  return s;
}

function hmacSha256Hex(keyStr, msgStr) {
  var kb = strBytes(keyStr);
  if (kb.length > 64) kb = sha256Bytes(kb);
  while (kb.length < 64) kb.push(0);
  var ip = [], op = [];
  for (var i = 0; i < 64; i++) { ip.push(kb[i] ^ 0x36); op.push(kb[i] ^ 0x5c); }
  var inner = sha256Bytes(ip.concat(strBytes(msgStr)));
  return bytesHex(sha256Bytes(op.concat(inner)));
}

function nonce() {
  var s = "";
  var hexc = "0123456789abcdef";
  for (var i = 0; i < 32; i++) s += hexc.charAt(Math.floor(Math.random() * 16));
  return s;
}

/* ============================== 请求层（带签名） ============================== */

function J(o) { return JSON.stringify(o); }

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

/** 对一个 /v1/ 路径（含 query）签名并发请求，返回响应文本 */
function httpGet(pathQuery, method) {
  method = (method || "GET").toUpperCase();
  var ts = String(new Date().getTime());
  var n = nonce();
  var can = method + "\n" + pathQuery + "\n" + ts + "\n" + n;
  var sig = hmacSha256Hex(SECRET, can);
  var full = /^https?:\/\//i.test(pathQuery) ? pathQuery : BASE + pathQuery;
  var h = {
    "User-Agent": conf.ua || UA,
    Accept: "application/json",
    "x-ai-movie-timestamp": ts,
    "x-ai-movie-nonce": n,
    "x-ai-movie-signature": sig,
  };
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { headers: h, timeout: 20000 });
  else if (b === "req") r = req(full, { headers: h, timeout: 20000 });
  else if (b === "http") r = http(full, { headers: h, timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（net=" + typeof net + " req=" + typeof req + " http=" + typeof http + "）");
  var txt = bodyOf(r, full);
  if (!txt || txt.length < 2) throw new Error("返回过短：" + full);
  return txt;
}

function apiJson(pathQuery, method) {
  var txt = httpGet(pathQuery, method);
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error("JSON 解析失败：" + txt.substring(0, 120));
  }
}

function enc(s) { return encodeURIComponent(String(s == null ? "" : s)); }

/* ============================== 卡片 / 解析 ============================== */

var CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "series", type_name: "电视剧" },
  { type_id: "anime", type_name: "动漫" },
  { type_id: "variety", type_name: "综艺" },
  { type_id: "short_drama", type_name: "短剧" },
  { type_id: "documentary", type_name: "纪录片" },
  { type_id: "sports", type_name: "体育" },
];

function toVod(c) {
  return {
    vod_id: String(c.id || ""),
    vod_name: c.title || "",
    vod_pic: c.poster_url || "",
    vod_remarks: c.remarks || "",
  };
}

function cardsToList(cards) {
  var out = [];
  var seen = {};
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i];
    if (!c || !c.id || seen[c.id]) continue;
    seen[c.id] = 1;
    out.push(toVod(c));
  }
  return out;
}

function isHttp(u) {
  return typeof u === "string" && u.slice(0, 4) === "http";
}

/** 从任意响应里抠出第一个 m3u8 直链 */
function findM3u8(obj) {
  var s = JSON.stringify(obj);
  var m = s.match(/https?:\/\/[^"\\\s]+\.m3u8[^"\\\s]*/);
  return m ? m[0] : "";
}

/* ============================== 诊断 ============================== */

function diagCard(t, r) {
  return { vod_id: "__diag", vod_name: "! " + t, vod_pic: "", vod_remarks: r || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("base = " + BASE, ""));
  rows.push(diagCard("后端 = " + backend(), "net=" + typeof net + " req=" + typeof req + " http=" + typeof http));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var d = apiJson("/v1/feed/home");
    var n = 0;
    var secs = d.sections || [];
    for (var i = 0; i < secs.length; i++) n += (secs[i].cards || []).length;
    rows.push(diagCard("首页 GET 成功", "sections=" + secs.length + " 卡=" + n));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

function diagnoseDetail() {
  var lines = [
    "base = " + BASE,
    "后端 = " + backend(),
    "最后错误 = " + (lastError || "(无)"),
    "签名 = HMAC-SHA256(纯JS)",
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
  var out = { api: "", ua: "" };
  var raw = ext;
  if (raw && typeof raw === "object" && raw.ext !== undefined && (raw.stype !== undefined || raw.skey !== undefined)) raw = raw.ext;
  if (raw == null) return out;
  if (typeof raw === "object") {
    if (raw.api) out.api = String(raw.api);
    if (raw.ua) out.ua = String(raw.ua);
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
    conf = { api: (e.api || BASE).replace(/\/+$/, ""), ua: e.ua || UA };
    BASE = conf.api;
  },

  home: function () {
    try {
      var d = apiJson("/v1/feed/home");
      var cards = [];
      var secs = d.sections || [];
      for (var i = 0; i < secs.length; i++) {
        var cs = secs[i].cards || [];
        for (var k = 0; k < cs.length; k++) cards.push(cs[k]);
      }
      var list = cardsToList(cards);
      if (!list.length) throw new Error("首页没有解析到卡片");
      return J({ class: CLASSES, filters: {}, list: list });
    } catch (e) {
      lastError = errText(e);
      return J({ class: [{ type_id: "__diag", type_name: "诊断" }], filters: {}, list: [diagCard(lastError, "后端：" + backend())] });
    }
  },

  homeVod: function () {
    try {
      var d = apiJson("/v1/feed/home");
      var cards = [];
      var secs = d.sections || [];
      for (var i = 0; i < secs.length; i++) {
        var cs = secs[i].cards || [];
        for (var k = 0; k < cs.length; k++) cards.push(cs[k]);
      }
      return J({ list: cardsToList(cards) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg) {
    if (tid === "__diag") return J(diagnose());
    var page = Math.max(1, Number(pg) || 1);
    try {
      var d = apiJson("/v1/browse/catalog?kind=" + enc(tid) + "&page=" + page);
      var list = cardsToList(d.cards || []);
      return J({ list: list, page: page, pagecount: list.length >= 20 ? page + 1 : page, limit: 20 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("分类失败：" + errText(e), "")], page: page, pagecount: 1 });
    }
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var d = apiJson("/v1/browse/catalog?q=" + enc(key) + "&page=" + page);
      var list = cardsToList(d.cards || []);
      return J({ list: list, page: page, pagecount: list.length >= 20 ? page + 1 : page, limit: 20 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], page: page, pagecount: 1 });
    }
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var vid = String(id);
    var d = apiJson("/v1/catalog/" + enc(vid));
    var eps = d.episodes || [];
    var vod = {
      vod_id: vid,
      vod_name: d.title || "",
      vod_pic: d.poster_url || "",
      vod_content: d.description || "",
      vod_actor: (d.actors || []).join("/"),
      vod_director: (d.directors || []).join("/"),
      vod_year: String(d.year || ""),
      vod_area: d.area || "",
      vod_type: (d.genres || []).join("/"),
      vod_remarks: d.remarks || d.episode_progress_text || "",
    };
    if (!eps.length) {
      vod.vod_play_from = "无";
      vod.vod_play_url = "暂无播放源$" + vid;
      return J({ list: [vod] });
    }
    // 线路极多（常见 30+，如 1080P-官方S/Z/R…、红牛/新浪/豆瓣…），全列会让
    // vod_play_url 膨胀到几十万字符、详情要 30 秒；统一一条「搜剧AI」线，
    // play() 时在该集全部 line_options 里自动挑可用的 m3u8。
    var epsStr = [];
    for (var j = 0; j < eps.length; j++) {
      var ep = eps[j];
      var nm = ep.title || "第" + (ep.number || j + 1) + "集";
      epsStr.push(nm + "$" + ep.token);
    }
    vod.vod_play_from = "搜剧AI";
    vod.vod_play_url = epsStr.join("#");
    return J({ list: [vod] });
  },

  play: function (flag, id) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var token = String(id || "");
    if (!token) throw new Error("选集 id 为空（线路：" + flag + "）");

    var r = apiJson("/v1/playback/resolve/" + enc(token));
    var opts = r.line_options || [];
    var pick = null;
    var i;
    // 1) 优先匹配所选线路名的 m3u8 直链
    for (i = 0; i < opts.length; i++) {
      var o = opts[i];
      if (o.url_kind === "m3u8" && isHttp(o.url) && (o.label === flag || o.display_label === flag || o.play_from === flag)) { pick = o; break; }
    }
    // 2) 默认优先的 m3u8
    if (!pick) for (i = 0; i < opts.length; i++) { if (opts[i].url_kind === "m3u8" && isHttp(opts[i].url) && opts[i].default_priority) { pick = opts[i]; break; } }
    // 3) 任意 m3u8 直链
    if (!pick) for (i = 0; i < opts.length; i++) { if (opts[i].url_kind === "m3u8" && isHttp(opts[i].url)) { pick = opts[i]; break; } }

    if (pick) {
      return J({ parse: 0, url: pick.url, header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" } });
    }
    // 4) 没有直链：对 resolve_ticket 线路二次解析
    for (i = 0; i < opts.length; i++) {
      if (opts[i].url_kind === "resolve_ticket") {
        var tk = String(opts[i].url || "").split("resolve://")[1] || "";
        if (tk) {
          try {
            var u = findM3u8(apiJson("/v1/playback/resolve/" + enc(tk)));
            if (u) return J({ parse: 0, url: u, header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" } });
          } catch (e) {
            lastError = errText(e);
          }
        }
      }
    }
    // 5) 兜底：整个 resolve 响应里找 m3u8
    var fallback = findM3u8(r);
    if (fallback) return J({ parse: 0, url: fallback, header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" } });

    throw new Error("没有可用的 m3u8 线路（线路：" + flag + "，该集可能无源）");
  },

  destroy: function () {},
};

export default api;
