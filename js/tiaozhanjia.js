/**
 * 樱花影视 (www.tiaozhanjia.com) —— FongMi/TV 爬虫脚本
 * ==================================================================
 * 站点：MacCMS v10 + lansetui_two 模板，全静态 HTML，无 cookie、无反爬。
 *       官方 JSON 接口 /api.php/provide/vod/ 返回 404（关闭），只能抓 HTML。
 *       模板 class 名带随机前缀（如 "PfcETYe0vD"），但 stui-* 稳定类名保留，
 *       所以全部按 stui-* 定位，不依赖随机串。
 *
 * 路径（实测 2026-10）：
 *   首页     /                                   5 个 ul.stui-vodlist，每个 12 张 = 60 张
 *   分类     /category/{cid}.html                30 张/页
 *            /category/{cid}/last-{n}.html       第 n 页（页 1 = 无后缀）
 *   详情     /shipin/{id}.html                   h1.title、stui-content__thumb 封面、
 *                                                ul.stui-content__playlist 选集
 *   播放     /play/{vod}/{epid}.html             页面里 thisUrl = "https://...m3u8" 直出，
 *                                                没有 player_aaaa / encrypt
 *   搜索     /sousuo/{kw}.html                   30 张/页
 *            /sousuo/{kw}/last-{n}.html          第 n 页
 *   注意：/index.php/vod/search.html?wd= 会 302 回首页（返回的是首页内容，
 *         不是搜索结果），不能拿来搜索；翻页也别用 query 参数（会被忽略）。
 *
 * 兼容策略（同 guobayu.js / cupfox7.js）：
 *   - 不假设 net 存在：net.req → req → http 依次探测
 *   - 全同步请求，每个方法直接 return JSON 字符串
 *   - 解析失败时首页给「诊断」分类，点进去能看到每个环节的报错
 * ==================================================================
 */

var BASE = "https://www.tiaozhanjia.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = { api: BASE, ua: UA };
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
  var r;
  if (b === "net.req") r = net.req(full, { headers: headers(referer), timeout: 20000 });
  else if (b === "req") r = req(full, { headers: headers(referer), timeout: 20000 });
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var html = bodyOf(r, full);
  if (!html || html.length < 150) throw new Error("返回内容过短（" + (html ? html.length : 0) + " 字节）：" + full);
  return html;
}
function fetchHtml(url, referer) {
  try {
    return httpGet(url, referer);
  } catch (e) {
    lastError = errText(e);
    throw e;
  }
}
function one(s, re) {
  var m = re.exec(String(s == null ? "" : s));
  return m ? m[1] : "";
}
function all(s, re) {
  var out = [],
    r = new RegExp(re.source, "g"),
    m;
  while ((m = r.exec(String(s == null ? "" : s))) != null) {
    out.push(m[1]);
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return out;
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
      var c = Number(d);
      return c ? String.fromCharCode(c) : a;
    })
    .replace(/&#x([0-9a-f]+);/gi, function (a, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
}
function stripTags(s) {
  return decodeHtml(String(s == null ? "" : s).replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
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
/** class 里是否有独立 token（避免 stui-vodlist 匹配到 stui-vodlist__text） */
function hasToken(cls, token) {
  return (" " + String(cls || "") + " ").indexOf(" " + token + " ") >= 0;
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

/* ============================== 列表解析 ============================== */

/**
 * 卡片（首页/分类/搜索同一套结构）：
 *   <ul class="{随机} stui-vodlist clearfix">
 *     <li class="...">
 *       <a class="{随机} stui-vodlist__thumb lazyload" href=".../shipin/{id}.html"
 *          title="{name}" data-original="{pic}">
 *         <span class="... play hidden-xs"></span>
 *         <span class="... pic-text text-right">{remarks}</span>
 *       </a>
 *       <div class="... stui-vodlist__detail">
 *         <h4 class="..."><a href=".../shipin/{id}.html" title="{name}">{name}</a></h4>
 *         ...
 * 只认 ul.stui-vodlist 块里的 a.stui-vodlist__thumb，这样能避开：
 *   - 分类页顶部的 10 张「推荐」大卡（不在 ul 里，单独一排）
 *   - 侧栏排行榜 ul.stui-vodlist__text
 *   - 同一卡片的第二个标题链接（h4 里那个，没有 thumb 类）
 */
function scanCards(block) {
  var out = [],
    seen = {},
    a,
    re = /<a\b([^>]*?)href="((?:https?:\/\/[^"]*?)?\/shipin\/(\d+)\.html)"([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((a = re.exec(block)) != null) {
    var attrs = a[1] + " " + a[4];
    if (!hasToken(attr(attrs, "class"), "stui-vodlist__thumb")) continue;
    var id = a[3];
    if (!id || seen[id]) continue;
    var name = attr(attrs, "title") || stripTags(a[5]);
    if (!name) continue;
    seen[id] = 1;
    var remarks = "";
    var sre = /<span[^>]*class="[^"]*pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
      s;
    while ((s = sre.exec(a[5])) != null) {
      var t = stripTags(s[1]);
      if (t) remarks = t;
    }
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(
        attr(attrs, "data-original") || attr(attrs, "src") || one(a[5], /<img[^>]*data-original="([^"]+)"/i)
      ),
      vod_remarks: remarks,
    });
  }
  return out;
}

function parseCards(html) {
  var out = [],
    seen = {},
    m,
    re = /<ul\b([^>]*)>/gi;
  while ((m = re.exec(html)) != null) {
    if (!hasToken(attr(m[1], "class"), "stui-vodlist")) continue;
    var end = html.indexOf("</ul>", re.lastIndex);
    var block = html.substring(re.lastIndex, end < 0 ? html.length : end);
    var cards = scanCards(block);
    for (var i = 0; i < cards.length; i++) {
      if (seen[cards[i].vod_id]) continue;
      seen[cards[i].vod_id] = 1;
      out.push(cards[i]);
    }
  }
  // 兜底：站点改版把卡片挪出 ul 时，仍按全局扫一遍
  if (!out.length) out = scanCards(html);
  return out;
}

/**
 * 总页数：优先看页码里的 <span class="{随机} num">1/1008</span>（分类/搜索都有），
 * 退而求其次找 /last-{n}.html 链接里最大的 n，最后按本页条数猜。
 */
function pageCount(html, page, size, count) {
  var m = /class="[^"]*\bnum\b[^"]*"[^>]*>\s*\d+\s*\/\s*(\d+)\s*</i.exec(String(html || ""));
  if (m) return Math.max(1, Number(m[1]));
  var nums = all(html, /\/last-(\d+)\.html/g).map(Number);
  var max = 0;
  for (var i = 0; i < nums.length; i++) if (nums[i] > max) max = nums[i];
  if (max > 0) return max;
  return count >= (size || 20) ? page + 1 : page;
}

/* ============================== 详情解析 ============================== */

/**
 * 详情页元数据：<span class="{随机} text-muted">类型：</span><a ...>喜剧</a>
 *                        <span class="... split-line"></span><span>地区：</span>...
 * 一个 <p class="... data"> 里可能塞好几个字段，所以捕获到「下一个 text-muted
 * 标签或 </p>」为止；split-line 是分隔点，换成 " / "。
 */
function dataField(html, label) {
  var re = new RegExp(
    "<span[^>]*text-muted[^>]*>\\s*" + label + "：\\s*</span>([\\s\\S]*?)(?=<span[^>]*text-muted|</p>)"
  );
  var raw = one(html, re);
  raw = raw.replace(/<span[^>]*split-line[^>]*>\s*<\/span>/gi, " / ");
  // 站点偶尔漏写分隔符（相邻 <a> 直接挨着），补一个
  raw = raw.replace(/<\/a>\s*(?=<a\b)/gi, "</a> / ");
  var s = stripTags(raw);
  s = s.replace(/(?:\s*\/\s*)+/g, " / ").replace(/^\s*\/\s*|\s*\/\s*$/g, "");
  return s.replace(/^\s+|\s+$/g, "");
}

/** 简介：完整版在 <div id="desc"> 里的 <p class="... col-pd"><p>正文</p> */
function detailText(html) {
  var t = "";
  var i = html.indexOf('id="desc"');
  if (i >= 0) {
    var seg = html.substring(i, i + 8000);
    t = one(seg, /<p[^>]*class="[^"]*col-pd[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    if (!t) t = one(seg, /<p>\s*([\s\S]*?)<\/p>/i);
  }
  if (!t) t = one(html, /<p[^>]*class="[^"]*\bdesc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  var s = htmlText(t);
  s = s.replace(/^(?:剧情简介|简介)\s*/, "").replace(/\s*详情\s*$/, "");
  return s.replace(/^\s+|\s+$/g, "");
}

/**
 * 线路 + 集数：详情页每个 ul.stui-content__playlist 是一条线路，
 *   <li><a title="第01集" href=".../play/{vod}/{epid}.html">第01集</a></li>
 * 本站样本全部只有 1 条线路；多线路时按 ul 顺序起名（tab 名优先）。
 * 集 id 存成 "{vod}/{epid}"，play() 拼回 /play/{vod}/{epid}.html。
 */
function parseGroups(html) {
  var groups = [],
    m;
  var tabNames = {},
    tm,
    tre = /<a[^>]*href="#playlist(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((tm = tre.exec(html)) != null) tabNames[tm[1]] = stripTags(tm[2]);

  var re = /<ul\b([^>]*)>/gi;
  while ((m = re.exec(html)) != null) {
    if (!hasToken(attr(m[1], "class"), "stui-content__playlist")) continue;
    var end = html.indexOf("</ul>", re.lastIndex);
    var block = html.substring(re.lastIndex, end < 0 ? html.length : end);
    var eps = [],
      e,
      ere = /<a\b([^>]*)href="[^"]*?\/play\/(\d+)\/([^"\/]+?)\.html"([^>]*)>([\s\S]*?)<\/a>/gi;
    while ((e = ere.exec(block)) != null) {
      var attrs = e[1] + " " + e[4];
      var name = stripTags(attr(attrs, "title")) || stripTags(e[5]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: e[2] + "/" + e[3] });
    }
    if (!eps.length) continue;
    var idx = groups.length;
    groups.push({
      name: tabNames[String(idx + 1)] || (idx === 0 ? "樱花线路" : "线路" + (idx + 1)),
      eps: eps,
    });
  }
  return groups;
}

function parseDetail(html, id) {
  var name = stripTags(one(html, /<h1[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i));
  if (!name) name = stripTags(one(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));

  var thumb = one(html, /<div[^>]*class="[^"]*stui-content__thumb[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  var pic = absUrl(attr(thumb, "data-original") || attr(thumb, "src"));
  if (!pic) pic = absUrl(one(html, /<img[^>]*data-original="([^"]+)"[^>]*>/i));

  var remarks = stripTags(one(html, /<span[^>]*class="[^"]*pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i));
  var type = dataField(html, "类型");
  var area = dataField(html, "地区");
  var year = dataField(html, "年份");
  var director = dataField(html, "导演");
  var actor = dataField(html, "主演");
  var content = detailText(html);

  var groups = parseGroups(html);
  var from = [],
    urls = [];
  for (var i = 0; i < groups.length; i++) {
    from.push(groups[i].name);
    var eps = [];
    for (var k = 0; k < groups[i].eps.length; k++) eps.push(groups[i].eps[k].name + "$" + groups[i].eps[k].id);
    urls.push(eps.join("#"));
  }

  var text = content;
  if (director) text += "\n导演：" + director;
  if (actor) text += "\n主演：" + actor;

  var vod = {
    vod_id: String(id),
    vod_name: name || "未知标题",
    vod_pic: pic,
    vod_remarks: remarks,
    vod_year: year,
    vod_area: area,
    vod_type: type,
    vod_actor: actor,
    vod_director: director,
    vod_content: text,
  };
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
  { type_id: "3716", type_name: "电影" },
  { type_id: "3717", type_name: "电视" },
  { type_id: "3718", type_name: "综艺" },
  { type_id: "3719", type_name: "动漫" },
  { type_id: "3720", type_name: "短剧" },
];

var SUBS = [
  ["3726", "喜剧片"], ["3727", "爱情片"], ["3728", "动作片"], ["3729", "科幻片"],
  ["3730", "恐怖片"], ["3731", "战争片"], ["3732", "剧情片"], ["3733", "动画片"], ["3734", "记录片"],
  ["3736", "国产剧"], ["3737", "港台剧"], ["3738", "韩国剧"], ["3739", "日本剧"],
  ["3740", "欧美剧"], ["3741", "泰国剧"], ["3742", "海外剧"],
  ["3746", "大陆综艺"], ["3747", "港台综艺"], ["3748", "日韩综艺"], ["3749", "欧美综艺"],
  ["3756", "国产动漫"], ["3757", "港台动漫"], ["3758", "日韩动漫"], ["3759", "欧美动漫"],
];

function filtersFor() {
  var v = [{ n: "全部", v: "" }];
  for (var i = 0; i < SUBS.length; i++) v.push({ n: SUBS[i][1], v: SUBS[i][0] });
  return [{ key: "cat", name: "类型", value: v }];
}

/* ============================== 诊断 ============================== */

function diagCard(title, remark) {
  return { vod_id: "__diag", vod_name: "! " + title, vod_pic: "", vod_remarks: remark || "" };
}
function diagnose() {
  var rows = [];
  rows.push(diagCard("api = " + BASE, "后端 " + backend() + "（" + capsText() + "）"));
  if (lastError) rows.push(diagCard("上次错误", lastError));
  try {
    var html = fetchHtml("/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", html.length + " 字节"));
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : "解析为空"));
    if (cards.length) {
      try {
        var v = parseDetail(fetchHtml("/shipin/" + cards[0].vod_id + ".html"), cards[0].vod_id);
        var froms = String(v.vod_play_from).split("$$$");
        var line0 = String(v.vod_play_url).split("$$$")[0];
        rows.push(diagCard("详情：" + v.vod_name, "线路 " + froms.length + "、" + line0.split("#").length + " 集"));
        try {
          var p = JSON.parse(api.play(froms[0], line0.split("#")[0].split("$")[1]));
          rows.push(diagCard("播放直链 OK", String(p.url).slice(0, 70)));
        } catch (e2) {
          rows.push(diagCard("播放异常", errText(e2)));
        }
      } catch (e3) {
        rows.push(diagCard("详情异常", errText(e3)));
      }
    }
  } catch (e) {
    rows.push(diagCard("首页异常", errText(e)));
  }
  try {
    var list = parseCards(fetchHtml("/category/3716.html"));
    rows.push(diagCard("分类 3716 解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : "解析为空"));
  } catch (e4) {
    rows.push(diagCard("分类异常", errText(e4)));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}
function diagnoseDetail() {
  return {
    list: [
      {
        vod_id: "__diag",
        vod_name: "诊断信息",
        vod_pic: "",
        vod_content: "api=" + BASE + "\n后端=" + backend() + "\n能力=" + capsText() + "\n最后错误=" + (lastError || "(无)"),
        vod_play_from: "诊断",
        vod_play_url: "第1集$__diag",
      },
    ],
  };
}

/* ============================== ext 解析 ============================== */

function readExt(ext) {
  var out = { api: "", ua: "" },
    raw = ext;
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

/* ============================== 爬虫主体 ============================== */

var api = {
  init: function (ext) {
    var e = readExt(ext);
    conf = { api: (e.api || BASE).replace(/\/+$/, ""), ua: e.ua || UA };
    BASE = conf.api;
  },

  home: function (filter) {
    try {
      var list = parseCards(fetchHtml("/"));
      if (!list.length) throw new Error("首页没有解析到影片，可能页面结构变了");
      var filters = {};
      for (var i = 0; i < CLASSES.length; i++) filters[CLASSES[i].type_id] = filtersFor();
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
    var e = extend && typeof extend === "object" ? extend : {};
    var cid = String(e.cat || tid).replace(/[^\d]/g, "") || "3716";
    var page = Math.max(1, Number(pg) || 1);
    var url = "/category/" + cid + (page > 1 ? "/last-" + page : "") + ".html";
    var html = fetchHtml(url, BASE + "/");
    var list = parseCards(html);
    var pc = pageCount(html, page, 30, list.length);
    return J({ list: list, page: page, pagecount: pc, limit: 30 });
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var vid = String(id).replace(/[^\d]/g, "");
    if (!vid) throw new Error("影片 id 为空");
    var html = fetchHtml("/shipin/" + vid + ".html", BASE + "/");
    return J({ list: [parseDetail(html, vid)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    var kw = String(key == null ? "" : key).replace(/^\s+|\s+$/g, "");
    if (!kw) return J({ list: [], page: 1, pagecount: 1, limit: 30 });
    try {
      var url = "/sousuo/" + enc(kw) + (page > 1 ? "/last-" + page : "") + ".html";
      var html = fetchHtml(url, BASE + "/");
      var list = parseCards(html);
      return J({ list: list, page: page, pagecount: pageCount(html, page, 30, list.length), limit: 30 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], page: page, pagecount: page + 1, limit: 30 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var pid = String(id == null ? "" : id)
      .replace(/^\s+|\s+$/g, "")
      .replace(/^\/+/, "")
      .replace(/\.html.*$/i, "");
    if (pid.indexOf("play/") === 0) pid = pid.slice(5);
    if (!pid) throw new Error("选集 id 为空（线路：" + flag + "）");
    var vod = pid.split("/")[0];
    var html = fetchHtml("/play/" + pid + ".html", BASE + "/shipin/" + vod + ".html");
    // 本站播放页直接写死 m3u8：thisUrl = "https://vip.dytt-xxx.com/.../index.m3u8";
    var url = one(html, /thisUrl\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (!url) url = one(html, /(https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?)/);
    if (!url) url = one(html, /["']url["']\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i);
    if (!url) throw new Error("播放页里没找到 m3u8（线路：" + flag + "），换一集或换条线路试试");
    return J({
      parse: 0,
      url: fixUrl(url),
      header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" },
    });
  },

  destroy: function () {},
};

export default api;
