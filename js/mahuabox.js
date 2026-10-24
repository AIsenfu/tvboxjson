/**
 * 麻花影视 (www.mahuabox.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是自研模板（不是标准 MacCMS），几个必须知道的特点：
 *
 *   1. 卡片 class 名是随机混淆的（WSWSWSWS / DFsNkScP / ESESESES…），每次改版都会变，
 *      所以脚本只认两样东西：`href="/voddetail/{id}.html"` 和 class 里的 `videopic`。
 *   2. 全站正文是 HTML 实体（&#40635;&#33457;），必须解码，否则标题全是数字。
 *   3. 播放页偶尔返回 135 字节的拦截页：HTTP 403 + Set-Cookie + JS 跳回自己，
 *      浏览器带着那个 cookie 重发就 200。脚本会自动收下 Set-Cookie 再重试。
 *   4. 播放页 player_aaaa 的 `encrypt=1`，但 url 不是 base64 而是**百分号编码**
 *      （%68%74%74%70…），所以先 decodeURIComponent，失败才退回 base64。
 *
 * 路径：
 *   首页      /                                              ~50 张卡
 *   列表      /vodshow/{tid}---{类型}-----{页码}---.html      36 条/页
 *   详情      /voddetail/{id}.html                           全部线路 + 全部集数
 *   播放      /vodplay/{id}-{线路}-{集}.html                  player_aaaa.url
 *   搜索      /vodsearch/{关键词}----------{页码}---.html     10 条/页
 *
 * 兼容性（跟 测试/js/demo.js、guobayu/js/guobayu.js 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - ES5 写法，不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://www.mahuabox.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = {
  api: BASE,
  ua: UA,
  cookie: "",
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

function headers(referer) {
  var h = {
    "User-Agent": conf.ua || UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (conf.cookie) h.Cookie = conf.cookie;
  if (referer) h.Referer = referer;
  return h;
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
      return code ? String.fromCharCode(code) : a;
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

function one(s, re) {
  var m = re.exec(String(s == null ? "" : s));
  return m ? m[1] : "";
}

function attr(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*['\"]([^'\"]*)['\"]", "i").exec(tag);
  return m ? decodeHtml(m[1]) : "";
}

function absUrl(u) {
  var s = String(u == null ? "" : u).replace(/^\s+|\s+$/g, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.charAt(0) === "/") return BASE + s;
  return BASE + "/" + s;
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

/* ------------------------- 请求（含拦截页重试） ------------------------- */

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

/** 从响应的 set-cookie 里捞 token，攒进 conf.cookie */
function absorbCookie(r) {
  if (!r || typeof r !== "object" || !r.headers) return;
  var hs = r.headers;
  for (var k in hs) {
    if (!hs.hasOwnProperty(k)) continue;
    if (String(k).toLowerCase() !== "set-cookie") continue;
    var v = hs[k];
    var list = v && v.length !== undefined && typeof v !== "string" ? v : [v];
    for (var i = 0; i < list.length; i++) {
      var pair = String(list[i] || "").split(";")[0];
      pair = pair.replace(/^\s+|\s+$/g, "");
      if (!pair || pair.indexOf("=") < 0) continue;
      var name = pair.substring(0, pair.indexOf("="));
      if (!name || name.toLowerCase() === "path" || name.toLowerCase() === "expires") continue;
      // 同名覆盖
      var parts = conf.cookie ? conf.cookie.split("; ") : [];
      var kept = [];
      for (var j = 0; j < parts.length; j++) {
        if (parts[j].indexOf(name + "=") !== 0) kept.push(parts[j]);
      }
      kept.push(pair);
      conf.cookie = kept.join("; ");
    }
  }
}

/** 135 字节的拦截页：HTTP 403 + JS 跳回自己 */
function isChallenge(html) {
  return html.length < 1200 && html.indexOf("window.location.href") >= 0;
}

function httpOnce(url, referer) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var opt = { headers: headers(referer), timeout: 20000 };
  var r;
  if (b === "net.req") r = net.req(full, opt);
  else if (b === "req") r = req(full, opt);
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  absorbCookie(r);
  return bodyOf(r, full);
}

/** 取页面：撞到拦截页就带着新 cookie 重发，最多 5 次；中途先访问一次首页暖一下会话 */
function fetchHtml(url, referer) {
  var html = "";
  for (var i = 0; i < 5; i++) {
    html = httpOnce(url, referer);
    if (!isChallenge(html)) break;
    // 拦截页偶尔只认「先访问过首页」的会话，第 2 次失败后暖一下
    if (i === 1) {
      try {
        httpOnce("/", BASE + "/");
      } catch (e) {}
    }
  }
  if (isChallenge(html)) throw new Error("被拦截页挡住（已重试 5 次）：" + url);
  if (!html || html.length < 200) throw new Error("返回内容过短（" + (html ? html.length : 0) + " 字节）：" + url);
  return html;
}

/* ============================== 列表解析 ============================== */

/**
 * 卡片。class 名是混淆的，唯一稳定的锚点是：
 *   <a class="videopic lazy" href="/voddetail/{id}.html" title="名称"
 *      data-original="/upload/vod/xxx.jpg" style="background: url(/upload/...)">
 * 资讯卡也带 videopic，但 href 是 /artdetail-xxx.html，按 href 前缀排除。
 *
 * 搜索结果页是另一套写法：a 上没有 title，标题在紧跟的 <h3><a>…</a></h3> 里，
 * 所以 title 取不到时往下找 h3/h4/h5 里的链接文字。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /<a\b[^>]*class=['"][^'"]*videopic[^'"]*['"][^>]*>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var tag = m[0];
    var id = one(tag, /href=['"]\/voddetail\/([^'"]+)\.html['"]/i);
    if (!id || seen[id]) continue;

    var tail = html.substring(m.index, m.index + 900);
    var name = attr(tag, "title");
    if (!name) name = stripTags(one(tail, /<h[3-5][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/));
    if (!name) continue;
    seen[id] = 1;

    var pic = attr(tag, "data-original");
    if (!pic) pic = one(tag, /url\(\s*['"]?([^)'"]+)['"]?\s*\)/i);

    var note = one(tail, /<span class="note[^"]*">([\s\S]*?)<\/span>/);
    if (!note) note = one(tail, /<span class="score">([\s\S]*?)<\/span>/);

    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(pic),
      vod_remarks: stripTags(note),
    });
  }
  return out;
}

/** 「共11975条数据,当前1/333页」→ 333 */
function pageCount(html, fallback) {
  var m = /共\s*\d+\s*条数据\s*[,，]\s*当前\s*\d+\s*\/\s*(\d+)\s*页/.exec(String(html == null ? "" : html));
  if (m) {
    var n = Number(m[1]);
    if (n > 0) return n;
  }
  return fallback || 1;
}

/* ============================== 详情解析 ============================== */

function fieldOf(html, label) {
  var re = new RegExp(label + "：<\\/span>([\\s\\S]*?)<\\/li>");
  return stripTags(one(html, re));
}

/** 线路：[{sid,name,eps:[{name,id}]}]，id 是 /vodplay/{vod}-{线路}-{集}.html */
function parseGroups(html) {
  var names = {};
  var m;
  var nre = /<a class="option"[^>]*href="#playlist(\d+)"[^>]*title="([^"]*)"/g;
  while ((m = nre.exec(html)) != null) {
    var t = stripTags(m[2]);
    if (t) names[m[1]] = t;
  }

  var groups = [];
  var used = {};
  var gre = /<div id="playlist(\d+)"[^>]*>([\s\S]*?)<\/ul>/g;
  while ((m = gre.exec(html)) != null) {
    var sid = m[1];
    var block = m[2];
    var eps = [];
    var ere = /<a[^>]*href=['"](\/vodplay\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/g;
    var e;
    while ((e = ere.exec(block)) != null) {
      var name = stripTags(e[2]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: e[1] });
    }
    if (!eps.length) continue;
    var line = names[sid] || "线路" + sid;
    if (used[line]) line = line + "-" + sid;
    used[line] = 1;
    groups.push({ sid: sid, name: line, eps: eps });
  }
  return groups;
}

function parseDetail(html, id) {
  var name = stripTags(one(html, /<h1 class="vod-title">([\s\S]*?)<\/h1>/));

  var dt = one(html, /<dt>([\s\S]*?)<\/dt>/);
  var pic = attr(dt, "data-original");
  if (!pic) pic = one(dt, /url\(\s*['"]?([^)'"]+)['"]?\s*\)/i);
  var remark = stripTags(one(dt, /<span class="note[^"]*">([\s\S]*?)<\/span>/));
  if (remark === "未知") remark = "";

  var actor = stripTags(one(html, /<li class="[^"]*vod-actor[^"]*">([\s\S]*?)<\/li>/)).replace(/^主演：/, "");
  var director = stripTags(one(html, /<li class="[^"]*vod-director[^"]*">([\s\S]*?)<\/li>/)).replace(/^导演：/, "");
  var area = fieldOf(html, "地区");
  var type = fieldOf(html, "类型");
  var year = fieldOf(html, "年份");

  var content = htmlText(one(html, /<div class="[^"]*\bplot\b[^"]*">([\s\S]*?)<\/div>/));

  var groups = parseGroups(html);

  var from = [];
  var urls = [];
  for (var i = 0; i < groups.length; i++) {
    from.push(groups[i].name);
    var eps = [];
    for (var k = 0; k < groups[i].eps.length; k++) {
      eps.push(groups[i].eps[k].name + "$" + groups[i].eps[k].id);
    }
    urls.push(eps.join("#"));
  }

  var vod = {
    vod_id: String(id),
    vod_name: name || "未知标题",
    vod_pic: absUrl(pic),
    vod_remarks: remark || year,
    vod_year: year,
    vod_area: area,
    vod_type: type,
    vod_director: director,
    vod_actor: actor,
  };

  var text = content;
  if (director) text += "\n导演：" + director;
  if (actor) text += "\n主演：" + actor;
  vod.vod_content = text;

  if (groups.length) {
    vod.vod_play_from = from.join("$$$");
    vod.vod_play_url = urls.join("$$$");
  } else {
    vod.vod_play_from = "无";
    vod.vod_play_url = "暂无播放源$" + id;
  }
  return vod;
}

/* ============================== 播放解析 ============================== */

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 手工 base64 解码（QuickJS 里不一定有 atob），再按 UTF-8 还原 */
function b64decode(s) {
  var str = String(s == null ? "" : s).replace(/[^A-Za-z0-9+/=]/g, "");
  var out = "";
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === "=") break;
    var v = B64.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  try {
    return decodeURIComponent(
      out.replace(/[\s\S]/g, function (ch) {
        var code = ch.charCodeAt(0);
        return "%" + (code < 16 ? "0" : "") + code.toString(16);
      })
    );
  } catch (e) {
    return out;
  }
}

/**
 * player_aaaa 的 url 三种形态都要能接住：
 *   https://...                     正常直链
 *   %68%74%74%70%73%3A%2F%2F...     百分号编码（encrypt=1 但其实是 URL 编码）
 *   aHR0cHM6Ly8...                  base64（老 MacCMS）
 */
function decodePlayUrl(raw) {
  var u = String(raw == null ? "" : raw).replace(/^\s+|\s+$/g, "");
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.indexOf("%") >= 0) {
    try {
      var d = decodeURIComponent(u);
      if (/^https?:\/\//i.test(d)) return d;
    } catch (e) {}
  }
  var b = b64decode(u);
  if (/^https?:\/\//i.test(b)) return b;
  return u;
}

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

/* ============================== 频道与筛选 ============================== */

var CLASSES = [
  { type_id: "dy", type_name: "电影" },
  { type_id: "dsj", type_name: "电视剧" },
  { type_id: "zy", type_name: "综艺" },
  { type_id: "dm", type_name: "动漫" },
  { type_id: "jilupian", type_name: "纪录片" },
  { type_id: "tiyusaishi", type_name: "体育赛事" },
  { type_id: "duanju", type_name: "短剧" },
];

/** 各频道的「类型」筛选项，取自站点 /vodtype/{tid}.html 的标签（2026-10 抓的） */
var TYPES = {
  dy: ["动作", "喜剧", "爱情", "科幻", "恐怖", "剧情", "战争", "警匪", "犯罪", "动画", "奇幻", "武侠"],
  dsj: ["古装", "战争", "青春偶像", "喜剧", "家庭", "犯罪", "动作", "奇幻", "剧情", "历史", "经典", "乡村"],
  zy: ["真人秀", "选秀", "情感", "访谈", "播报", "旅游", "音乐", "美食", "纪实", "曲艺", "生活", "游戏"],
  dm: ["奇幻", "科幻", "热血", "推理", "搞笑", "冒险", "萝莉", "校园", "动作", "机战", "运动", "战争"],
  jilupian: ["自然", "历史", "社会", "人物", "科技", "军事", "犯罪", "美食"],
  tiyusaishi: ["足球", "篮球", "网球", "综合"],
  duanju: ["都市", "古装", "言情", "重生", "反转", "穿越", "惊悚", "悬疑"],
};

function filtersFor(tid) {
  var list = TYPES[tid];
  if (!list) return [];
  var value = [{ n: "全部", v: "" }];
  for (var i = 0; i < list.length; i++) value.push({ n: list[i], v: list[i] });
  return [{ key: "class", name: "类型", value: value }];
}

/* ============================== 诊断卡 ============================== */

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("base = " + BASE, ""));
  rows.push(diagCard("后端 = " + backend(), capsText()));
  rows.push(diagCard("cookie = " + (conf.cookie || "(空)"), "拦截页重试时自动获取"));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var html = fetchHtml("/");
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    var cards = parseCards(html);
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var list = parseCards(fetchHtml("/vodshow/dy--------1---.html"));
    rows.push(diagCard("列表解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("列表异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

/* ============================== 爬虫主体 ============================== */

function readExt(ext) {
  var out = { api: "", ua: "", cookie: "" };
  var raw = ext;
  if (raw && typeof raw === "object" && raw.ext !== undefined && (raw.stype !== undefined || raw.skey !== undefined)) {
    raw = raw.ext;
  }
  if (raw == null) return out;
  if (typeof raw === "object") {
    if (raw.api) out.api = String(raw.api);
    if (raw.ua) out.ua = String(raw.ua);
    if (raw.cookie) out.cookie = String(raw.cookie);
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
      if (o && o.cookie) out.cookie = String(o.cookie);
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
      cookie: e.cookie || "",
    };
    BASE = conf.api;
  },

  home: function (filter) {
    try {
      var list = parseCards(fetchHtml("/"));
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
      return J({ list: parseCards(fetchHtml("/")) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var e = extend || {};
    var page = Math.max(1, Number(pg) || 1);
    var id = String(tid || "dy");
    var cls = e["class"] || "";
    var url = "/vodshow/" + id + "---" + enc(cls) + "-----" + page + "---.html";
    var html = fetchHtml(url, BASE + "/");
    var list = parseCards(html);
    var total = pageCount(html, page);
    return J({ list: list, page: page, pagecount: total, limit: 36, total: total * 36 });
  },

  detail: function (id) {
    if (id === "__diag") {
      var lines = [
        "base = " + BASE,
        "后端 = " + backend(),
        "能力 = " + capsText(),
        "cookie = " + (conf.cookie || "(空)"),
        "最后错误 = " + (lastError || "(无)"),
      ];
      return J({
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
      });
    }
    var html = fetchHtml("/voddetail/" + id + ".html");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = fetchHtml("/vodsearch/" + enc(key) + "----------" + page + "---.html", BASE + "/");
      var list = parseCards(html);
      if (!list.length) {
        html = fetchHtml("/vodsearch/-------------.html?wd=" + enc(key), BASE + "/");
        list = parseCards(html);
      }
      if (!list.length) return J({ list: [diagCard("没有搜到：" + key, "换个关键词试试")], pagecount: 1 });
      var total = pageCount(html, page);
      return J({ list: list, page: page, pagecount: total, limit: 10 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var path = String(id || "");
    if (!path) throw new Error("选集 id 为空（线路：" + flag + "）");
    var html = fetchHtml(path, BASE + "/");
    var m = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(html);
    if (!m) throw new Error("播放页里没找到 player_aaaa（线路：" + flag + "），换一条线路试试");
    var d;
    try {
      d = JSON.parse(m[1]);
    } catch (e) {
      throw new Error("player_aaaa 解析失败：" + errText(e));
    }
    var url = decodePlayUrl(d.url);
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new Error("播放页没给出可用地址（线路：" + flag + "），换一条线路试试");
    }
    return J({
      parse: 0,
      url: fixUrl(url),
      header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" },
    });
  },

  destroy: function () {},
};

export default api;
