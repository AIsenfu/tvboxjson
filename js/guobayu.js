/**
 * 锅巴鱼影院 (www.guobayu.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS v10 + baikelol 模板，全站静态 HTML，没有 JS 校验、不需要 cookie。
 *
 * 用到的路径：
 *   首页        /                                   36 张卡片（推荐 6 + 五个频道各 6）
 *   分类        /vodtype/{tid}.html                  12 条/页
 *   分类翻页    /vodtype/{tid}-{page}.html
 *   详情        /seo/{id}.html                       一次性给出全部线路 + 全部集数
 *   播放        /seoplay/{id}-{线路}-{集}.html        player_aaaa.url 就是 m3u8（encrypt=0）
 *   搜索        /vodsearch/{关键词}----------{page}---.html
 *
 * 注意：
 *   1. 站点没有 /api.php（返回 closed），也没有 /vodshow/ 多维筛选（404），
 *      所以筛选只能按「子分类 tid」来，地区/年份/排序都不支持。
 *   2. 播放页里的 m3u8 有些带中文目录（bfzym3u8 线路形如 /video/xxx/第01集/index.m3u8），
 *      交给播放器前会 encodeURI 一次，否则部分播放器会拒播。
 *   3. 首页 36 张卡片里有重复（同一个片出现在多个频道），脚本按 vod_id 去重。
 *
 * 兼容性（跟 测试/js/demo.js、kkys/js/kkys.js 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 不依赖 getUserAgent，UA 写死
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://www.guobayu.com";
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
  if (!html || html.length < 200) throw new Error("返回内容过短（" + (html ? html.length : 0) + " 字节）：" + full);
  return html;
}

/** 取一次，失败再取一次（站点偶发 502） */
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

function attr(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(tag);
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
 * 列表卡片。站内两种写法都能覆盖：
 *   <a class="stui-vodlist__thumb lazyload" href="/seo/179095.html" title="实习生2026"
 *      data-original="https://img.cheyibao.cc/..."><span class="pic-text text-right">HD中字</span></a>
 *   <a class="v-thumb stui-vodlist__thumb lazyload" ...>            ← 搜索结果页
 * 只认 href="/seo/{纯数字}.html" 且 class 带 stui-vodlist__thumb 的标签，
 * 面包屑/导航里的 /vodtype/、/vodshow/ 链接自然被排除。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /<a\b[^>]*href="\/seo\/(\d+)\.html"[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var tag = m[0];
    if (tag.toLowerCase().indexOf("stui-vodlist__thumb") < 0) continue;
    var id = m[1];
    if (seen[id]) continue;
    var name = attr(tag, "title");
    if (!name) continue;
    seen[id] = 1;
    var pic = attr(tag, "data-original") || attr(tag, "src");
    var tail = html.substring(m.index, m.index + 800);
    var rm = /<span class="pic-text[^"]*">([\s\S]*?)<\/span>/.exec(tail);
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(pic),
      vod_remarks: rm ? stripTags(rm[1]) : "",
    });
  }
  return out;
}

/** 分页：模板在手机端样式里塞了 <span class="num">1/5809</span>，不受 CSS 影响，永远在 HTML 里 */
function pageCount(html, fallback) {
  var m = /class="num">\s*(\d+)\s*\/\s*(\d+)\s*</.exec(String(html == null ? "" : html));
  if (m) {
    var n = Number(m[2]);
    if (n > 0) return n;
  }
  return fallback || 1;
}

/* ============================== 详情解析 ============================== */

function fieldOf(html, label) {
  var re = new RegExp(label + "：<\\/span>([\\s\\S]*?)(?:<span class=\"split-line\"|<\\/p>)");
  return stripTags(one(html, re));
}

/** 线路 + 集数：[{sid,name,eps:[{name,id}]}]，id 是 /seoplay/{vod}-{线路}-{集}.html */
function parseGroups(html) {
  var names = {};
  var m;
  var nre = /<a href="#playlist(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
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
    var ere = /<a[^>]*href="(\/seoplay\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    var e;
    while ((e = ere.exec(block)) != null) {
      var name = stripTags(e[2]) || "第" + (eps.length + 1) + "集";
      eps.push({ name: name, id: e[1] });
    }
    if (!eps.length) continue;
    var line = names[sid] || "线路" + sid;
    // 站点偶尔两条线路同名（都叫「路线一」），重名的加上 id 区分，否则 App 里会并成一条
    if (used[line]) line = line + "-" + sid;
    used[line] = 1;
    groups.push({ sid: sid, name: line, eps: eps });
  }
  return groups;
}

function parseDetail(html, id) {
  var titleBox = one(html, /<h1 class="title">([\s\S]*?)<\/h1>/).replace(/<span class="score[\s\S]*?<\/span>/i, "");
  var name = stripTags(titleBox);

  var thumb = one(html, /<div class="stui-content__thumb">([\s\S]*?)<\/div>/);
  var pic = absUrl(attr(thumb, "data-original") || attr(thumb, "src"));
  var remark = stripTags(one(thumb, /<span class="pic-text[^"]*">([\s\S]*?)<\/span>/));

  var content = "";
  var descIdx = html.indexOf('id="desc"');
  if (descIdx > 0) content = htmlText(one(html.substring(descIdx), /<p class="col-pd">([\s\S]*?)<\/p>/));
  if (!content) content = htmlText(one(html, /<p class="desc[^"]*">([\s\S]*?)<\/p>/));

  var director = fieldOf(html, "导演");
  var actor = fieldOf(html, "主演");
  var type = fieldOf(html, "类型");
  var area = fieldOf(html, "地区");
  var year = fieldOf(html, "年份");
  var update = fieldOf(html, "更新");

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
    // 没有播放列表时给一个占位，避免 App 里详情页空白
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

/** 播放地址里的中文路径（bfzym3u8 线路）要转义，否则部分播放器打不开 */
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
  { type_id: "26", type_name: "短剧" },
];

/** 站点只在「电影」「电视剧」下有子分类，综艺/动漫/短剧没有，给了也选不出东西 */
var SUBTYPES = {
  "1": [
    ["动作片", "6"],
    ["喜剧片", "7"],
    ["爱情片", "8"],
    ["科幻片", "9"],
    ["恐怖片", "10"],
    ["剧情片", "11"],
    ["战争片", "12"],
    ["纪录片", "24"],
  ],
  "2": [
    ["国产剧", "25"],
    ["美剧", "20"],
    ["韩剧", "13"],
    ["日剧", "14"],
    ["泰剧", "15"],
    ["港剧", "16"],
  ],
};

function filtersFor(tid) {
  var subs = SUBTYPES[tid];
  if (!subs) return [];
  var value = [{ n: "全部", v: "" }];
  for (var i = 0; i < subs.length; i++) value.push({ n: subs[i][0], v: subs[i][1] });
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
    var list = parseCards(fetchHtml("/vodtype/1.html"));
    rows.push(diagCard("分类解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
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
    var id = String(e.class || tid || "1");
    var html = fetchHtml("/vodtype/" + id + "-" + page + ".html", BASE + "/");
    var list = parseCards(html);
    var total = pageCount(html, page);
    return J({ list: list, page: page, pagecount: total, limit: 12, total: total * 12 });
  },

  detail: function (id) {
    if (id === "__diag") {
      var lines = [
        "base = " + BASE,
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
    var html = fetchHtml("/seo/" + id + ".html");
    return J({ list: [parseDetail(html, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var html = fetchHtml("/vodsearch/" + enc(key) + "----------" + page + "---.html", BASE + "/");
      var list = parseCards(html);
      if (!list.length) {
        // 关键词可能被模板拆词，退回表单式搜索再试一次
        html = fetchHtml("/vodsearch/-------------.html?wd=" + enc(key), BASE + "/");
        list = parseCards(html);
      }
      if (!list.length) return J({ list: [diagCard("没有搜到：" + key, "换个关键词试试")], pagecount: 1 });
      var total = pageCount(html, page);
      return J({ list: list, page: page, pagecount: total, limit: 15 });
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
    var url = d.url || "";
    if (!url) throw new Error("播放页没给出地址（线路：" + flag + "），换一条线路试试");
    if (Number(d.encrypt) === 1) url = b64decode(url);
    else if (Number(d.encrypt) === 2) url = b64decode(decodeURIComponent(url));
    url = fixUrl(url);
    return J({
      parse: 0,
      url: url,
      header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" },
    });
  },

  destroy: function () {},
};

export default api;
