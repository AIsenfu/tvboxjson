/**
 * 策驰影院 (chicey.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS v10 + 自定义 myui 模板，全站静态 HTML；api.php 采集接口已关
 * （/api.php/provide/vod/ 返回 closed），只能解析网页。无 cookie、无 JS 校验。
 * 路径是自家一套（不是常见 vodxxx）：
 *
 *   首页/搜索卡片  详情统一走 /dm/{id}.html
 *   分类列表       /v/{cid}.html（第1页）/v/{cid}-{page}.html（36条/页，尾页取总页数）
 *   详情           /dm/{id}.html        一次给出全部线路 + 全部集数
 *   播放           /play/{id}-{线路}-{集}.html   player_aaaa.url 就是 m3u8（encrypt=0）
 *   搜索           /search.html?wd={关键词}（第1页）/search/page/{页}/wd/{关键词}.html
 *
 * 两个坑（都踩过）：
 *   1) 漂亮路径 /search/{关键词}.html 【不按关键词过滤】，会返回「最新」列表；
 *      必须用表单真正的 GET 地址 /search.html?wd=。
 *   2) 线路 tab 顺序是乱的（playlist id 常见 7/4/6/5/2），必须按 playlistN 的 N 配对，
 *      不能按出现顺序硬套。
 *
 * 兼容性（跟 guobayu / cupfox7 / kkjpliu 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://chicey.com";
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

/** player_aaaa 是嵌套 JSON（含 vod_data 子对象、url 里有转义斜杠），用花括号配对取整段 */
function extractJson(html, name) {
  var i = String(html || "").indexOf(name);
  if (i < 0) return "";
  var j = String(html).indexOf("{", i);
  if (j < 0) return "";
  var depth = 0;
  var inStr = false;
  var escaped = false;
  for (var k = j; k < html.length; k++) {
    var c = html.charAt(k);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return html.slice(j, k + 1);
    }
  }
  return "";
}

/* ============================== 列表解析 ============================== */

/**
 * 卡片（首页 / 列表 / 搜索 同一套）：全部详情统一链接 /dm/{id}.html，标题在 title 属性。
 * 主网格卡带 lazyload（class="myui-vodlist__thumb lazyload"），侧边榜单/相关推荐是没有
 * lazyload 的 thumb——所以优先只取 lazyload 网格卡；搜索页结果是「无 lazyload 的 thumb」，
 * 取不到网格卡时再放宽到全部 thumb。按 id 去重（同片会在多个推荐位重复出现）。
 */
function parseCards(html) {
  var grid = [];
  var all = [];
  var seenG = {};
  var seenA = {};
  var re = /<a\b([^>]*?myui-vodlist__thumb[^>]*?)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var attrs = m[1];
    var inner = m[2];
    var hm = /href="\/dm\/(\d+)\.html"/.exec(attrs);
    if (!hm) continue;
    var id = hm[1];
    var title = attr(attrs, "title");
    if (!title) continue;

    var pic = attr(attrs, "data-original") || attr(attrs, "src") || attr(attrs, "data-src");
    if (!pic) {
      var im = /data-original="([^"]*)"|src="([^"]*)"/.exec(inner);
      if (im) pic = im[1] || im[2] || "";
    }
    if (!pic) {
      var bg = /url\(([^)]+)\)/.exec(attrs + " " + inner);
      if (bg) pic = bg[1];
    }
    var rm = /class="pic-text[^"]*"[^>]*>([\s\S]*?)<\/span>/.exec(inner);
    var card = {
      vod_id: id,
      vod_name: title,
      vod_pic: absUrl(pic),
      vod_remarks: rm ? stripTags(rm[1]) : "",
    };

    if (!seenA[id]) {
      seenA[id] = 1;
      all.push(card);
    }
    if (attrs.indexOf("lazyload") >= 0 && !seenG[id]) {
      seenG[id] = 1;
      grid.push(card);
    }
  }
  return grid.length ? grid : all;
}

/** 列表总页数：真列表尾页 /v/{cid}-{N}.html；顶层落地页（如 /v/1 电影）没有尾页，按单页处理，避免「下一页」还是同一页 */
function listPageCount(html, page, count) {
  var m = /href="\/v\/\d+-(\d+)\.html"[^>]*>\s*尾页/.exec(String(html || ""));
  if (m) {
    var n = Number(m[1]);
    if (n > 0) return n;
  }
  return page;
}

/** 搜索总页数：尾页 /search/page/{N}/wd/{关键词}.html */
function searchPageCount(html, page, count) {
  var m = /href="\/search\/page\/(\d+)\/[^"]*"[^>]*>\s*尾页/.exec(String(html || ""));
  if (m) {
    var n = Number(m[1]);
    if (n > 0) return n;
  }
  return count >= 15 ? page + 1 : page;
}

/* ============================== 详情解析 ============================== */

/** <span class="text-muted...">标签：</span>值（截到 </p> 或下一个 text-muted，主演的 <a> 名要留下） */
function dataField(block, label) {
  var re = new RegExp('<span class="text-muted[^"]*">\\s*' + label + '：\\s*</span>([\\s\\S]*?)(?:</p>|<span)');
  return stripTags(one(block, re));
}

/** 线路 + 集数。线路名在 tab（href="#playlistN"），集数在 div#playlistN，靠 N 配对（顺序是乱的） */
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
    var ere = /<a[^>]*href="(\/play\/[^"]+?\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    var e;
    while ((e = ere.exec(block)) != null) {
      var name = stripTags(e[2]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: e[1] });
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
  if (!name) name = stripTags(one(html, /<title>([^<]*)<\/title>/)).replace(/-策驰影院.*$/, "");

  var thumb = one(html, /<div class="myui-content__thumb"[^>]*>([\s\S]*?)<\/div>/);
  var pic = absUrl(attr(thumb, "src") || one(thumb, /<img[^>]*src="([^"]+)"/));

  var type = dataField(block, "分类") || dataField(block, "类型");
  var area = dataField(block, "地区");
  var year = dataField(block, "年份");
  var director = dataField(block, "导演");
  var actor = dataField(block, "主演");
  var status = dataField(block, "状态");
  var update = dataField(block, "更新");

  var content = one(html, /<meta name="description" content="([^"]*)"/);
  content = stripTags(decodeHtml(content)).replace(/^[\s\S]*?剧情[:：]\s*/, "").replace(/^\s+|\s+$/g, "");

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

// 本站列表就是 /v/{cid}.html，cid 即分类/子分类 id；无多维筛选，故 filters 为空
var CLASSES = [
  { type_id: "1", type_name: "电影" },
  { type_id: "2", type_name: "电视剧" },
  { type_id: "3", type_name: "综艺" },
  { type_id: "4", type_name: "动漫" },
  { type_id: "35", type_name: "短剧" },
  { type_id: "27", type_name: "纪录片" },
  { type_id: "6", type_name: "动作片" },
  { type_id: "7", type_name: "喜剧片" },
  { type_id: "8", type_name: "爱情片" },
  { type_id: "9", type_name: "科幻片" },
  { type_id: "10", type_name: "恐怖片" },
  { type_id: "11", type_name: "剧情片" },
  { type_id: "12", type_name: "战争片" },
  { type_id: "13", type_name: "国产剧" },
  { type_id: "14", type_name: "港剧" },
  { type_id: "15", type_name: "韩剧" },
  { type_id: "16", type_name: "美剧" },
  { type_id: "24", type_name: "日剧" },
  { type_id: "25", type_name: "泰剧" },
  { type_id: "26", type_name: "台剧" },
  { type_id: "34", type_name: "Netflix" },
];

function buildPath(tid, page) {
  var t = String(tid || "1").replace(/[^0-9]/g, "") || "1";
  return page > 1 ? "/v/" + t + "-" + page + ".html" : "/v/" + t + ".html";
}

function searchPath(key, page) {
  if (page > 1) return "/search/page/" + page + "/wd/" + enc(key) + ".html";
  return "/search.html?wd=" + enc(key);
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
    var list = parseCards(fetchHtml("/v/1.html"));
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
    var pc = listPageCount(html, page, list.length);
    return J({ list: list, page: page, pagecount: pc, limit: 36 });
  },

  detail: function (id) {
    if (id === "__diag") return J(diagnoseDetail());
    var vid = String(id).replace(/[^\d]/g, "");
    var html = fetchHtml("/dm/" + vid + ".html", BASE + "/");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = fetchHtml(searchPath(key, page), BASE + "/");
      var list = parseCards(html);
      return J({ list: list, page: page, pagecount: searchPageCount(html, page, list.length), limit: 20 });
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

    var html = fetchHtml("/play/" + ep + ".html", BASE + "/");
    var json = extractJson(html, "player_aaaa");
    var url = "";
    if (json) {
      var d;
      try {
        d = JSON.parse(json);
      } catch (e) {
        throw new Error("player_aaaa 解析失败：" + errText(e));
      }
      url = d.url || "";
      if (url) {
        var encNo = Number(d.encrypt);
        if (encNo === 1) url = b64decode(url);
        else if (encNo === 2) url = b64decode(decodeURIComponent(url));
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
