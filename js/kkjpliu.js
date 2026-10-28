/**
 * 金牌影院 (www.kkjpliu.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS v10 + myui/jpliu 模板，全站静态 HTML，没有 JS 校验、不需要 cookie。
 * 路径前缀不是常见的 vodxxx，而是自家的一套：
 *
 *   首页        /                                        多段推荐，按 vod_id 去重
 *   分类        /jpliuls/{tid}.html                      分类落地页（只有各子类推荐，不适合翻页）
 *   列表        /jpliuso/{tid}-{地区}-{排序}-{剧情}-{语言}-------{页码}---{年份}.html
 *   详情        /jpliuxq/{id}.html                       一次性给出全部线路 + 全部集数
 *   播放        /jpliugk/{id}-{线路}-{集}.html           player_aaaa.url 就是 m3u8（encrypt=0）
 *   搜索        /jpliusc/{关键词}-------------.html
 *
 * 列表路径是固定 12 段，空段保留（多一个少一个横杠都会被当成别的参数，直接空列表）：
 *   [0] tid  [1] 地区  [2] 排序  [3] 剧情  [4] 语言  [8] 页码  [11] 年份
 * 本站没有年份的界面入口，但 [11] 这个位置确实生效（2024 → 112 页）。
 *
 * 兼容性（跟 guobayu / cupfox7 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://www.kkjpliu.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = {
  api: BASE,
  ua: UA,
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

function httpGet(url, referer) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var opt = { headers: headers(referer), timeout: 20000 };
  var r;
  if (b === "net.req") r = net.req(full, opt);
  else if (b === "req") r = req(full, opt);
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var html = bodyOf(r, full);
  if (!html || html.length < 200)
    throw new Error("返回内容过短（" + (html ? html.length : 0) + " 字节）：" + full);
  return html;
}

function fetchHtml(url, referer) {
  try {
    return httpGet(url, referer);
  } catch (e) {
    lastError = errText(e);
    return httpGet(url, referer);
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

function attr(attrs, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(String(attrs || ""));
  return m ? decodeHtml(m[1]) : "";
}

function absUrl(u) {
  var s = String(u == null ? "" : u).replace(/^\s+|\s+$/g, "").replace(/^['"]|['"]$/g, "");
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.charAt(0) === "/") return BASE + s;
  return BASE + "/" + s;
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

/* ============================== 列表解析 ============================== */

/**
 * 卡片（首页 / 列表 / 搜索 同一套）：
 *   <a class="myui-vodlist__thumb lazyload" href="/jpliuxq/250305.html" title="小羊肖恩3"
 *      data-original="/upload/vod/....webp">
 *     <span class="pic-tag ...">8.0分</span><span class="pic-text text-right">正片</span>
 *   </a>
 * 首页首屏那几张没有 data-original，封面写在 style="background: url(...)" 里，两种都取。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*?)href="\/jpliuxq\/(\d+)\.html"([^>]*)>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var attrs = m[1] + " " + m[3];
    if (attrs.toLowerCase().indexOf("myui-vodlist__thumb") < 0) continue;
    var id = m[2];
    if (seen[id]) continue;
    var name = attr(attrs, "title");
    if (!name) continue;
    seen[id] = 1;

    var pic = attr(attrs, "data-original") || attr(attrs, "src");
    if (!pic) {
      var sm = /url\(([^)]+)\)/.exec(attr(attrs, "style"));
      if (sm) pic = sm[1];
    }

    var close = html.indexOf("</a>", re.lastIndex);
    var inner = close > 0 ? html.substring(re.lastIndex, close) : "";
    var rm = /<span class="pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(inner);

    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(pic),
      vod_remarks: rm ? stripTags(rm[1]) : "",
    });
  }
  return out;
}

/** 总页数从分页条「尾页」链接里取：/jpliuso/{...}-------{页码}---.html，页码固定在第 9 段 */
function pageCount(html, page, count) {
  var m = /href="(\/jpliuso\/[^"]+)"[^>]*>\s*尾页/.exec(String(html == null ? "" : html));
  if (m) {
    var seg = m[1].replace(/^\/jpliuso\//, "").replace(/\.html.*$/i, "").split("-");
    var n = Number(seg[8]);
    if (n > 0) return n;
  }
  return count >= 24 ? page + 1 : page;
}

/* ============================== 详情解析 ============================== */

/** <span class="text-muted">标签：</span>值</p> */
function dataField(html, label) {
  var re = new RegExp("<span class=\"text-muted\">\\s*" + label + "：\\s*</span>([\\s\\S]*?)</p>");
  return stripTags(one(html, re));
}

/**
 * 线路 + 集数。线路名在 tab（href="#playlistN"），集数在 div#playlistN，
 * 靠 N 配对——本站 tab 顺序是乱的（2/1/4/3），不能按出现顺序硬套。
 */
function parseGroups(html) {
  var names = {};
  var m;
  var nre = /<a href="#playlist(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = nre.exec(html)) != null) {
    var t = stripTags(m[2]);
    if (t) names[m[1]] = t;
  }

  var groups = [];
  var gre = /<div id="playlist(\d+)"[^>]*>([\s\S]*?)<\/ul>/g;
  while ((m = gre.exec(html)) != null) {
    var sid = m[1];
    var block = m[2];
    var eps = [];
    var ere = /<a[^>]*href="\/jpliugk\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    var e;
    while ((e = ere.exec(block)) != null) {
      var eid = String(e[1]).replace(/\.html.*$/i, "").replace(/^\//, "");
      if (!eid) continue;
      var name = stripTags(e[2]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: eid });
    }
    if (!eps.length) continue;
    groups.push({ sid: sid, name: names[sid] || "线路" + (groups.length + 1), eps: eps });
  }
  return groups;
}

function parseDetail(html, id) {
  var name = stripTags(one(html, /<h1 class="title[^"]*">([\s\S]*?)<\/h1>/));

  var thumb = one(html, /<div class="myui-content__thumb">([\s\S]*?)<\/div>/);
  var pic = absUrl(attr(thumb, "data-original") || attr(thumb, "src"));
  if (!pic) pic = absUrl(one(html, /<img[^>]*data-original="([^"]+)"/));

  var remark = stripTags(one(thumb, /<span class="pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/));

  // 第一段 data 是三合一：分类：国产动漫 地区：中国大陆 年份：2023
  var info = stripTags(one(html, /<p class="data">([\s\S]*?)<\/p>/));
  var type = one(info, /(?:分类|类型)：\s*([^\s]*)/);
  var area = one(info, /地区：\s*([^\s]*)/);
  var year = one(info, /年份：\s*([^\s]*)/);

  var update = dataField(html, "更新");
  var actor = dataField(html, "主演");
  var director = dataField(html, "导演");

  var content = htmlText(one(html, /<p class="desc[^"]*">([\s\S]*?)<\/p>/));
  content = content.replace(/^简介：\s*/, "").replace(/详情\s*$/, "");

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
    vod_pic: pic,
    vod_remarks: remark || update,
    vod_year: year,
    vod_area: area,
    vod_type: type,
    vod_director: director,
    vod_actor: actor,
  };

  var text = content;
  if (director) text += "\n导演：" + director;
  if (actor) text += "\n主演：" + actor;
  if (update) text += "\n更新：" + update;
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
  { type_id: "1", type_name: "电影" },
  { type_id: "2", type_name: "电视剧" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "5", type_name: "短剧" },
];

/** 子分类是独立的 tid，选它就换掉列表路径的第 1 段 */
var SUBS = {
  "1": [
    ["动作片", "6"], ["喜剧片", "7"], ["爱情片", "8"], ["科幻片", "9"],
    ["恐怖片", "10"], ["剧情片", "11"], ["战争片", "12"], ["纪录片", "13"],
    ["悬疑片", "14"], ["犯罪片", "15"], ["动画片", "16"],
  ],
  "2": [
    ["国产剧", "17"], ["港台剧", "18"], ["日韩剧", "20"], ["欧美剧", "21"], ["海外剧", "22"],
  ],
  "3": [
    ["大陆综艺", "23"], ["港台综艺", "24"], ["日韩综艺", "25"], ["欧美综艺", "26"],
  ],
  "4": [
    ["国产动漫", "27"], ["日韩动漫", "28"], ["欧美动漫", "29"], ["其他动漫", "30"],
  ],
};

var AREAS = ["大陆", "香港", "台湾", "美国", "日本", "韩国", "泰国", "印度", "英国", "法国", "德国", "加拿大", "其他"];
var LANGS = ["国语", "粤语", "英语", "日语", "韩语", "法语", "闽南语", "其它"];
var YEARS = [
  "2026", "2025", "2024", "2023", "2022", "2021", "2020",
  "2019", "2018", "2017", "2016", "2015", "2014", "2013", "2012",
];
var ORDERS = [
  ["最新", "time"],
  ["最热", "hits"],
  ["评分", "score"],
];

function optAll() {
  return [{ n: "全部", v: "" }];
}

function optFlat(list) {
  var out = optAll();
  for (var i = 0; i < list.length; i++) out.push({ n: list[i], v: list[i] });
  return out;
}

function optPairs(pairs) {
  var out = optAll();
  for (var i = 0; i < pairs.length; i++) out.push({ n: pairs[i][0], v: pairs[i][1] });
  return out;
}

function filtersFor(tid) {
  var f = [];
  var subs = SUBS[tid];
  if (subs && subs.length) f.push({ key: "cat", name: "类型", value: optPairs(subs) });
  f.push({ key: "area", name: "地区", value: optFlat(AREAS) });
  f.push({ key: "year", name: "年份", value: optFlat(YEARS) });
  f.push({ key: "lang", name: "语言", value: optFlat(LANGS) });
  f.push({ key: "by", name: "排序", value: optPairs(ORDERS) });
  return f;
}

/**
 * 列表路径固定 12 段，空段必须留着（少一个横杠就变成别的参数，返回空列表）：
 *   [0] tid  [1] 地区  [2] 排序  [3] 剧情  [4] 语言  [8] 页码  [11] 年份
 * 例：/jpliuso/1-大陆-hits----国语----2------.html 之类，具体以拼出来的为准。
 */
function buildPath(tid, page, ext) {
  var s = ["", "", "", "", "", "", "", "", "", "", "", ""];
  var base = String((ext && ext.cat) || "").replace(/[^0-9]/g, "");
  s[0] = base || String(tid || "1");
  if (ext && ext.area) s[1] = ext.area;
  if (ext && ext.by) s[2] = ext.by;
  if (ext && ext.lang) s[4] = ext.lang;
  if (page > 1) s[8] = String(page);
  if (ext && ext.year) s[11] = ext.year;
  return "/jpliuso/" + s.join("-") + ".html";
}

/* ============================== 诊断 ============================== */

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("base = " + BASE, ""));
  rows.push(diagCard("后端 = " + backend(), capsText()));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var html = fetchHtml("/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var list = parseCards(fetchHtml("/jpliuso/1-----------.html"));
    rows.push(diagCard("列表解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("列表异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

function diagnoseDetail() {
  var lines = [
    "base = " + BASE,
    "后端 = " + backend(),
    "能力 = " + capsText(),
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
    conf = {
      api: (e.api || BASE).replace(/\/+$/, ""),
      ua: e.ua || UA,
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
    var html = fetchHtml(buildPath(tid, page, e), BASE + "/");
    var list = parseCards(html);
    var pc = pageCount(html, page, list.length);
    return J({ list: list, page: page, pagecount: pc, limit: 24 });
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var html = fetchHtml("/jpliuxq/" + String(id).replace(/[^\d]/g, "") + ".html");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var url =
        page > 1
          ? "/jpliusc/" + enc(key) + "----------" + page + "---.html"
          : "/jpliusc/" + enc(key) + "-------------.html";
      var html = fetchHtml(url, BASE + "/");
      var list = parseCards(html);
      return J({ list: list, page: page, pagecount: list.length >= 18 ? page + 1 : page, limit: 20 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var ep = String(id || "")
      .replace(/^\/?jpliugk\//i, "")
      .replace(/\.html.*$/i, "");
    if (!ep) throw new Error("选集 id 为空（线路：" + flag + "）");

    var html = fetchHtml("/jpliugk/" + ep + ".html", BASE + "/jpliuxq/" + ep.split("-")[0] + ".html");
    var m = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(html);
    var url = "";
    if (m) {
      var d;
      try {
        d = JSON.parse(m[1]);
      } catch (e) {
        throw new Error("player_aaaa 解析失败：" + errText(e));
      }
      url = d.url || "";
      if (url) {
        if (Number(d.encrypt) === 1) url = b64decode(url);
        else if (Number(d.encrypt) === 2) url = b64decode(decodeURIComponent(url));
      }
    }
    if (!url) url = one(html, /(https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?)/);
    if (!url) throw new Error("播放页里没找到播放地址（线路：" + flag + "），换一集或换条线路试试");

    return J({
      parse: 0,
      url: fixUrl(url),
      header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" },
    });
  },

  destroy: function () {},
};

export default api;
