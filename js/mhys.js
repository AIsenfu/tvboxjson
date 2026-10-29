/**
 * 麻花影视 (mh-ys.cc) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是自研模板（不是标准 MacCMS：/api.php/provide/vod/ 直接 404），
 * 只能走网页解析。好在结构很规整，全部用固定 class 定位：
 *
 *   首页      /                                  网格卡（a.tcl-img + p.tc_wz）
 *   分类      /mh-ys/{slug}--------{页码}---/     18 条/页，尾页链接里带总页数
 *   详情      /mhml/{id}/                         p.zy 主演、年份/地区/类型、线路 tab + 集数
 *   播放      /mhyskan/{id}-{源}-{集}/            player_aaaa.url 就是 m3u8
 *   搜索      /smho/-------------/?wd={词}&page={页码}   10 条/页
 *
 * 几个要点：
 *   1. 列表卡有两种版式：网格卡（class="tcl-img" + p.tc_wz 备注/评分）
 *      和搜索结果卡（class="result_list" + .reuslt_score），解析器两种都认。
 *   2. 线路名是 tab 上的缩写（IK / FF / SN / BF / YZ / SDZY），
 *      集数在 `#tab_con_playlist_{n}` 里，靠 tab 序号对应。
 *   3. 播放页 player_aaaa 的 encrypt=0（明文 m3u8）；仍按 encrypt=1/2 做了兜底
 *      （先 decodeURIComponent 再 base64），站点改版不用改代码。
 *   4. m3u8 是公开直链，裸请求 200 不用 Referer；play() 还是把 UA/Referer 带上，
 *      防止哪天开了防盗链。
 *
 * 兼容性（跟合集里其它脚本同一套策略）：
 *   - 不假设 net 存在：net.req → req → http 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - ES5 写法，不依赖 getUserAgent / atob，UA 与 base64 自己实现
 *   - 任何一步失败都给「诊断卡」，不在 App 里留空白
 */

var BASE = "https://mh-ys.cc";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = { api: BASE, ua: UA };
var lastError = "";

/* 分类：站点导航里的 slug，全部实测可用（每个 18 条/页） */
var CLASSES = [
  { type_id: "dianying", type_name: "电影" },
  { type_id: "dianshiju", type_name: "电视剧" },
  { type_id: "zongyi", type_name: "综艺" },
  { type_id: "dongman", type_name: "动漫" },
  { type_id: "duanju", type_name: "短剧" },
  { type_id: "yingshijieshuo", type_name: "影视解说" },
  { type_id: "dongzuopian", type_name: "动作片" },
  { type_id: "xijupian", type_name: "喜剧片" },
  { type_id: "aiqingpian", type_name: "爱情片" },
  { type_id: "kehuanpian", type_name: "科幻片" },
  { type_id: "kongbupian", type_name: "恐怖片" },
  { type_id: "juqingpian", type_name: "剧情片" },
  { type_id: "jilupian", type_name: "纪录片" },
  { type_id: "zhanzhengpian", type_name: "战争片" },
  { type_id: "xuanyipian", type_name: "悬疑片" },
  { type_id: "guochanju", type_name: "国产剧" },
  { type_id: "gangtaiju", type_name: "港台剧" },
  { type_id: "rihanju", type_name: "日韩剧" },
  { type_id: "oumeiju", type_name: "欧美剧" },
  { type_id: "haiwaiju", type_name: "海外剧" },
  { type_id: "daluzongyi", type_name: "大陆综艺" },
  { type_id: "rihanzongyi", type_name: "日韩综艺" },
  { type_id: "gangtaizongyi", type_name: "港台综艺" },
  { type_id: "oumeizongyi", type_name: "欧美综艺" },
];

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
  return {
    "User-Agent": conf.ua || UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: referer || conf.api + "/",
  };
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

/** 同步 GET 文本 */
function httpGet(url, referer) {
  var full = /^https?:\/\//i.test(url) ? url : conf.api + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var opt = { headers: headers(referer), timeout: 20000 };
  var r;
  if (b === "net.req") r = net.req(full, opt);
  else if (b === "req") r = req(full, opt);
  else if (b === "http") r = http(full, { headers: opt.headers, timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var text = bodyOf(r, full);
  if (!text) throw new Error("空响应：" + full);
  if (text.length < 500 && /访问验证|人机验证|Just a moment/i.test(text)) {
    throw new Error("被站点验证页拦截（返回 " + text.length + " 字节）");
  }
  return text;
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

/* ============================== base64 兜底解码 ============================== */

var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 不依赖 atob 的 base64 解码（播放地址 encrypt=1/2 时兜底用） */
function b64decode(str) {
  var s = String(str == null ? "" : str).replace(/[^A-Za-z0-9+/=]/g, "");
  var out = "";
  var i = 0;
  while (i + 3 < s.length + 1) {
    var c1 = B64CHARS.indexOf(s.charAt(i));
    var c2 = B64CHARS.indexOf(s.charAt(i + 1));
    var c3 = B64CHARS.indexOf(s.charAt(i + 2));
    var c4 = B64CHARS.indexOf(s.charAt(i + 3));
    if (c1 < 0 || c2 < 0) break;
    out += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 >= 0) out += String.fromCharCode(((c3 & 3) << 6) | c4);
    i += 4;
  }
  // 还原 UTF-8（base64 里如果带中文路径）
  try {
    return decodeURIComponent(
      out.replace(/[\s\S]/g, function (c) {
        var code = c.charCodeAt(0);
        return code < 128 ? c : "%" + ("0" + code.toString(16)).slice(-2);
      })
    );
  } catch (e) {
    return out;
  }
}

/** player_aaaa 里的 url 可能被编码过，按 encrypt 逐层还原 */
function decodePlayUrl(url, encrypt) {
  var u = String(url == null ? "" : url);
  if (!u) return "";
  if (!encrypt) return u;
  // encrypt=1：常见是百分号编码；encrypt=2：base64(百分号编码)
  if (/^https?:\/\//i.test(u)) return u;
  var tries = [];
  try {
    tries.push(decodeURIComponent(u));
  } catch (e) {
    /* ignore */
  }
  tries.push(b64decode(u));
  for (var i = 0; i < tries.length; i++) {
    var t = String(tries[i] || "");
    if (/^https?:\/\//i.test(t)) return t;
    try {
      var t2 = decodeURIComponent(t);
      if (/^https?:\/\//i.test(t2)) return t2;
    } catch (e2) {
      /* ignore */
    }
  }
  return u;
}

/* ============================== 列表卡解析 ============================== */

/**
 * 首页 / 分类 / 搜索 三种页面的卡片统一解析。
 * 锚点只有两种：网格卡的 a.tcl-img、搜索结果卡的 div.result_list；
 * 以锚点为界切片，再从片段里取 id / 标题 / 封面 / 备注。
 */
function parseCards(html) {
  var marks = [];
  var re = /<a href="\/mhml\/(\d+)\/" class="tcl-img"|<div class="result_list">/g;
  var m;
  while ((m = re.exec(html))) marks.push(m.index);
  var out = [];
  var seen = {};
  for (var i = 0; i < marks.length; i++) {
    var start = marks[i];
    var end = i + 1 < marks.length ? marks[i + 1] : Math.min(html.length, start + 2000);
    var seg = html.slice(start, end);

    var idm = seg.match(/\/mhml\/(\d+)\//);
    if (!idm) continue;
    var id = idm[1];
    if (seen[id]) continue;
    seen[id] = 1;

    var t1 = seg.match(/title="([^"]*)"/);
    var t2 = seg.match(/class="result_title"[^>]*>\s*<a[^>]*>([^<]*)</);
    var name = decodeHtml((t1 ? t1[1] : "") || (t2 ? t2[1] : "")).replace(/^\s+|\s+$/g, "");

    var picm = seg.match(/data-original="([^"]*)"/);
    var pic = picm ? picm[1] : "";
    if (pic && !/^https?:\/\//i.test(pic)) pic = conf.api + (pic.charAt(0) === "/" ? pic : "/" + pic);

    var rm = seg.match(/<p class="tc_wz">([^<]*)</) || seg.match(/class="reuslt_score">([^<]*)</);
    var remarks = rm ? decodeHtml(rm[1]).replace(/^\s+|\s+$/g, "") : "";

    if (!name) name = "未知标题";
    out.push({ vod_id: id, vod_name: name, vod_pic: pic, vod_remarks: remarks });
  }
  return out;
}

/* ============================== 详情页解析 ============================== */

function field(html, re) {
  var m = html.match(re);
  return m ? decodeHtml(m[1]).replace(/^\s+|\s+$/g, "") : "";
}

/** 主演 / 导演这类「一串 <a>」的字段，拼成逗号串 */
function anchors(html, re) {
  var m = html.match(re);
  if (!m) return "";
  var arr = [];
  var re2 = />([^<>]{1,40})<\/a>/g;
  var a;
  while ((a = re2.exec(m[1]))) {
    var t = decodeHtml(a[1]).replace(/^\s+|\s+$/g, "");
    if (t && t !== "更多" && arr.indexOf(t) < 0) arr.push(t);
  }
  return arr.join(",");
}

/** 线路 + 集数：tab 名和 tab-content 靠序号对应 */
function parsePlayLines(html) {
  var names = {};
  var reName = /switch="tab_con_playlist_(\d+)"[^>]*><a[^>]*>([^<]*)<\/a>/g;
  var m;
  while ((m = reName.exec(html))) {
    var nm = decodeHtml(m[2]).replace(/^\s+|\s+$/g, "");
    if (nm) names[m[1]] = nm;
  }

  var marks = [];
  var reTab = /<div class="tab-content" id="tab_con_playlist_(\d+)"/g;
  while ((m = reTab.exec(html))) marks.push({ idx: m.index, no: m[1] });

  var froms = [];
  var urls = [];
  for (var i = 0; i < marks.length; i++) {
    var start = marks[i].idx;
    var end = i + 1 < marks.length ? marks[i + 1].idx : html.length;
    var seg = html.slice(start, end);

    var eps = [];
    var reEp = /href="(\/mhyskan\/[^"]+)"[^>]*title="([^"]*)"/g;
    var e;
    while ((e = reEp.exec(seg))) {
      var epName = decodeHtml(e[2]).replace(/^\s+|\s+$/g, "");
      if (!epName) epName = "第" + (eps.length + 1) + "集";
      eps.push(epName + "$" + e[1]);
    }
    if (!eps.length) continue;

    froms.push(names[marks[i].no] || "线路" + marks[i].no);
    urls.push(eps.join("#"));
  }
  return { from: froms.join("$$$"), url: urls.join("$$$"), count: froms.length };
}

function parseDetail(html, id) {
  var name =
    field(html, /<h1[^>]*>\s*<a[^>]*title="([^"]*)"/) || field(html, /<h1[^>]*>([\s\S]{0,120}?)<\/h1>/);
  if (name && name.indexOf("<") >= 0) name = stripTags(name);

  var pic = field(html, /class="leftimg">[\s\S]{0,200}?data-original="([^"]*)"/);
  if (pic && !/^https?:\/\//i.test(pic)) pic = conf.api + (pic.charAt(0) === "/" ? pic : "/" + pic);

  var lines = parsePlayLines(html);

  var vod = {
    vod_id: String(id),
    vod_name: name,
    vod_pic: pic,
    vod_remarks: field(html, /状态：<span><span[^>]*>([^<]*)</),
    vod_year: field(html, /年份：<span>([^<]*)</),
    vod_area: field(html, /地区：<span>([^<]*)</),
    vod_type: field(html, /类型：<span><a[^>]*>([^<]*)</),
    vod_director: anchors(html, /导演：<span>([\s\S]{0,600}?)<\/span>/),
    vod_actor: anchors(html, /主演：<span>([\s\S]*?)<\/span>\s*<\/p>/),
    vod_content: stripTags(field(html, /简介：<a[^>]*>详情<\/a><span>([\s\S]{0,2000}?)<\/span>/)),
    vod_play_from: lines.from,
    vod_play_url: lines.url,
  };
  return vod;
}

/* ============================== 诊断卡 ============================== */

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}

function diagnose() {
  var rows = [];
  rows.push(diagCard("api = " + conf.api, ""));
  rows.push(diagCard("后端 = " + backend(), capsText()));
  rows.push(diagCard("最后错误 = " + (lastError || "(无)"), ""));
  try {
    var html = httpGet("/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", html.length + " 字节 / " + cards.length + " 张卡"));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var h2 = httpGet("/mh-ys/dianying--------1---/");
    rows.push(diagCard("分类页 GET 成功", h2.length + " 字节 / " + parseCards(h2).length + " 张卡"));
  } catch (e) {
    rows.push(diagCard("分类页异常：" + errText(e), ""));
  }
  try {
    var h3 = httpGet("/smho/-------------/?wd=" + enc("庆余年") + "&page=1");
    rows.push(diagCard("搜索 GET 成功", h3.length + " 字节 / " + parseCards(h3).length + " 张卡"));
  } catch (e) {
    rows.push(diagCard("搜索异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

/* ============================== 播放页解析 ============================== */

function parsePlayer(html) {
  var i = html.indexOf("player_aaaa=");
  if (i < 0) return null;
  var j = html.indexOf("</script>", i);
  var raw = html.slice(i + "player_aaaa=".length, j < 0 ? html.length : j);
  raw = raw.replace(/^\s+|\s+$/g, "").replace(/;\s*$/, "");
  try {
    return JSON.parse(raw);
  } catch (e) {
    lastError = "player_aaaa 解析失败：" + errText(e);
  }
  // 兜底：正则抠 url
  var m = raw.match(/"url"\s*:\s*"([^"]+)"/);
  if (m) return { url: m[1].replace(/\\\//g, "/"), encrypt: 0 };
  return null;
}

/* ============================== 爬虫主体 ============================== */

var api = {
  init: function (ext) {
    var apiBase = "";
    if (ext && typeof ext === "object" && ext.api) apiBase = String(ext.api);
    else if (typeof ext === "string" && /^https?:\/\//i.test(ext)) apiBase = ext;
    if (apiBase) {
      conf.api = apiBase.replace(/\/+$/, "");
      BASE = conf.api;
    }
  },

  home: function (filter) {
    try {
      var html = httpGet("/");
      var cards = parseCards(html);
      if (!cards.length) throw new Error("首页没解析出卡片（可能改版）");
      return J({ class: CLASSES, filters: {}, list: cards.slice(0, 60) });
    } catch (e) {
      lastError = errText(e);
      return J({
        class: CLASSES,
        filters: {},
        list: [diagCard("首页失败：" + errText(e), "后端：" + backend())],
      });
    }
  },

  homeVod: function () {
    try {
      var cards = parseCards(httpGet("/"));
      return J({ list: cards.slice(0, 60) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var page = Math.max(1, Number(pg) || 1);
    var slug = String(tid || "").replace(/[^a-z0-9_]/gi, "") || "dianying";
    try {
      var html = httpGet("/mh-ys/" + slug + "--------" + page + "---/");
      var cards = parseCards(html);
      var pagecount = 1;
      var last = html.match(/--------(\d+)---\/"[^>]*>尾页</);
      if (last) pagecount = Math.max(1, Number(last[1]) || 1);
      if (!cards.length && page === 1) throw new Error("分类「" + slug + "」第 1 页没有卡片");
      return J({ list: cards, page: page, pagecount: pagecount, limit: 18, total: pagecount * 18 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("分类失败：" + errText(e), "")], page: page, pagecount: 1, limit: 18, total: 0 });
    }
  },

  detail: function (id) {
    if (id === "__diag") {
      var lines = [
        "api = " + conf.api,
        "后端 = " + backend(),
        "能力 = " + capsText(),
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
    try {
      var vid = String(id).replace(/[^0-9]/g, "");
      if (!vid) throw new Error("id 不合法：" + id);
      var vod = parseDetail(httpGet("/mhml/" + vid + "/"), vid);
      if (!vod.vod_name) throw new Error("详情页没解析出片名（可能改版）");
      return J({ list: [vod] });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("详情失败：" + errText(e), "")] });
    }
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = httpGet("/smho/-------------/?wd=" + enc(key) + "&page=" + page);
      var cards = parseCards(html);
      var total = 0;
      var tm = html.match(/\$\('#total'\)\.text\('(\d+)'\)/);
      if (tm) total = Number(tm[1]) || 0;
      var pagecount = total ? Math.max(1, Math.ceil(total / 10)) : 1;
      return J({ list: cards, page: page, pagecount: pagecount, limit: 10, total: total });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], page: page, pagecount: 1, limit: 10, total: 0 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var target = String(id == null ? "" : id);
    if (!target) throw new Error("选集地址为空（线路：" + flag + "）");
    if (/^https?:\/\//i.test(target)) {
      return J({ parse: 0, url: target, header: headers(conf.api + "/") });
    }
    try {
      var html = httpGet(target, conf.api + "/");
      var p = parsePlayer(html);
      if (!p || !p.url) throw new Error("播放页里没找到 player_aaaa.url");
      var url = decodePlayUrl(p.url, Number(p.encrypt) || 0);
      if (!/^https?:\/\//i.test(url)) throw new Error("播放地址不是 http 链接：" + String(url).substring(0, 60));
      return J({ parse: 0, url: url, header: headers(conf.api + "/") });
    } catch (e) {
      lastError = errText(e);
      throw new Error("取播放地址失败：" + errText(e));
    }
  },

  destroy: function () {},
};

export default api;
