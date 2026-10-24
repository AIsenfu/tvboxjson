/**
 * 丝粒影视 (silidm.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点基于 MacCMS（苹果CMS）标准「资源站接口」/api.php/provide/vod/，接口开放、
 * 直接返回 JSON（code:1 + list + class），所以走【路线 A：直接消费 JSON】，
 * 不需要抓网页、不需要 cookie。
 *
 * 接口约定（MacCMS provide/vod 标准）：
 *   列表    /api.php/provide/vod/?ac=list&t=类型&pg=页码&wd=关键词
 *   详情    /api.php/provide/vod/?ac=detail&ids=影片id（多个用逗号）
 *   分类    list 里的 class 字段（type_id / type_name）
 *   播放    list 的 vod_play_from（线路，$$$ 分隔）+ vod_play_url（每集 名称$地址，# 分隔）
 *           —— MacCMS 的「集地址」本身就是可直播的 m3u8，play() 直接透传
 *
 * 两个要注意的点：
 *   1. list 接口【不含 vod_pic】，封面只在 detail 里。所以首页/分类/搜索的卡片
 *      先拿 id 列表，再发一次 ac=detail&ids= 批量补封面（detail 按 id 升序返回，
 *      脚本会按列表顺序重排）。
 *   2. 部分线路是「夸克网盘分享链接」（vod_play_from 里的 kua，地址 pan.quark.cn），
 *      不是可播的 m3u8，App 里点那条线路播不了——这是站点自己的数据，脚本忠实透传，
 *      用户换一条 m3u8 线路即可。
 *
 * 兼容性（和合集里 guobayu.js 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http 依次探测
 *   - 全同步请求，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - 解析失败时首页给一个「诊断」分类，卡片里直接写清原因
 */

var BASE = "https://silidm.com";
var UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

var conf = { api: BASE, ua: UA };
var lastError = "";

/* 兜底分类（接口没返回 class 时用，跟实测一致） */
var FALLBACK_CLASS = [
  { type_id: "20", type_name: "电影" },
  { type_id: "21", type_name: "电视剧" },
  { type_id: "22", type_name: "动漫" },
  { type_id: "23", type_name: "综艺" },
  { type_id: "24", type_name: "福利片" },
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

/** 同步 GET JSON；相对/绝对 URL 都会按 conf.api 拼成绝对地址 */
function jsonGet(url) {
  var b = backend();
  var opt = {
    headers: {
      "User-Agent": conf.ua || UA,
      Accept: "application/json, */*",
      Referer: conf.api + "/",
    },
    timeout: 20000,
  };
  var r;
  if (b === "net.req") r = net.req(url, opt);
  else if (b === "req") r = req(url, opt);
  else if (b === "http") r = http(url, { headers: opt.headers, timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var txt = bodyOf(r, url);
  if (!txt || txt.length < 2) throw new Error("返回内容过短（" + (txt ? txt.length : 0) + " 字节）：" + url);
  try {
    return JSON.parse(txt);
  } catch (e) {
    throw new Error("JSON 解析失败：" + errText(e) + " → " + txt.substring(0, 120));
  }
}

/** 拼接口地址：conf.api + /api.php/provide/vod/ + 编码后的 query */
function apiUrl(params) {
  var base = conf.api.replace(/\/+$/, "") + "/api.php/provide/vod/";
  var q = [];
  for (var k in params) {
    if (params.hasOwnProperty(k) && params[k] != null && params[k] !== "") {
      q.push(k + "=" + encodeURIComponent(params[k]));
    }
  }
  return base + "?" + q.join("&");
}

/* ============================== HTML 文本清洗（简介用） ============================== */

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

/** 去标签 + 压缩空白（简介用） */
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

/* ============================== 字段映射 ============================== */

/** 卡片（首页/分类/搜索通用） */
function toCard(v) {
  return {
    vod_id: String(v.vod_id),
    vod_name: v.vod_name || "",
    vod_pic: v.vod_pic || "",
    vod_remarks: v.vod_remarks || "",
  };
}

/** 详情（含播放源） */
function toDetail(v) {
  return {
    vod_id: String(v.vod_id),
    vod_name: v.vod_name || "",
    vod_pic: v.vod_pic || "",
    vod_remarks: v.vod_remarks || "",
    vod_year: v.vod_year || "",
    vod_area: v.vod_area || "",
    vod_type: v.type_name || v.vod_type || "",
    vod_director: v.vod_director || "",
    vod_actor: v.vod_actor || "",
    vod_content: stripTags(v.vod_content || ""),
    // 这两项是 MacCMS 原样格式：vod_play_from 线路($$$分隔)，vod_play_url 每集 名称$地址(#分隔)
    vod_play_from: v.vod_play_from || "",
    vod_play_url: v.vod_play_url || "",
  };
}

/**
 * 用 list 的 id 顺序，发一次 ac=detail&ids= 批量补封面，再按原顺序重排出卡片。
 * detail 按 id 升序返回（非请求顺序），必须重排；某条 detail 失败时退回无封面卡片。
 */
function enrichCards(listItems) {
  if (!listItems || !listItems.length) return [];
  var ids = [];
  for (var i = 0; i < listItems.length; i++) ids.push(listItems[i].vod_id);
  var det = {};
  try {
    var dd = jsonGet(apiUrl({ ac: "detail", ids: ids.join(",") }));
    if (dd && dd.list && dd.list.length) {
      for (var k = 0; k < dd.list.length; k++) det[String(dd.list[k].vod_id)] = dd.list[k];
    }
  } catch (e) {
    lastError = errText(e);
  }
  var out = [];
  for (var j = 0; j < listItems.length; j++) {
    var id = String(listItems[j].vod_id);
    var src = det[id] || listItems[j];
    out.push(toCard(src));
  }
  return out;
}

/** 通用翻页结果包装 */
function pageResult(listItems, data, pg) {
  return J({
    list: enrichCards(listItems),
    page: Number(pg) || 1,
    pagecount: Number(data.pagecount) || 1,
    limit: Number(data.limit) || 20,
    total: Number(data.total) || 0,
  });
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
    var data = jsonGet(apiUrl({ ac: "list", pg: 1 }));
    var cards = enrichCards(data.list || []);
    rows.push(diagCard("list 接口 GET 成功", "total=" + data.total + " 首页 " + cards.length + " 张"));
  } catch (e) {
    rows.push(diagCard("list 接口异常：" + errText(e), ""));
  }
  return { list: rows, page: 1, pagecount: 1, limit: 20, total: rows.length };
}

/* ============================== ext 解析 ============================== */

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

/* ============================== 爬虫主体 ============================== */

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
      var data = jsonGet(apiUrl({ ac: "list", pg: 1 }));
      var cls = FALLBACK_CLASS;
      if (data.class && data.class.length) {
        cls = [];
        for (var i = 0; i < data.class.length; i++) {
          cls.push({ type_id: String(data.class[i].type_id), type_name: data.class[i].type_name });
        }
      }
      return J({ class: cls, filters: {}, list: enrichCards(data.list || []) });
    } catch (e) {
      lastError = errText(e);
      return J({ class: FALLBACK_CLASS, filters: {}, list: [diagCard("首页失败：" + errText(e), "后端：" + backend())] });
    }
  },

  homeVod: function () {
    try {
      var data = jsonGet(apiUrl({ ac: "list", pg: 1 }));
      return J({ list: enrichCards(data.list || []) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var page = Math.max(1, Number(pg) || 1);
    var id = String(tid);
    try {
      var data = jsonGet(apiUrl({ ac: "list", t: id, pg: page }));
      return pageResult(data.list || [], data, page);
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("分类失败：" + errText(e), "")], page: page, pagecount: 1, limit: 20, total: 0 });
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
      var data = jsonGet(apiUrl({ ac: "detail", ids: String(id) }));
      if (!data.list || !data.list.length) throw new Error("详情为空（id=" + id + "）");
      return J({ list: [toDetail(data.list[0])] });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("详情失败：" + errText(e), "")] });
    }
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    try {
      var data = jsonGet(apiUrl({ ac: "list", wd: key, pg: page }));
      return pageResult(data.list || [], data, page);
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], page: page, pagecount: 1, limit: 20, total: 0 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    if (!id) throw new Error("选集 id 为空（线路：" + flag + "）");
    // MacCMS 的集地址本身就是可直播的 m3u8，直接透传；kua 线路是夸克网盘分享链接，播不了属正常
    return J({
      parse: 0,
      url: id,
      header: { "User-Agent": conf.ua || UA, Referer: conf.api + "/" },
    });
  },

  destroy: function () {},
};

export default api;
