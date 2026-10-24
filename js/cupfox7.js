/**
 * 茶杯狐 Cupfox (www.cupfox7.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS v10 + jianbai 模板，全站静态 HTML，没有 JS 校验、不需要 cookie。
 * （/api.php/provide/vod/ 返回 closed，只能走网页解析。）
 *
 * 用到的路径：
 *   首页        /                                          54 张卡片（电影/电视剧/综艺/动漫各一段）
 *   分类        /vodshow/fenlei{tid}.html                   12 条/页
 *   分类翻页    /vodshow/fenlei{tid}/page/{n}.html
 *   筛选        /vodshow/fenlei{tid}/{字段}/{值}/page/{n}.html
 *               字段：class(剧情) area(地区) year(年份) lang(语言) by(排序)
 *   子分类      /vodshow/{slug}.html                        动作片/国产剧/韩剧…，可与上面的筛选串起来
 *   详情        /vos/{id}.html                              一次性给出全部线路 + 全部集数
 *   播放        /play/{id}-{线路}-{集}.html                 player_aaaa.url 就是 m3u8（encrypt=0）
 *   搜索        /vodsearch/{关键词}----------{n}---.html     12 条/页
 *
 * 注意：
 *   1. 分类**不能**用标准 MacCMS 的 /vodshow/1-剧情-大陆----1.html 写法，站上一律返回空列表，
 *      必须走 /vodshow/fenlei1/class/剧情/area/大陆/page/1.html 这种伪静态段。
 *   2. 剧情(class)筛选只有「电影」有数据：电视剧/综艺/动漫的 vod_class 没填，
 *      选任何值都是 0 条，所以这三类的筛选里不给「类型」（改用子分类 cat 代替）。
 *   3. 列表卡片里有两个 span：pic-text1 是子分类（剧情片），pic-text 才是备注（HD中字）。
 *      正则要用 pic-text\b，否则会把 pic-text1 一起匹配进来。
 *   4. 详情页的线路名在 tab 上（href="#playlist1"），集数在 div#playlist1 里，两边靠序号配对。
 *
 * 兼容性（跟 测试/js/demo.js、kkys/js/kkys.js、guobayu/js/guobayu.js 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://www.cupfox7.com";
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

/** 同步 GET，返回 HTML 文本；相对路径按 BASE 拼 */
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

/** 取一次，失败再取一次（站点偶发 502 / 空响应） */
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

function all(s, re) {
  var out = [];
  var r = new RegExp(re.source, "g");
  var m;
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
      var code = Number(d);
      if (!code) return a;
      return String.fromCharCode(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, function (a, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
}

/** 去标签 + 压缩空白（标题、备注用） */
function stripTags(s) {
  return decodeHtml(
    String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

/** 去标签但保留换行（简介用） */
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
 * 列表卡片（首页 / 分类 / 子分类 / 搜索 都是同一套模板）：
 *   <a class="stui-vodlist__thumb lazyload" href="/vos/54024.html" title="实习生2026"
 *      data-original="/upload/vod/....jpg">
 *     <span class="play hidden-xs"></span>
 *     <span class="pic-text1 text-right"><b>剧情片</b></span>   ← 子分类
 *     <span class="pic-text text-right"><b>HD中字</b></span>    ← 备注
 *   </a>
 * 只认 class 带 stui-vodlist__thumb 的 /vos/{纯数字}.html，
 * 面包屑、导航、猜你喜欢里的同名链接不会混进来（猜你喜欢那部分没有 thumb class，且按 id 去重）。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /<a\b([^>]*)href="\/vos\/(\d+)\.html"([^>]*)>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var attrs = m[1] + " " + m[3];
    if (attrs.toLowerCase().indexOf("stui-vodlist__thumb") < 0) continue;
    var id = m[2];
    if (seen[id]) continue;
    var name = attr(attrs, "title");
    if (!name) continue;
    seen[id] = 1;

    // 备注在 <a> 内部，取到最近的 </a> 为止
    var close = html.indexOf("</a>", re.lastIndex);
    var inner = close > 0 ? html.substring(re.lastIndex, close) : "";
    var remarks = "";
    var sre = /<span class="pic-text\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    var s;
    while ((s = sre.exec(inner)) != null) {
      var t = stripTags(s[1]);
      if (t) remarks = t; // 有多个时取最后一个（pic-text1 是子分类，排在前面）
    }

    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(attr(attrs, "data-original") || attr(attrs, "src")),
      vod_remarks: remarks,
    });
  }
  return out;
}

/** 分页：模板在 <li class="active num"><a>1/2173</a></li> 里写了总页数，不受 CSS 影响 */
function pageCount(html, page, size, count) {
  var m = /class="active num"[^>]*>\s*<a>\s*(\d+)\s*\/\s*(\d+)\s*</.exec(String(html == null ? "" : html));
  if (m) {
    var n = Number(m[2]);
    if (n > 0) return n;
  }
  // 兜底：满一页就认为还有下一页
  return count >= (size || 12) ? page + 1 : page;
}

/* ============================== 详情解析 ============================== */

/** <p class="data">标签：值</p> 形式的字段 */
function dataField(html, label) {
  var re = new RegExp("<p class=\"data[^\"]*\">\\s*" + label + "：([\\s\\S]*?)</p>");
  return stripTags(one(html, re));
}

/**
 * 线路 + 集数：[{name, eps:[{name,id}]}]
 * 线路名在 tab：<a href="#playlist1" data-toggle="tab">高清线路</a>
 * 集数在面板：<div id="playlist1" ...><ul ...><li><a href="/play/54024-1-1.html">HD中字</a></li>
 */
function parseGroups(html) {
  var names = {};
  var nre = /<a href="#playlist(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
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
    var ere = /<a[^>]*href="\/play\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
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
  var name = stripTags(one(html, /<h1 class="title">([\s\S]*?)<\/h1>/));

  var thumb = one(html, /<div class="stui-content__thumb">([\s\S]*?)<\/div>/);
  var pic = absUrl(attr(thumb, "data-original") || attr(thumb, "src"));
  if (!pic) pic = absUrl(one(html, /<img[^>]*data-original="([^"]+)"[^>]*>/));

  // 第一行 data 是三合一：类型：剧情 / 地区：韩国 / 年份：2026
  var line = stripTags(one(html, /<p class="data hidden-xs">([\s\S]*?)<\/p>/));
  var type = "",
    area = "",
    year = "";
  var tm = /类型：([^\/]*)/.exec(line);
  var am = /地区：([^\/]*)/.exec(line);
  var ym = /年份：([^\/]*)/.exec(line);
  if (tm) type = tm[1].replace(/^\s+|\s+$/g, "");
  if (am) area = am[1].replace(/^\s+|\s+$/g, "");
  if (ym) year = ym[1].replace(/^\s+|\s+$/g, "");

  var status = dataField(html, "状态");
  var director = dataField(html, "导演");
  var actor = dataField(html, "主演");
  var update = dataField(html, "更新");

  var content = htmlText(one(html, /<span class="detail-content"[^>]*>([\s\S]*?)<\/span>/));
  if (!content) content = htmlText(one(html, /<span class="detail-sketch"[^>]*>([\s\S]*?)<\/span>/));

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
    // 没有播放列表时给个占位，避免 App 里详情页空白
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

/** 播放地址里的中文路径要转义，否则部分播放器打不开 */
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
];

/** 子分类（站上「按类型」那一行）。选它就换掉 base 路径，后面的筛选仍然可以叠加 */
var SUBTYPES = {
  "1": [
    ["动作片", "dongzuopian"],
    ["喜剧片", "xijupian"],
    ["爱情片", "aiqingpian"],
    ["科幻片", "kehuanpian"],
    ["恐怖片", "kongbupian"],
    ["剧情片", "juqingpian"],
    ["战争片", "zhanzhengpian"],
    ["记录片", "jilupian"],
    ["动画片", "donghuapian"],
  ],
  "2": [
    ["国产剧", "guochanju"],
    ["港剧", "gangju"],
    ["日剧", "riju"],
    ["韩剧", "hanju"],
    ["欧美剧", "oumeiju"],
    ["泰剧", "taiju"],
    ["台湾剧", "taiwanju"],
    ["海外剧", "haiwaiju"],
  ],
  "3": [
    ["大陆综艺", "daluzongyi"],
    ["日韩综艺", "rihanzongyi"],
    ["港台综艺", "gangtaizongyi"],
    ["欧美综艺", "oumeizongyi"],
  ],
  "4": [
    ["国产动漫", "guochandongman"],
    ["日韩动漫", "rihandongman"],
    ["欧美动漫", "oumeidongman"],
    ["海外动漫", "haiwaidongman"],
    ["港台动漫", "gangtaidongman"],
  ],
};

var AREAS = {
  "1": ["大陆", "香港", "台湾", "美国", "日本", "韩国", "泰国", "印度", "加拿大", "其他"],
  "2": ["内地", "韩国", "香港", "台湾", "日本", "美国", "泰国", "英国", "新加坡", "其他"],
  "3": ["内地", "港台", "日韩", "欧美"],
  "4": ["国产", "日本", "欧美", "其他"],
};

var LANGS = ["国语", "英语", "粤语", "闽南语", "韩语", "日语", "其它"];

/** 站点模板里年份是写死的 2012–2024，但 year/2026 一样能查（数据在涨，模板没跟） */
var YEARS = [
  "2026", "2025", "2024", "2023", "2022", "2021", "2020",
  "2019", "2018", "2017", "2016", "2015", "2014", "2013", "2012", "2011", "2010",
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
  var subs = SUBTYPES[tid];
  if (subs && subs.length) {
    var v = optAll();
    for (var i = 0; i < subs.length; i++) v.push({ n: subs[i][0], v: subs[i][1] });
    f.push({ key: "cat", name: "类型", value: v });
  }
  var areas = AREAS[tid];
  if (areas && areas.length) f.push({ key: "area", name: "地区", value: optFlat(areas) });
  f.push({ key: "year", name: "年份", value: optFlat(YEARS) });
  f.push({ key: "lang", name: "语言", value: optFlat(LANGS) });
  f.push({ key: "by", name: "排序", value: optPairs(ORDERS) });
  return f;
}

/**
 * 分类页路径。站上只认伪静态段：
 *   /vodshow/fenlei1/area/大陆/year/2023/page/2.html
 * 标准 MacCMS 的 /vodshow/1-剧情-大陆----1.html 一律空列表，不要用。
 */
function buildPath(tid, page, ext) {
  var base = String((ext && ext.cat) || "").replace(/[^a-z0-9]/gi, "") || "fenlei" + tid;
  var p = "/vodshow/" + base;
  if (ext && ext.area) p += "/area/" + enc(ext.area);
  if (ext && ext.year) p += "/year/" + enc(ext.year);
  if (ext && ext.lang) p += "/lang/" + enc(ext.lang);
  if (ext && ext.by) p += "/by/" + enc(ext.by);
  p += page > 1 ? "/page/" + page + ".html" : ".html";
  return p;
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
    var html = fetchHtml("/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var list = parseCards(fetchHtml("/vodshow/fenlei1.html"));
    rows.push(diagCard("分类解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
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
  // 旧式 __jsEvalReturn 会给 { stype, skey, ext }
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
      var html = fetchHtml("/");
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
    var pc = pageCount(html, page, 12, list.length);
    return J({ list: list, page: page, pagecount: pc, limit: 12 });
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var html = fetchHtml("/vos/" + String(id).replace(/[^\d]/g, "") + ".html");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var url = "/vodsearch/" + enc(key) + "----------" + page + "---.html";
      var html = fetchHtml(url, BASE + "/");
      var list = parseCards(html);
      var pc = pageCount(html, page, 12, list.length);
      return J({ list: list, page: page, pagecount: pc, limit: 12 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var ep = String(id || "")
      .replace(/^\/?play\//i, "")
      .replace(/\.html.*$/i, "");
    if (!ep) throw new Error("选集 id 为空（线路：" + flag + "）");

    var html = fetchHtml("/play/" + ep + ".html", BASE + "/vos/" + ep.split("-")[0] + ".html");
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
    if (!url) {
      // 兜底：播放页里直接写死的 m3u8
      url = one(html, /(https?:\/\/[^\s"'<>\\]+\.m3u8(?:\?[^\s"'<>\\]*)?)/);
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
