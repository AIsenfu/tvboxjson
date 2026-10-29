/**
 * KanAV (v1.kanav.world) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是 MacCMS v10 + YS008 模板，但只开了「网页解析」这一条路：
 *   /api.php/provide/vod/?ac=list  →  返回 `closed`，采集接口关掉了
 *   /index.php/vod/detail/id/{id}.html  →  返回 1 字节空页，没有独立详情页
 *
 * 实际可用路径（全部 200，UA 用浏览器即可，不需要 cookie / 不需要过 CF 挑战）：
 *   首页        /                                            7 段共 64 张卡片
 *   分类        /index.php/vod/show/by/{排序}/id/{tid}.html    24 条/页
 *   分类翻页    /index.php/vod/show/by/{排序}/id/{tid}/page/{n}.html
 *   热门        /index.php/label/hot.html                    48 条，不分页
 *   详情+播放   /index.php/vod/play/id/{id}/sid/1/nid/1.html  页面即详情页
 *   搜索        /index.php/vod/search.html?wd={kw}&by=time_add  24 条/页
 *   搜索翻页    /index.php/vod/search/page/{n}/wd/{kw}.html
 *
 * 卡片链接直接指向 play 页（sid/nid 恒为 1/1，实测 5 个分类 100+ 条无一例外），
 * 所以「详情」就用 play 页：标题 h1、海报 .countext-img、上映日期、分类、标签都在里面。
 *
 * 播放地址（关键）：
 *   play 页内联 `var player_aaaa={...,"encrypt":2,"url":"..."}`
 *   encrypt=2 → url 是 base64，解开后是「百分号编码的地址」，再 decodeURIComponent 才得到真链：
 *       JTY4JTc0… → %68%74%74%70%73… → https://cdn10.11yun.space/TAV1/345699/345699.m3u8
 *   m3u8 是 HLS 直链（无 AES），但 CDN 做了防盗链：不带 Referer 一律 403，
 *   带 `Referer: https://v1.kanav.world/` 才 200。所以 play() 必须把 Referer/UA 交给播放器。
 *
 * 兼容性（跟合集里其它脚本同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串
 *   - 不依赖 getUserAgent / atob，UA 与 base64 都自己实现（QuickJS 里不保证有）
 *   - 任何一步失败都给「诊断」卡片，写清失败原因，不静默空白
 */

var BASE = "https://v1.kanav.world";
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

function trim(s) {
  return String(s == null ? "" : s).replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
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
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
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

/** 同步 GET；相对路径按 BASE 拼。minLen 用来挡住 404 空页 */
function httpGet(url, referer, minLen) {
  var full = /^https?:\/\//i.test(url) ? url : BASE + (url.charAt(0) === "/" ? url : "/" + url);
  var b = backend();
  var r;
  if (b === "net.req") r = net.req(full, { headers: headers(referer), timeout: 25000 });
  else if (b === "req") r = req(full, { headers: headers(referer), timeout: 25000 });
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 25000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var txt = bodyOf(r, full);
  var need = minLen == null ? 200 : minLen;
  if (!txt || txt.length < need) {
    throw new Error("返回内容过短（" + (txt ? txt.length : 0) + " 字节，可能是空页/404）：" + full);
  }
  return txt;
}

/** 取一次，失败再取一次（站点偶发 5xx / 超时） */
function fetchHtml(url, referer, minLen) {
  try {
    return httpGet(url, referer, minLen);
  } catch (e) {
    lastError = errText(e);
    // 内容过短 = 站点真的返回了空页，重试没意义
    if (errText(e).indexOf("过短") >= 0) throw e;
    return httpGet(url, referer, minLen);
  }
}

function one(s, re) {
  var m = re.exec(String(s == null ? "" : s));
  return m ? m[1] : "";
}

/** 取最后一次匹配（卡片里图在前、标题在后，往前找图时要用「最近的那张」） */
function lastOne(s, re) {
  var str = String(s == null ? "" : s);
  var out = "";
  var m;
  var g = new RegExp(re.source, "gi");
  while ((m = g.exec(str)) != null) {
    out = m[1];
    if (m.index === g.lastIndex) g.lastIndex++;
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

function stripTags(s) {
  return decodeHtml(
    String(s == null ? "" : s)
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[\s\u3000]+/g, " ")
    .replace(/^[\s\u3000]+|[\s\u3000]+$/g, "");
}

function attr(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*\"([^\"]*)\"", "i").exec(tag);
  return m ? decodeHtml(m[1]) : "";
}

function absUrl(u) {
  var s = trim(u);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf("//") === 0) return "https:" + s;
  if (s.charAt(0) === "/") return BASE + s;
  return BASE + "/" + s;
}

function enc(s) {
  return encodeURIComponent(String(s == null ? "" : s));
}

/* ---- base64 / 百分号解码：QuickJS 不保证有 atob、decodeURIComponent 也有坑，全部自己来 ---- */

var B64CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function b64d(s) {
  var str = String(s == null ? "" : s).replace(/[^A-Za-z0-9+/=]/g, "");
  var out = "";
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charAt(i);
    if (c === "=") break;
    var v = B64CHARS.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buf >> bits) & 0xff);
    }
  }
  return out;
}

/** UTF-8 字节串 → 字符串（播放地址本身是 ASCII，这里只是防止个别线路带中文） */
function utf8Decode(bin) {
  var out = "";
  for (var i = 0; i < bin.length; i++) {
    var c = bin.charCodeAt(i);
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c >= 0xc0 && c < 0xe0 && i + 1 < bin.length) {
      out += String.fromCharCode(((c & 0x1f) << 6) | (bin.charCodeAt(++i) & 0x3f));
    } else if (c >= 0xe0 && c < 0xf0 && i + 2 < bin.length) {
      out += String.fromCharCode(
        ((c & 0x0f) << 12) | ((bin.charCodeAt(++i) & 0x3f) << 6) | (bin.charCodeAt(++i) & 0x3f)
      );
    } else {
      out += String.fromCharCode(c);
    }
  }
  return out;
}

function pctDecode(s) {
  var str = String(s == null ? "" : s);
  if (str.indexOf("%") < 0) return str;
  var bin = str.replace(/%([0-9A-Fa-f]{2})/g, function (a, h) {
    return String.fromCharCode(parseInt(h, 16));
  });
  return utf8Decode(bin);
}

/* ============================== 列表解析 ============================== */

/**
 * 卡片（首页/分类/搜索/相关推荐同一套）：
 *   <div class="col-md-3 col-sm-6 col-xs-6">
 *     <div class="video-item"><div class="featured-content-image">
 *       <a href="/index.php/vod/play/id/129615/sid/1/nid/1.html"><img class="lazy"
 *          data-original="海报" src="海报" alt="标题"/><div class="link-overlay"></div></a>
 *       <span class="model-view-left">1498 Views</span>       ← 列表页是播放量，首页是分类名
 *       <span class="model-view">2小时 30分钟</span>          ← 时长
 *     </div></div>
 *     <div class="entry-title">
 *       <a title="标题" href="…play/id/…">标题</a> 2026 / 10 / 29     ← 发布日期
 *     </div>
 *   </div>
 *
 * 用 entry-title 当锚点、往前找最近的一张图，比按 col-md-3 切块稳：
 * 分类页 24 张卡片却有 29 个 col-md-3（广告位也用这个 class），切块会混进广告。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var src = String(html == null ? "" : html);
  var re = /<div class="entry-title">([\s\S]{0,800}?)<\/div>/g;
  var m;
  while ((m = re.exec(src)) != null) {
    var block = m[1];
    var id = one(block, /\/index\.php\/vod\/play\/id\/(\d+)\//);
    if (!id || seen[id]) continue;

    var back = src.substring(Math.max(0, m.index - 1600), m.index);
    var imgTag = lastOne(back, /(<img\b[^>]*>)/);
    var pic = attr(imgTag, "data-original") || attr(imgTag, "src");
    if (pic && pic.indexOf("data:image") === 0) pic = "";
    var name = stripTags(one(block, /<a[^>]*>([\s\S]*?)<\/a>/));
    if (!name) name = stripTags(attr(imgTag, "alt"));
    if (!name) continue;

    var left = stripTags(lastOne(back, /class="model-view-left"[^>]*>([\s\S]*?)<\/span>/));
    var dur = stripTags(lastOne(back, /class="model-view"[^>]*>([\s\S]*?)<\/span>/));
    var date = stripTags(block.replace(/<a[\s\S]*?<\/a>/i, ""));
    var ym = /(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})/.exec(date);
    if (ym) date = ym[1] + "-" + (ym[2].length < 2 ? "0" + ym[2] : ym[2]) + "-" + (ym[3].length < 2 ? "0" + ym[3] : ym[3]);

    var rm = [];
    if (dur) rm.push(dur);
    if (date) rm.push(date);
    if (left && !/\d+\s*Views?$/i.test(left)) rm.unshift(left);

    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(pic),
      vod_remarks: rm.join(" · "),
    });
  }
  return out;
}

/** 分页总条数：模板把总数放在隐藏 div 里（<div class="total">19537</div>），24 条一页 */
function pageCount(html, page) {
  var total = Number(one(html, /class="total"[^>]*>(\d+)</));
  if (total > 0) {
    var pc = Math.ceil(total / 24);
    return pc > 0 ? pc : 1;
  }
  // 没有总数时退回「有下一页 = 当前页 + 1」的启发式
  var hasNext = new RegExp("/page/" + (Number(page) + 1) + "\\.html").test(String(html == null ? "" : html));
  return hasNext ? Number(page) + 1 : Number(page);
}

/* ============================== 频道与筛选 ============================== */

var CLASSES = [
  { type_id: "1", type_name: "中文字幕" },
  { type_id: "2", type_name: "日韩有码" },
  { type_id: "3", type_name: "日韩无码" },
  { type_id: "4", type_name: "国产AV" },
  { type_id: "22", type_name: "流出自拍" },
  { type_id: "30", type_name: "└ 自拍泄密" },
  { type_id: "31", type_name: "└ 探花约炮" },
  { type_id: "32", type_name: "└ 主播录制" },
  { type_id: "20", type_name: "动漫番剧" },
  { type_id: "25", type_name: "└ 里番" },
  { type_id: "26", type_name: "└ 泡面番" },
  { type_id: "27", type_name: "└ Motion Anime" },
  { type_id: "28", type_name: "└ 3D动画" },
  { type_id: "29", type_name: "└ 同人作品" },
  { type_id: "hot", type_name: "热门影片" },
];

/** 站点自己的排序按钮（分类页右上角那三个），当作唯一的筛选维度 */
var SORTS = [
  { n: "最新发布", v: "time_add" },
  { n: "最多观看", v: "hits" },
  { n: "本周热榜", v: "hits_week" },
];

function filtersFor(tid) {
  if (String(tid) === "hot") return [];
  return [{ key: "by", name: "排序", value: SORTS }];
}

function cateUrl(tid, by, page) {
  if (String(tid) === "hot") return "/index.php/label/hot.html";
  var sort = by || "time_add";
  var head = "/index.php/vod/show/by/" + sort + "/id/" + tid;
  return Number(page) > 1 ? head + "/page/" + page + ".html" : head + ".html";
}

/* ============================== 详情与播放 ============================== */

function playPageUrl(id) {
  return "/index.php/vod/play/id/" + id + "/sid/1/nid/1.html";
}

/**
 * 解 player_aaaa 里的 url：
 *   encrypt 0 → 明文
 *   encrypt 1 → 百分号编码
 *   encrypt 2 → base64(百分号编码)
 * 三种都先按 base64 试一把，解出来不像地址就退回原文，再统一做百分号解码。
 */
function decodePlayer(html) {
  var src = String(html == null ? "" : html);
  var m = /var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(src);
  if (!m) return "";
  var raw = m[1];
  var url = one(raw, /"url"\s*:\s*"([^"]*)"/);
  var encrypt = one(raw, /"encrypt"\s*:\s*"?(\d+)"?/);
  var s = trim(url.replace(/\\\//g, "/"));
  if (!s) return "";

  if (!/^https?:\/\//i.test(s)) {
    var t = b64d(s);
    if (t && (t.indexOf("%") === 0 || /^https?:\/\//i.test(t))) s = t;
  }
  if (s.indexOf("%") >= 0) s = pctDecode(s);
  s = trim(s);
  if (!/^https?:\/\//i.test(s)) return "";
  // 站点偶尔给 .m3u8?xxx 之外的东西，这里不挑协议，原样交给播放器
  return s;
}

/**
 * 标题清理：
 *   多数页面 <h3>（封面图上方那行）是干净标题；
 *   但同人/3D 这类条目会把 SEO 长文本塞进 <h1>：
 *     「标题：XXX 品牌：YYY 发布日期：… 文件大小：… 点击此处购买…」
 *   所以先取 h3，再取 h1，最后退回 <title>，并统一剪掉这些前缀。
 */
function cleanTitle(s) {
  var t = stripTags(s).replace(/^标题\s*[:：]\s*/, "");
  t = t.replace(/\s*(品牌|發布日期|发布日期|文件大小|番號|番号|点击此处|點擊此處)\s*[:：][\s\S]*$/, "");
  t = trim(t);
  return t.length > 90 ? t.substring(0, 90) : t;
}

function buildDetail(id) {
  var html = fetchHtml(playPageUrl(id), BASE + "/", 500);

  // 影片被删时站点回 404 页（HTTP 404、有「404！」h1、没有 player_aaaa），这里挡住
  if (html.indexOf("player_aaaa") < 0 && html.indexOf("countext-img") < 0) {
    throw new Error("不是播放页（影片可能已删除，或 id=" + id + " 不存在）");
  }

  var box = one(html, /class="video-box-ather[^"]*"[^>]*>([\s\S]{0,4000})/);
  var name = cleanTitle(one(box, /<h3[^>]*>([\s\S]*?)<\/h3>/));
  if (!name) name = cleanTitle(one(html, /<h1>([\s\S]*?)<\/h1>/));
  if (!name) {
    name = cleanTitle(
      stripTags(one(html, /<title>([\s\S]*?)<\/title>/)).replace(/^在线播放\s*[-–—]\s*/, "")
    ).replace(/\s*[-–—]\s*KanAV[\s\S]*$/i, "");
  }
  var pic = absUrl(one(html, /class="countext-img"[^>]*\bsrc="([^"]*)"/));
  if (!pic) pic = absUrl(one(html, /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/));

  // 分类区块：上映日期 + 分类链接；标签区块：hr-tags 后的关键词链接
  var catsBlock = one(html, /class="video-countext-categories[^"]*"[^>]*>([\s\S]*?)<div class="video-countext-tags/);
  var tagsBlock = one(html, /class="hr-style hr-tags info"><\/div>([\s\S]*?)<\/div>/);

  var year = one(catsBlock, /上映日期：\s*(\d{4})/);
  var date = one(catsBlock, /上映日期：\s*([\d-]+)/);
  var cats = [];
  var re = /<a[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(catsBlock)) != null) {
    var t = stripTags(m[1]);
    if (t && t.indexOf("上映日期") < 0) cats.push(t);
  }
  var tags = [];
  var seenTag = {};
  re = /<a[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = re.exec(tagsBlock)) != null) {
    var tg = stripTags(m[1]);
    if (tg && !seenTag[tg]) {
      seenTag[tg] = 1;
      tags.push(tg);
    }
  }

  var m3u8 = "";
  try {
    m3u8 = decodePlayer(html);
  } catch (e) {
    lastError = errText(e);
  }

  var lines = [];
  if (date) lines.push("上映日期：" + date);
  if (cats.length) lines.push("分类：" + cats.join(" / "));
  if (tags.length) lines.push("标签：" + tags.join(" "));
  lines.push("播放地址：" + (m3u8 ? "m3u8 直连（需 Referer）" : "未解析到，播放时重试"));

  var vod = {
    vod_id: String(id),
    vod_name: name || "未知标题",
    vod_pic: pic,
    vod_remarks: cats.length ? cats[0] : "",
    vod_year: year,
    vod_type: cats.join(","),
    vod_content: lines.join("\n"),
  };

  // 单线路单集：sid/nid 恒为 1/1，所以「线路1 / 正片」就够了。
  // 地址能当场解出来就直接塞进选集（点开即播，省一次请求）；
  // 解不出来就塞 id，让 play() 再去页面里取一次。
  vod.vod_play_from = "线路1";
  vod.vod_play_url = "正片$" + (m3u8 || String(id));
  return vod;
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
    var html = fetchHtml("/", BASE + "/");
    var cards = parseCards(html);
    rows.push(diagCard("首页 GET 成功", "长度 " + html.length));
    rows.push(diagCard("首页解析到 " + cards.length + " 张卡片", cards.length ? cards[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("首页异常：" + errText(e), ""));
  }
  try {
    var lh = fetchHtml(cateUrl("1", "time_add", 1), BASE + "/");
    var list = parseCards(lh);
    rows.push(diagCard("分类解析到 " + list.length + " 张卡片", "共 " + pageCount(lh, 1) + " 页"));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
  }
  try {
    var sh = fetchHtml("/index.php/vod/search.html?wd=" + enc("SSNI"), BASE + "/");
    rows.push(diagCard("搜索解析到 " + parseCards(sh).length + " 张卡片", "共 " + pageCount(sh, 1) + " 页"));
  } catch (e) {
    rows.push(diagCard("搜索异常：" + errText(e), ""));
  }
  try {
    var ph = fetchHtml(playPageUrl("129377"), BASE + "/", 500);
    var u = decodePlayer(ph);
    rows.push(diagCard(u ? "播放地址解析成功" : "播放地址解析失败", u ? u.substring(0, 60) : ""));
  } catch (e) {
    rows.push(diagCard("详情页异常：" + errText(e), ""));
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

var api = {
  init: function (ext) {
    var e = readExt(ext);
    BASE = (e.api || "https://v1.kanav.world").replace(/\/+$/, "");
    conf = { api: BASE, ua: e.ua || UA };
  },

  home: function (filter) {
    try {
      var html = fetchHtml("/", BASE + "/");
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
      return J({ list: parseCards(fetchHtml("/", BASE + "/")) });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("首页失败：" + errText(e), "")] });
    }
  },

  category: function (tid, pg, filter, extend) {
    if (tid === "__diag") return J(diagnose());
    var e = extend || {};
    var page = Math.max(1, Number(pg) || 1);
    var by = String(e.by || "time_add");
    var url = cateUrl(String(tid), by, page);
    var html;
    try {
      html = fetchHtml(url, BASE + "/");
    } catch (err) {
      // 超出最后一页时站点直接回空页，这里当「没有更多」处理
      lastError = errText(err);
      return J({ list: [], page: page, pagecount: page, limit: 24, total: (page - 1) * 24 });
    }
    var list = parseCards(html);
    var pc = pageCount(html, page);
    return J({ list: list, page: page, pagecount: pc, limit: 24, total: pc * 24 });
  },

  detail: function (id) {
    if (id === "__diag") {
      return J({
        list: [
          {
            vod_id: "__diag",
            vod_name: "诊断信息",
            vod_pic: "",
            vod_content: ["base = " + BASE, "后端 = " + backend(), "能力 = " + capsText(), "最后错误 = " + (lastError || "(无)")].join("\n"),
            vod_play_from: "诊断",
            vod_play_url: "第1集$__diag",
          },
        ],
      });
    }
    try {
      return J({ list: [buildDetail(id)] });
    } catch (e) {
      // 片子被删/页面改版时别让 App 白屏，给一张能看懂的卡片
      lastError = errText(e);
      return J({
        list: [
          {
            vod_id: String(id),
            vod_name: "打不开：" + id,
            vod_pic: "",
            vod_content: "详情页取不到：" + errText(e) + "\nbase = " + BASE + "\n后端 = " + backend(),
            vod_play_from: "诊断",
            vod_play_url: "第1集$__diag",
          },
        ],
      });
    }
  },

  search: function (key, quick, pg) {
    var k = trim(key);
    if (!k) return J({ list: [diagCard("关键词为空", "请输入片名")], pagecount: 1 });
    var page = Math.max(1, Number(pg) || 1);
    var url =
      page > 1
        ? "/index.php/vod/search/page/" + page + "/wd/" + enc(k) + ".html"
        : "/index.php/vod/search.html?wd=" + enc(k) + "&by=time_add";
    try {
      var html = fetchHtml(url, BASE + "/");
      var list = parseCards(html);
      var pc = pageCount(html, page);
      if (!list.length) {
        if (page > 1) return J({ list: [], page: page, pagecount: page - 1, limit: 24 });
        return J({ list: [diagCard("没有搜到：" + k, "换个关键词试试")], pagecount: 1 });
      }
      return J({ list: list, page: page, pagecount: pc, limit: 24, total: pc * 24 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var s = trim(id);
    if (!s) throw new Error("选集地址为空（线路：" + flag + "）");

    // 详情里已经解出 m3u8 的话直接给播放器；否则按影片 id 再取一次页面
    if (!/^https?:\/\//i.test(s)) {
      var html = fetchHtml(playPageUrl(s), BASE + "/", 500);
      var u = decodePlayer(html);
      if (!u) throw new Error("没解析到播放地址（id=" + s + "），player_aaaa 可能改了");
      s = u;
    }

    // CDN 防盗链：不带 Referer 一律 403，必须交给播放器
    return J({
      parse: 0,
      url: s,
      header: {
        "User-Agent": conf.ua || UA,
        Referer: BASE + "/",
      },
    });
  },

  destroy: function () {},
};

export default api;
