/**
 * 星空影视 (www.xiongdaxia.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * MacCMS v10 + 自定义 myui 模板，全站静态 HTML；api.php 采集接口是 404（nginx），
 * 只能解析网页。无需 cookie、无 JS 校验，UA 不校验。
 *
 * 路径（自家一套，注意和常见 /vodxxx 不同）：
 *   首页           /
 *   分类列表       /sortlist/{cid}.html          第 1 页
 *                  /sortlist/{cid}/last-{n}.html 第 n 页（30 条/页，尾页取总页数）
 *   详情           /yingshi/{id}.html            一次给出全部线路 + 全部集数
 *   播放           /play/{vodid}/{epid}.html     script 里 thisUrl 就是 m3u8 直链
 *   搜索           /search.php?keyword={关键词}   第 1 页
 *                  /search/{关键词}/last-{n}.html 第 n 页
 *
 * 三个坑（实测踩过）：
 *   1) 模板类名被随机化（如 class="h0sgXg4AXD topline"），但 myui-vodlist__thumb /
 *      myui-content__detail / myui-content__thumb / pic-text / text-muted / sketch
 *      这些固定 token 都还在 —— 解析只认 token，别认随机串。
 *   2) 卡片的 class 和 href 属性顺序不固定：列表页是 href 在前，搜索页是 class 在前，
 *      所以必须先抓整段 <a ...> 再取属性，不能写死顺序。
 *   3) 列表页卡片封面在 style="background: url(...)"，搜索页在 data-original，
 *      两种都要兜；备注（HD/更新至xx集）在卡片内部的 pic-text span 里。
 *
 * 兼容性（跟 guobayu / cupfox7 / chicey 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://www.xiongdaxia.com";
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

/** 播放页里没找到 thisUrl 时的兜底：MacCMS 的 player_aaaa 可能带 encrypt=1/2（base64） */
var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeB64(s) {
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

/* ============================== 列表解析 ============================== */

/**
 * 卡片：所有详情统一链接 /yingshi/{id}.html，标题在 title 属性。
 *
 * 只认「主网格」：本站列表页顶部有一个 id="type-hot" 的横向轮播推荐块，
 * 每页都塞同样的 15 部片（不在 myui-vodlist 里）。不排除它的话，翻到第 2 页
 * 顶部还是同一批片，看起来像「翻页没生效」。所以先取 <ul class="... myui-vodlist ...">
 * 容器（首页 7 个板块 / 列表页 1 个），搜索页是 myui-vodlist__media、取不到再退回整页。
 *
 * 卡片属性顺序不固定（列表页 href 在前、搜索页 class 在前），所以先抓整段 <a ...>：
 *   封面 → data-original（搜索页）→ style 里的 url(...)（列表页/首页）
 *   备注 → 卡片内 pic-text span（HD / 更新至xx集 / 已完结）
 * 按 id 去重（同一部片会在首页多个板块、侧边推荐里重复出现）。
 */
function gridHtml(html) {
  var out = [];
  var re = /<ul[^>]*class="[^"]*myui-vodlist(?![\w-])[^"]*"[^>]*>([\s\S]*?)<\/ul>/gi;
  var m;
  while ((m = re.exec(html)) != null) out.push(m[1]);
  return out.length ? out.join("\n") : String(html || "");
}

function parseCards(html) {
  var src = gridHtml(html);
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*myui-vodlist__thumb[^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(src)) != null) {
    var attrs = m[1];
    var inner = m[2];

    var hm = /href="([^"]*?\/yingshi\/(\d+)\.html)"/i.exec(attrs);
    if (!hm) continue;
    var id = hm[2];
    if (seen[id]) continue;

    var title = attr(attrs, "title");
    if (!title) {
      var tm = /title="([^"]+)"/i.exec(inner);
      if (tm) title = decodeHtml(tm[1]);
    }
    if (!title) continue;
    seen[id] = 1;

    var pic = attr(attrs, "data-original") || attr(attrs, "data-src") || attr(attrs, "src");
    if (!pic) {
      var bg = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(attrs);
      if (bg) pic = bg[1];
    }
    if (!pic) {
      var im = /data-original="([^"]+)"|data-src="([^"]+)"|src="([^"]+)"/i.exec(inner);
      if (im) pic = im[1] || im[2] || im[3] || "";
    }
    if (!pic) {
      var bg2 = /url\(\s*['"]?([^'")]+)['"]?\s*\)/i.exec(inner);
      if (bg2) pic = bg2[1];
    }

    var rm = /class="[^"]*pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(inner);

    out.push({
      vod_id: id,
      vod_name: title,
      vod_pic: absUrl(pic),
      vod_remarks: rm ? stripTags(rm[1]) : "",
    });
  }
  return out;
}

/**
 * 总页数：分页区「尾页」链接带 /last-{N}.html；取不到再用可视页码 1/1010。
 * 列表和搜索的分页区结构一样，只有路径前缀不同。
 */
function pageCount(html, page, count) {
  var h = String(html || "");
  var m = /last-(\d+)\.html"[^>]*>\s*尾页/.exec(h);
  if (m) {
    var n = Number(m[1]);
    if (n > 0) return n;
  }
  var m2 = />(\d+)\/(\d+)</.exec(h);
  if (m2) {
    var total = Number(m2[2]);
    if (total > 0) return total;
  }
  return page;
}

/* ============================== 详情解析 ============================== */

/** <span class="... text-muted ...">标签：</span>值（截到 </p> 或下一个 text-muted） */
function dataField(block, label) {
  var re = new RegExp('<span class="[^"]*text-muted[^"]*">\\s*' + label + '：\\s*</span>([\\s\\S]*?)(?:</p>|<span)');
  return stripTags(one(block, re));
}

/**
 * 线路 + 集数：线路名在 tab（href="#playlistN"），集数在 div#playlistN 里，
 * 靠 N 配对（本站目前只有一条「星空影视」，但保留多条结构以防站方加线）。
 */
function parseGroups(html) {
  var names = {};
  var m;
  var nre = /<a[^>]*href="#playlist(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = nre.exec(html)) != null) {
    var t = stripTags(m[2]);
    if (t) names[m[1]] = t;
  }

  var groups = [];
  var gre = /<div id="playlist(\d+)"[^>]*>[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/g;
  while ((m = gre.exec(html)) != null) {
    var sid = m[1];
    var block = m[2];
    var eps = [];
    var ere = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;
    var e;
    while ((e = ere.exec(block)) != null) {
      var pm = /href="([^"]*\/play\/[^"]+\.html)"/i.exec(e[1]);
      if (!pm) continue;
      var href = pm[1].replace(/^https?:\/\/[^/]+/i, "");
      var name = attr(e[1], "title") || stripTags(e[2]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: href });
    }
    if (!eps.length) continue;
    groups.push({ sid: sid, name: names[sid] || "线路" + (groups.length + 1), eps: eps });
  }
  return groups;
}

function parseDetail(html, id) {
  var hs = html.indexOf("<h1");
  var ps = html.indexOf('id="playlist');
  var block = hs >= 0 ? html.slice(hs, ps > hs ? ps : html.length) : html;

  var name = stripTags(one(block, /<h1[^>]*>([\s\S]*?)<\/h1>/));
  if (!name) name = stripTags(one(html, /<title>([^<]*)<\/title>/)).replace(/-星空影视.*$/, "");

  // 封面在 myui-content__thumb 里（懒加载：src 是占位图，真地址在 data-original）
  var thumb = one(html, /<div class="[^"]*myui-content__thumb[^"]*"[^>]*>([\s\S]*?)<\/a>/);
  var pic = absUrl(
    one(thumb, /data-original="([^"]+)"/) || one(thumb, /src="([^"]+)"/) || attr(thumb, "src")
  );

  var type = dataField(block, "分类") || dataField(block, "类型");
  var area = dataField(block, "地区");
  var year = dataField(block, "年份");
  var director = dataField(block, "导演");
  var actor = dataField(block, "主演");
  var status = dataField(block, "状态");
  var update = dataField(block, "更新");

  // 简介：详情区 <span class="... sketch ...">；取不到退回 meta description
  var content = stripTags(one(block, /<span class="[^"]*sketch[^"]*"[^>]*>([\s\S]*?)<\/span>/));
  content = content.replace(/详情\s*$/, "").replace(/^\s+|\s+$/g, "");
  if (!content) {
    content = stripTags(one(html, /<meta name="description" content="([^"]*)"/)).replace(
      /^[\s\S]*?剧情[:：]\s*/,
      ""
    );
  }
  if (!content) content = stripTags(one(html, /<h3[^>]*>\s*剧情介绍\s*<\/h3>([\s\S]*?)<\/div>/));

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
    vod_remarks: status || update,
    vod_year: year,
    vod_area: area,
    vod_type: type.replace(/[，,、\s]+$/, ""),
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

/* ============================== 频道与路径 ============================== */

// 分类 id 来自首页导航（/sortlist/{id}.html）：9840~9844 是五个大频道，其余是子分类
var CLASSES = [
  { type_id: "9840", type_name: "电影" },
  { type_id: "9841", type_name: "电视" },
  { type_id: "9842", type_name: "综艺" },
  { type_id: "9843", type_name: "动漫" },
  { type_id: "9844", type_name: "短剧" },
  { type_id: "9850", type_name: "喜剧片" },
  { type_id: "9851", type_name: "爱情片" },
  { type_id: "9852", type_name: "动作片" },
  { type_id: "9853", type_name: "科幻片" },
  { type_id: "9854", type_name: "恐怖片" },
  { type_id: "9855", type_name: "战争片" },
  { type_id: "9856", type_name: "剧情片" },
  { type_id: "9857", type_name: "动画片" },
  { type_id: "9858", type_name: "记录片" },
  { type_id: "9860", type_name: "国产剧" },
  { type_id: "9861", type_name: "港台剧" },
  { type_id: "9862", type_name: "韩国剧" },
  { type_id: "9863", type_name: "日本剧" },
  { type_id: "9864", type_name: "欧美剧" },
  { type_id: "9865", type_name: "泰国剧" },
  { type_id: "9866", type_name: "海外剧" },
  { type_id: "9870", type_name: "大陆综艺" },
  { type_id: "9871", type_name: "港台综艺" },
  { type_id: "9872", type_name: "日韩综艺" },
  { type_id: "9873", type_name: "欧美综艺" },
  { type_id: "9880", type_name: "国产动漫" },
  { type_id: "9881", type_name: "港台动漫" },
  { type_id: "9882", type_name: "日韩动漫" },
  { type_id: "9883", type_name: "欧美动漫" },
];

/** 列表：第 1 页 /sortlist/{cid}.html，第 n 页 /sortlist/{cid}/last-{n}.html */
function buildPath(tid, page) {
  var t = String(tid || "9840").replace(/[^0-9]/g, "") || "9840";
  return page > 1 ? "/sortlist/" + t + "/last-" + page + ".html" : "/sortlist/" + t + ".html";
}

/** 搜索：第 1 页走表单真地址 /search.php?keyword=，第 n 页 /search/{关键词}/last-{n}.html */
function searchPath(key, page) {
  if (page > 1) return "/search/" + enc(key) + "/last-" + page + ".html";
  return "/search.php?keyword=" + enc(key);
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
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    rows.push(diagCard("首页解析到 " + parseCards(html).length + " 张卡片", ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var list = parseCards(fetchHtml("/sortlist/9840.html"));
    rows.push(diagCard("列表解析到 " + list.length + " 张卡片", ""));
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
      return J({ class: CLASSES, filters: {}, list: list });
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
    var page = Math.max(1, Number(pg) || 1);
    var html = fetchHtml(buildPath(tid, page), BASE + "/");
    var list = parseCards(html);
    var pc = pageCount(html, page, list.length);
    return J({ list: list, page: page, pagecount: pc, limit: 30 });
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var vid = String(id).replace(/[^\d]/g, "");
    var html = fetchHtml("/yingshi/" + vid + ".html", BASE + "/");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = fetchHtml(searchPath(key, page), BASE + "/");
      var list = parseCards(html);
      return J({ list: list, page: page, pagecount: pageCount(html, page, list.length), limit: 36 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });

    // 集 id 形如 /play/84696290/168186019.html，取到 84696290/168186019
    var ep = String(id || "")
      .replace(/^https?:\/\/[^/]+/i, "")
      .replace(/^\/?play\//i, "")
      .replace(/\.html.*$/i, "");
    if (!ep) throw new Error("选集 id 为空（线路：" + flag + "）");

    var html = fetchHtml("/play/" + ep + ".html", BASE + "/");

    // 播放页脚本里 thisUrl 就是 m3u8 直链（encrypt 不涉及）
    var url = one(html, /thisUrl\s*=\s*["']([^"']+)["']/i);
    if (!url) url = one(html, /(https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?)/i);
    if (!url) {
      // 少数页可能退回 MacCMS 的 player_aaaa（encrypt 0/1/2）
      var pm = /player_aaaa\s*=\s*(\{[\s\S]*?\})\s*[;<]/i.exec(html);
      if (pm) {
        try {
          var d = JSON.parse(pm[1]);
          url = d.url || "";
          var encNo = Number(d.encrypt);
          if (url && encNo === 1) url = decodeB64(url);
          else if (url && encNo === 2) url = decodeB64(decodeURIComponent(url));
        } catch (e) {
          lastError = "player_aaaa 解析失败：" + errText(e);
        }
      }
    }
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

