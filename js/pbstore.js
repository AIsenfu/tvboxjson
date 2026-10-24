/**
 * 全能影视站 (www.pb-store.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS 数据 + Nuxt3 前端（SSR 页面 + 同源 JSON 接口）。
 * /api.php/provide/vod/ 是关的（404），但站点自己用的 /api/show/v2/* 是**全开放**的，
 * 所以走「路线 A：直接消费 JSON」，不解析 HTML，稳得多。
 *
 * 用到的接口（全部同源、无需 cookie / 无需 UA 伪装）：
 *   首页    /api/show/v2/index                     4 个频道 + 各自推荐
 *   分类    /api/show/v2/type/{typeId}/{page}      18 条/页，返回 total_page
 *   详情    /api/show/v2/vod/{vodId}               含 vod_play[]：线路名 + 全部集 m3u8
 *   搜索    /api/show/v2/search/{关键词}/{page}     18 条/页，返回 total_page
 *
 * 关键点：
 *   1. 详情接口的 vod_play[].vodPlayUrl 已经是 MacCMS 的「集名$地址#集名$地址」格式，
 *      而且地址就是**最终 m3u8 直链**（各线路来自不同 CDN：lzv22 / ffzy-online / lzcdn27…），
 *      所以 play() 不需要再请求播放页，直接把 id 当直链返回。
 *   2. 线路名取 vod_play[].collectSource.webName（极速一 / 极速四 …），重名加序号。
 *   3. 分类只有「子分类」维度（typeId 1~24），接口没有「电影=全部子类」的聚合，
 *      所以 CLASSES 直接列 24 个子分类，各自带真实总数。
 *   4. pageSize 参数服务端写死 18，传大也没用，翻页就按 18 算。
 *
 * 兼容性（与 guobayu.js 同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步，方法返回 JSON 字符串（老宿主不处理 Promise）
 *   - UA 写死，不依赖 getUserAgent
 *   - 失败时给「诊断」卡片，写清原因，不在 App 里留空白
 */

var BASE = "https://www.pb-store.com";
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
  return {
    "User-Agent": conf.ua || UA,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: referer || BASE + "/",
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

/** 同步 GET，返回文本；相对路径按 BASE 拼 */
function httpGet(url, referer) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { headers: headers(referer), timeout: 20000 });
  else if (b === "req") r = req(full, { headers: headers(referer), timeout: 20000 });
  else if (b === "http")
    r = http(full, { headers: headers(referer), timeout: 20000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var text = bodyOf(r, full);
  if (!text) throw new Error("空响应：" + full);
  return text;
}

function fetchText(url, referer) {
  try {
    return httpGet(url, referer);
  } catch (e) {
    lastError = errText(e);
    return httpGet(url, referer);
  }
}

/** 取 JSON 并校验 code===0，返回 data */
function getData(path) {
  var text = fetchText(path, BASE + "/");
  var obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error("返回不是 JSON：" + String(text).substring(0, 80));
  }
  if (!obj || obj.code !== 0) {
    throw new Error("接口报错：" + ((obj && (obj.msg || obj.code)) || "未知") + " @ " + path);
  }
  return obj.data;
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

function trim(s) {
  return String(s == null ? "" : s).replace(/^\s+|\s+$/g, "");
}

function fixUrl(u) {
  var s = trim(u);
  if (!s) return s;
  if (s.indexOf("//") === 0) s = "https:" + s;
  if (/[^\x00-\x7F]/.test(s)) {
    try {
      s = encodeURI(s);
    } catch (e) {}
  }
  return s;
}

/* ============================== 数据映射 ============================== */

/** 列表卡片 */
function card(v) {
  if (!v) return null;
  var id = v.vodId;
  if (id == null) return null;
  return {
    vod_id: String(id),
    vod_name: trim(v.vodName) || "未知标题",
    vod_pic: fixUrl(v.vodPic || v.vodPicThumb || v.vodPicSave),
    vod_remarks: trim(v.vodLastRemarks || v.vodRemarks),
  };
}

function cardsOf(arr) {
  var out = [];
  var seen = {};
  if (!arr || !arr.length) return out;
  for (var i = 0; i < arr.length; i++) {
    var c = card(arr[i]);
    if (!c) continue;
    if (seen[c.vod_id]) continue;
    seen[c.vod_id] = 1;
    out.push(c);
  }
  return out;
}

/** 线路名：collectSource.webName 优先，重名加序号 */
function lineName(item, idx, used) {
  var name = "";
  if (item && item.collectSource && item.collectSource.webName) name = trim(item.collectSource.webName);
  if (!name) name = "线路" + (idx + 1);
  if (used[name]) name = name + "-" + (idx + 1);
  used[name] = 1;
  return name;
}

/** 详情 */
function parseDetail(d, id) {
  var plays = d.vod_play || [];
  var first = plays[0] || {};

  var typeName = "";
  if (d.type && d.type.typeName) typeName = d.type.typeName;

  var from = [];
  var urls = [];
  var used = {};
  for (var i = 0; i < plays.length; i++) {
    var raw = trim(plays[i].vodPlayUrl);
    if (!raw) continue;
    // 去掉结尾多余的 # / $，避免 App 解析出空集
    raw = raw.replace(/[#$]+$/, "");
    if (!raw) continue;
    // 万一给的不是「集名$地址」格式，补一个集名
    if (raw.indexOf("$") < 0) {
      var parts = raw.split("#");
      var tmp = [];
      for (var k = 0; k < parts.length; k++) {
        if (!parts[k]) continue;
        tmp.push("第" + (k + 1) + "集$" + parts[k]);
      }
      raw = tmp.join("#");
      if (!raw) continue;
    }
    from.push(lineName(plays[i], i, used));
    urls.push(raw);
  }

  var content = trim(first.vodContent || first.vodBlurb || "");
  var text = content;
  if (d.vodDirector) text += "\n导演：" + trim(d.vodDirector);
  if (d.vodActor) text += "\n主演：" + trim(d.vodActor);
  if (d.vodArea) text += "\n地区：" + trim(d.vodArea);
  if (d.vodYear) text += "\n年份：" + trim(d.vodYear);
  if (d.vodLastRemarks) text += "\n状态：" + trim(d.vodLastRemarks);

  var vod = {
    vod_id: String(d.vodId != null ? d.vodId : id),
    vod_name: trim(d.vodName) || "未知标题",
    vod_pic: fixUrl(d.vodPic || d.vodPicThumb || d.vodPicSave),
    vod_content: trim(text),
    vod_actor: trim(d.vodActor),
    vod_director: trim(d.vodDirector),
    vod_year: d.vodYear ? String(d.vodYear) : "",
    vod_area: trim(d.vodArea),
    vod_type: typeName,
    vod_remarks: trim(d.vodLastRemarks || first.vodRemarks),
  };

  if (from.length) {
    vod.vod_play_from = from.join("$$$");
    vod.vod_play_url = urls.join("$$$");
  } else {
    vod.vod_play_from = "无";
    vod.vod_play_url = "暂无播放源$" + vod.vod_id;
  }
  return vod;
}

/* ============================== 频道 ============================== */

/** 24 个子分类（接口只支持子分类维度，没有「电影=全部」的聚合） */
var CLASSES = [
  { type_id: "1", type_name: "动作片" },
  { type_id: "2", type_name: "喜剧片" },
  { type_id: "3", type_name: "爱情片" },
  { type_id: "4", type_name: "科幻片" },
  { type_id: "5", type_name: "恐怖片" },
  { type_id: "6", type_name: "剧情片" },
  { type_id: "7", type_name: "战争片" },
  { type_id: "8", type_name: "国产剧" },
  { type_id: "9", type_name: "香港剧" },
  { type_id: "10", type_name: "韩国剧" },
  { type_id: "11", type_name: "欧美剧" },
  { type_id: "12", type_name: "台湾剧" },
  { type_id: "13", type_name: "日本剧" },
  { type_id: "14", type_name: "海外剧" },
  { type_id: "15", type_name: "泰国剧" },
  { type_id: "16", type_name: "国产动漫" },
  { type_id: "17", type_name: "日韩动漫" },
  { type_id: "18", type_name: "欧美动漫" },
  { type_id: "19", type_name: "港台动漫" },
  { type_id: "20", type_name: "海外动漫" },
  { type_id: "21", type_name: "大陆综艺" },
  { type_id: "22", type_name: "港台综艺" },
  { type_id: "23", type_name: "日韩综艺" },
  { type_id: "24", type_name: "欧美综艺" },
];

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
    var d = getData("/api/show/v2/index");
    rows.push(diagCard("index 接口通", "频道数 " + (d ? d.length : 0)));
    if (d && d.length && d[0].vod_recent) {
      rows.push(diagCard("首页推荐 " + d[0].vod_recent.length + " 条", trim(d[0].vod_recent[0].vodName)));
    }
  } catch (e) {
    rows.push(diagCard("index 异常：" + errText(e), ""));
  }
  try {
    var t = getData("/api/show/v2/type/1/1?pageNum=1&pageSize=18");
    rows.push(
      diagCard("type 接口通：" + trim(t.typeName), "总数 " + t.total + " / 共 " + t.total_page + " 页")
    );
  } catch (e) {
    rows.push(diagCard("type 异常：" + errText(e), ""));
  }
  try {
    var s = getData("/api/show/v2/search/" + enc("庆余年") + "/1");
    rows.push(diagCard("search 接口通", "命中 " + s.total + " 条"));
  } catch (e) {
    rows.push(diagCard("search 异常：" + errText(e), ""));
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
  var text = trim(raw);
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

/** 首页：index 接口按频道分组（4×6），再补一份「热播」18 条，摊平 + 去重 */
function homeList() {
  var all = [];
  var data = getData("/api/show/v2/index");
  if (data && data.length) {
    for (var i = 0; i < data.length; i++) {
      var arr = data[i].vod_recent || [];
      for (var k = 0; k < arr.length; k++) all.push(arr[k]);
    }
  }
  // 热播单独一个接口，挂了不影响首页主体
  try {
    var hot = getData("/api/show/v2/vodhot");
    if (hot && hot.length) {
      for (var j = 0; j < hot.length; j++) all.push(hot[j]);
    }
  } catch (e) {
    lastError = "热播接口失败（不影响首页）：" + errText(e);
  }
  return cardsOf(all);
}

var api = {
  init: function (ext) {
    var e = readExt(ext);
    BASE = (e.api || BASE).replace(/\/+$/, "");
    conf = { api: BASE, ua: e.ua || UA };
  },

  home: function (filter) {
    try {
      var list = homeList();
      if (!list.length) throw new Error("首页没解析到影片，可能接口结构变了");
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
      return J({ list: homeList() });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var page = Math.max(1, Number(pg) || 1);
    var id = String(tid || "1");
    var d = getData("/api/show/v2/type/" + id + "/" + page + "?pageNum=" + page + "&pageSize=18");
    var list = cardsOf(d.vod_recent || []);
    var total = Number(d.total_page) || 1;
    return J({
      list: list,
      page: page,
      pagecount: total,
      limit: Number(d.per_page) || 18,
      total: Number(d.total) || list.length,
    });
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
    var d = getData("/api/show/v2/vod/" + id);
    return J({ list: [parseDetail(d, id)] });
  },

  search: function (key, quick, pg) {
    var page = Math.max(1, Number(pg) || 1);
    var kw = trim(key);
    if (!kw) return J({ list: [], page: 1, pagecount: 1 });
    try {
      var d = getData("/api/show/v2/search/" + enc(kw) + "/" + page);
      var list = cardsOf(d.vods || []);
      if (!list.length) return J({ list: [diagCard("没有搜到：" + kw, "换个关键词试试")], pagecount: 1 });
      return J({
        list: list,
        page: page,
        pagecount: Number(d.total_page) || 1,
        limit: Number(d.page_size) || 18,
        total: Number(d.total) || list.length,
      });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  /** id 就是详情里给出的 m3u8 直链，不需要再请求播放页 */
  play: function (flag, id, vipFlags) {
    var url = trim(id);
    if (!url || url === "__diag") {
      return J({ parse: 0, url: "", msg: lastError || "该线路没有播放地址（线路：" + flag + "）" });
    }
    return J({
      parse: 0,
      url: fixUrl(url),
      header: { "User-Agent": conf.ua || UA, Referer: BASE + "/" },
      format: "application/x-mpegURL",
    });
  },

  destroy: function () {},
};

export default api;
