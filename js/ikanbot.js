/**
 * 爱看机器人 (www1.ikanbot.com) —— FongMi/TV 爬虫脚本
 * ------------------------------------------------------------------
 * 站点是「豆瓣条目聚合器」：一部片用豆瓣 ID 标识，后台再聚合几十个资源站的线路。
 * 不是 MacCMS，也没有 /api.php（404），但有两个稳定的页面 + 一个 JSON 接口：
 *
 *   首页        /                                        24 张卡片（热门电影 8 + 热门剧集 8 + 口碑榜 8）
 *   分类        /hot/index-{movie|tv}-{标签}.html          24 条/页
 *   分类翻页    /hot/index-{movie|tv}-{标签}-p-{page}.html
 *   榜单        /billboard.html                           44 条，不分页
 *   详情        /play/{豆瓣ID}                            页面里带 e_token，再调下面的接口
 *   线路接口    /api/getResN?videoId=&mtype=&token=       一次性返回全部线路 + 全部集的 m3u8 直链
 *   搜索        /search?q={关键词}                        10 条/页（翻页要一次性令牌，只用第 1 页）
 *
 * 关键点：token 是前端算的
 *   play 页里有 current_id（豆瓣ID）和 e_token（40 位随机串），
 *   play_new.js 的 get_tks() 用「ID 后 4 位」当索引，逐位取 e_token 的片段再拼起来：
 *       for (ch of id.slice(-4)) { k = ch%3+1; out += et.substr(k,8); et = et.substr(k+8) }
 *   拼出 32 位 v_tks，作为 /api/getResN 的 token 参数。本脚本的 calcTks() 就是它。
 *   mtype 实测传什么都一样（28 条线路），仍然照页面里的值带上。
 *
 * 播放：
 *   getResN 每条线路的 resData 已经是 MacCMS 的「第01集$https://…/index.m3u8#第02集$…」格式，
 *   而且地址就是最终 m3u8（HLS，部分带 AES-128，播放器自己处理）。所以：
 *     - 详情把每条线路原样列出来（线路1…线路N），App 里逐条可选，播不动可自动换线
 *     - play() 直接把 id（就是 m3u8）返回，parse=0，不再请求任何页面
 *
 * 兼容性（跟合集里其它脚本同一套策略）：
 *   - 不假设 net 存在：net.req → req → http(url,{async:false}) 依次探测
 *   - 全同步请求，方法返回 JSON 字符串
 *   - 不依赖 getUserAgent，UA 写死
 *   - 任何一步失败都给「诊断」卡片，写清失败原因，不静默空白
 */

var BASE = "https://www1.ikanbot.com";
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
  var opt = { headers: headers(referer), timeout: 25000 };
  var r;
  if (b === "net.req") r = net.req(full, opt);
  else if (b === "req") r = req(full, opt);
  else if (b === "http") r = http(full, { headers: headers(referer), timeout: 25000, async: false });
  else throw new Error("没有可用的同步 HTTP 后端（" + capsText() + "）");
  var txt = bodyOf(r, full);
  var need = minLen == null ? 200 : minLen;
  if (!txt || txt.length < need) {
    throw new Error("返回内容过短（" + (txt ? txt.length : 0) + " 字节，可能是 404）：" + full);
  }
  return txt;
}

/** 取一次，失败再取一次（Cloudflare 偶发 5xx / 超时） */
function fetchHtml(url, referer, minLen) {
  try {
    return httpGet(url, referer, minLen);
  } catch (e) {
    lastError = errText(e);
    // 内容过短 = 站点真的返回了 404 空页，重试一次没意义，直接抛出
    if (errText(e).indexOf("过短") >= 0) throw e;
    return httpGet(url, referer, minLen);
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
 * 首页/分类页卡片：
 *   <a class="item" href="/play/1011144">
 *     <div class="embed-responsive cover-wp">
 *       <img class="img-responsive lazy" id="1011144" src="data:image/svg+xml,…"
 *            alt="逃出布迪秀" data-src="https://img9.doubanio.com/…/p2936309806.jpg"/>
 *     </div>
 *     <p>逃出布迪秀</p>
 *   </a>
 * 只认 href="/play/{纯数字}" 且块内出现 cover-wp 的 a 标签，
 * 导航栏里的 /play 链接、榜单里的文字链自然被排除。
 */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /<a\b[^>]*class="item"[^>]*href="\/play\/(\d+)"[^>]*>/gi;
  var m;
  while ((m = re.exec(html)) != null) {
    var id = m[1];
    if (seen[id]) continue;
    var block = html.substring(m.index, m.index + 700);
    if (block.indexOf("cover-wp") < 0) continue;
    var img = one(block, /(<img\b[^>]*>)/i);
    var name = stripTags(attr(img, "alt"));
    if (!name) name = stripTags(one(block, /<p>([\s\S]*?)<\/p>/));
    if (!name) continue;
    seen[id] = 1;
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(attr(img, "data-src") || attr(img, "src")),
      vod_remarks: "",
    });
  }
  return out;
}

/**
 * 搜索结果卡片（media 列表，和首页卡片结构完全不同）：
 *   <div class="media">
 *     <div class="media-left media-top">
 *       <a href="/play/602615" class="cover-link"><img … alt="凡人修仙传" data-src="海报"/></a>
 *     </div>
 *     <div class="media-body">
 *       <h5 class="media-heading">
 *         <a href="/play/602615" class="title-text">凡人修仙传 2020</a>
 *         <span class="label">[35条线路可播放]</span>
 *       </h5>
 *       <span class="small">中国大陆 凡人修仙传：风起天南</span>
 *     </div>
 *   </div>
 * 按 <div class="media"> 切块，比用非贪婪正则去配对 </div> 稳（嵌套层级深，容易切歪）。
 */
function parseSearchCards(html) {
  var out = [];
  var seen = {};
  var parts = String(html == null ? "" : html).split('<div class="media">');
  for (var i = 1; i < parts.length; i++) {
    var block = parts[i].substring(0, 1500);
    var id = one(block, /href="\/play\/(\d+)"/);
    if (!id || seen[id]) continue;
    var img = one(block, /(<img\b[^>]*>)/i);
    var name = stripTags(one(block, /class="title-text">([\s\S]*?)<\/a>/));
    if (!name) name = stripTags(attr(img, "alt"));
    if (!name) continue;
    seen[id] = 1;
    var label = stripTags(one(block, /<span class="label"[^>]*>([\s\S]*?)<\/span>/));
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(attr(img, "data-src") || attr(img, "src")),
      vod_remarks: label.replace(/^\[|\]$/g, ""),
    });
  }
  return out;
}

/**
 * 榜单页（/billboard.html）又是另一种结构，带名次/年份/地区：
 *   <div class="item result-info active">
 *     <div class="item-root">
 *       <h3 style="width: 37px;text-align: center">2</h3>
 *       <a href="/play/1028329"><img … alt="登峰传奇：丹增诺盖" data-src="海报"></a>
 *       <div class="detail">
 *         <a href="/play/1028329"><h5 class="meta title">登峰传奇：丹增诺盖</h5></a>
 *         <div class="meta year small">2025</div>
 *         <div class="meta country small">埃及</div>
 *         <div class="meta celebrity small">演员…</div>
 */
function parseBillboard(html) {
  var out = [];
  var seen = {};
  var parts = String(html == null ? "" : html).split('<div class="item result-info');
  for (var i = 1; i < parts.length; i++) {
    var block = parts[i].substring(0, 2600);
    var id = one(block, /href="\/play\/(\d+)"/);
    if (!id || seen[id]) continue;
    var img = one(block, /(<img\b[^>]*>)/i);
    var name = stripTags(one(block, /<h5 class="meta title"[^>]*>([\s\S]*?)<\/h5>/));
    if (!name) name = stripTags(attr(img, "alt"));
    if (!name) continue;
    seen[id] = 1;
    var rank = stripTags(one(block, /<h3[^>]*>([\s\S]*?)<\/h3>/));
    var year = stripTags(one(block, /class="meta year small"[^>]*>([\s\S]*?)<\/div>/));
    var area = stripTags(one(block, /class="meta country small"[^>]*>([\s\S]*?)<\/div>/));
    var rm = [];
    if (/^\d+$/.test(rank)) rm.push("No." + rank);
    if (year) rm.push(year);
    if (area) rm.push(area);
    out.push({
      vod_id: id,
      vod_name: name,
      vod_pic: absUrl(attr(img, "data-src") || attr(img, "src")),
      vod_remarks: rm.join(" · "),
    });
  }
  return out;
}

/** 是否还有下一页（模板在 .page-more 里放「下一页」） */
function hasNext(html) {
  return /class="page-more"[^>]*>[\s\S]{0,200}?下一页/.test(String(html == null ? "" : html));
}

/* ============================== token 与线路接口 ============================== */

/**
 * 复刻 play_new.js 的 get_tks()：
 *   id 取后 4 位，逐位 d → k = d%3+1 → 从 e_token 里切 [k, k+8)，再让 e_token 前进 k+8
 * 拼出来的 32 位串就是 /api/getResN 的 token。
 */
function calcTks(vid, et) {
  var s = String(vid == null ? "" : vid);
  var rest = String(et == null ? "" : et);
  if (s.length < 4 || rest.length < 12) return "";
  var tail = s.substring(s.length - 4);
  var out = "";
  for (var i = 0; i < tail.length; i++) {
    var d = parseInt(tail.charAt(i), 10);
    if (isNaN(d)) continue;
    var k = (d % 3) + 1;
    out += rest.substring(k, k + 8);
    rest = rest.substring(k + 8);
  }
  return out;
}

/** 调线路接口，返回 data.list（每条 {siteId,id,resData}） */
function getLines(vid, mtype, tks) {
  var url = "/api/getResN?videoId=" + enc(vid) + "&mtype=" + enc(mtype || "") + "&token=" + enc(tks);
  var txt = fetchHtml(url, BASE + "/play/" + vid, 20);
  var d;
  try {
    d = JSON.parse(txt);
  } catch (e) {
    throw new Error("线路接口返回的不是 JSON：" + txt.substring(0, 100));
  }
  if (Number(d.state) !== 1) {
    throw new Error("线路接口 state=" + d.state + "（" + (d.message || "无 message") + "），token 可能过期");
  }
  var list = (d.data && d.data.list) || [];
  return list;
}

/**
 * 把 resData 转成 vod_play_url 用的串。
 * resData 形如 [{"flag":"xlm3u8","url":"第01集$https://…#第02集$https://…"}]，
 * 里面已经是「集名$地址」格式，但个别线路会带脏数据（实测 yhm3u8 的地址尾部挂着
 * "$yhm3u8"），而 $ 正是 App 的分隔符，不清掉会导致整条线路的集数错乱，所以逐条重建。
 */
function resDataToUrl(rd) {
  var s = String(rd == null ? "" : rd).replace(/^\s+|\s+$/g, "");
  if (!s) return "";
  // resData 是 JSON 数组字符串：[{"flag":"xlm3u8","url":"第01集$https://…#…"}]
  if (s.charAt(0) === "[") {
    try {
      var arr = JSON.parse(s);
      if (arr && arr.length) s = String(arr[0].url || "");
    } catch (e) {
      // 有些线路 resData 不是合法 JSON，退回正则抠
      s = one(s, /"url"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    }
  }
  s = s.replace(/\\\//g, "/");
  if (s.indexOf("$") < 0) return "";

  var parts = s.split("#");
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = String(parts[i]);
    var k = p.indexOf("$");
    if (k < 0) continue;
    var nm = p.substring(0, k).replace(/^\s+|\s+$/g, "").replace(/\$/g, " ");
    var u = p.substring(k + 1);
    var d = u.indexOf("$");
    if (d >= 0) u = u.substring(0, d);
    u = u.replace(/^\s+|\s+$/g, "");
    if (!u || u.indexOf("http") !== 0) continue;
    if (!nm) nm = "第" + (out.length + 1) + "集";
    out.push(nm + "$" + u);
  }
  if (!out.length) return "";
  return out.join("#");
}

/* ============================== 频道与筛选 ============================== */

var CLASSES = [
  { type_id: "movie", type_name: "电影" },
  { type_id: "tv", type_name: "剧集" },
  { type_id: "billboard", type_name: "榜单" },
];

/** 站点自己的标签导航（电影 17 个、剧集 10 个），作为分类里的「类型」筛选 */
var TAGS = {
  movie: [
    "热门",
    "最新",
    "经典",
    "豆瓣高分",
    "冷门佳片",
    "华语",
    "欧美",
    "韩国",
    "日本",
    "动作",
    "喜剧",
    "爱情",
    "科幻",
    "悬疑",
    "恐怖",
    "成长",
    "豆瓣top250",
  ],
  tv: ["热门", "美剧", "英剧", "韩剧", "日剧", "国产剧", "港剧", "日本动画", "综艺", "纪录片"],
};

function filtersFor(tid) {
  var tags = TAGS[tid];
  if (!tags) return [];
  var value = [];
  for (var i = 0; i < tags.length; i++) value.push({ n: tags[i], v: tags[i] });
  return [{ key: "class", name: "类型", value: value }];
}

function cateUrl(tid, tag, page) {
  if (tid === "billboard") return "/billboard.html";
  var t = tag || "热门";
  var head = "/hot/index-" + tid + "-" + enc(t);
  if (page > 1) return head + "-p-" + page + ".html";
  return head + ".html";
}

/* ============================== 详情解析 ============================== */

/** 从播放页取「别名 / 年份 / 地区 / 导演 / 演员」 */
function parseMeta(html) {
  var out = { alias: "", year: "", area: "", director: "", actor: "" };
  // 只认当前选中条目的那块（同名影片页面上会有多个 result-info）
  var idx = html.indexOf("result-info active");
  var block = idx > 0 ? html.substring(idx, idx + 1200) : html;
  var metas = [];
  var re = /<h3 class="meta"[^>]*>([\s\S]*?)<\/h3>/g;
  var m;
  while ((m = re.exec(block)) != null) {
    var t = stripTags(m[1]);
    if (t) metas.push(t);
  }
  if (metas.length >= 1) out.alias = metas[0];
  if (metas.length >= 2) out.year = metas[1];
  if (metas.length >= 3) out.area = metas[2];
  if (metas.length >= 4) {
    var crew = metas[3].split("/");
    if (crew.length >= 2) {
      out.director = crew[0].replace(/,/g, " ");
      out.actor = crew.slice(1).join(" ").replace(/,/g, " ");
    } else {
      out.actor = metas[3].replace(/,/g, " ");
    }
  }
  return out;
}

function buildDetail(id) {
  var playUrl = "/play/" + enc(id);
  var html = fetchHtml(playUrl, BASE + "/", 500);

  var name = stripTags(one(html, /id="video_title"[^>]*>([\s\S]*?)<\/h1>/));
  if (!name) name = stripTags(one(html, /<meta property="og:title" content="([^"]*)"/));
  var pic = absUrl(one(html, /<meta property="og:image" content="([^"]*)"/));
  if (!pic) pic = absUrl(one(html, /class="cover lazy"[^>]*data-src="([^"]*)"/));

  var desc = one(html, /<meta name="description" content="([^"]*)"/);
  var lineCount = one(desc, /搜到\s*(\d+)\s*条/);

  var et = one(html, /id="e_token"\s+value="([^"]*)"/);
  var mtype = one(html, /id="mtype"\s+value="([^"]*)"/);
  var vid = one(html, /id="current_id"\s+value="([^"]*)"/) || String(id);

  var meta = parseMeta(html);

  var vod = {
    vod_id: String(id),
    vod_name: name || "未知标题",
    vod_pic: pic,
    vod_remarks: lineCount ? lineCount + " 条线路" : "",
    vod_year: meta.year,
    vod_area: meta.area,
    vod_type: meta.alias,
    vod_director: meta.director,
    vod_actor: meta.actor,
    vod_content: "",
  };
  var text = desc || "";
  if (meta.alias) text += "\n别名：" + meta.alias;
  if (meta.director) text += "\n导演：" + meta.director;
  if (meta.actor) text += "\n主演：" + meta.actor;
  vod.vod_content = text.replace(/^\s+|\s+$/g, "");

  // 没拿到 token 就别白跑接口
  if (!et) {
    vod.vod_play_from = "无";
    vod.vod_play_url = "暂无播放源$" + id;
    vod.vod_remarks = vod.vod_remarks || "无 token";
    return vod;
  }

  var tks = calcTks(vid, et);
  var lines;
  try {
    lines = getLines(vid, mtype, tks);
  } catch (e) {
    lastError = errText(e);
    vod.vod_play_from = "诊断";
    vod.vod_play_url = "线路接口失败$__diag";
    vod.vod_content += "\n\n线路接口失败：" + errText(e);
    return vod;
  }

  var from = [];
  var urls = [];
  var used = {};
  for (var i = 0; i < lines.length; i++) {
    var it = lines[i] || {};
    var u = resDataToUrl(it.resData);
    if (!u) continue; // 空线路（有的条目 siteId 有但没地址）跳过
    var flag = one(String(it.resData || ""), /"flag"\s*:\s*"([^"]*)"/);
    var label = "线路" + (from.length + 1);
    if (flag) label += "·" + flag;
    if (used[label]) label = label + "-" + (from.length + 1);
    used[label] = 1;
    from.push(label);
    urls.push(u);
  }

  if (!from.length) {
    vod.vod_play_from = "无";
    vod.vod_play_url = "暂无播放源$" + id;
    vod.vod_remarks = "接口未返回线路";
    return vod;
  }
  vod.vod_play_from = from.join("$$$");
  vod.vod_play_url = urls.join("$$$");
  vod.vod_remarks = from.length + " 条线路";
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
    var list = parseCards(fetchHtml(cateUrl("movie", "热门", 1), BASE + "/"));
    rows.push(diagCard("分类解析到 " + list.length + " 张卡片", list.length ? list[0].vod_name : ""));
  } catch (e) {
    rows.push(diagCard("分类异常：" + errText(e), ""));
  }
  try {
    var h = fetchHtml("/play/602615", BASE + "/", 500);
    var et = one(h, /id="e_token"\s+value="([^"]*)"/);
    rows.push(diagCard("详情页 GET 成功", et ? "e_token 长度 " + et.length : "没有 e_token"));
    if (et) {
      var tks = calcTks("602615", et);
      var lines = getLines("602615", one(h, /id="mtype"\s+value="([^"]*)"/), tks);
      rows.push(diagCard("线路接口返回 " + lines.length + " 条线路", "token 长度 " + tks.length));
    }
  } catch (e) {
    rows.push(diagCard("线路接口异常：" + errText(e), ""));
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
    var tag = String(e.class || (TAGS[tid] ? TAGS[tid][0] : "热门"));
    var url = cateUrl(String(tid), tag, page);
    var html;
    try {
      html = fetchHtml(url, BASE + "/");
    } catch (err) {
      // 超出最后一页时站点直接 404，这里当「没有更多」处理
      return J({ list: [], page: page, pagecount: page, limit: 24, total: (page - 1) * 24 });
    }
    var list = String(tid) === "billboard" ? parseBillboard(html) : parseCards(html);
    var next = hasNext(html) ? page + 1 : page;
    return J({ list: list, page: page, pagecount: next, limit: 24, total: next * 24 });
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
    return J({ list: [buildDetail(id)] });
  },

  search: function (key, quick, pg) {
    var k = String(key == null ? "" : key).replace(/^\s+|\s+$/g, "");
    if (!k) return J({ list: [diagCard("关键词为空", "请输入片名")], pagecount: 1 });
    try {
      // 站点搜索固定 10 条一页，翻页要一次性令牌（n 参数），实际只用第 1 页
      var html = fetchHtml("/search?q=" + enc(k), BASE + "/");
      var list = parseSearchCards(html);
      if (!list.length) {
        if (html.indexOf("没有找到") >= 0 || html.indexOf("暂无") >= 0) {
          return J({ list: [diagCard("没有搜到：" + k, "换个关键词试试")], pagecount: 1 });
        }
        return J({ list: [diagCard("没有搜到：" + k, "页面长度 " + html.length)], pagecount: 1 });
      }
      return J({ list: list, page: 1, pagecount: 1, limit: 10 });
    } catch (e) {
      lastError = errText(e);
      return J({ list: [diagCard("搜索失败：" + errText(e), "")], pagecount: 1 });
    }
  },

  play: function (flag, id, vipFlags) {
    if (id === "__diag") return J({ parse: 0, url: "", msg: lastError || "无错误信息" });
    var url = String(id == null ? "" : id).replace(/^\s+|\s+$/g, "");
    if (!url) throw new Error("选集地址为空（线路：" + flag + "）");
    // 详情里给的已经是最终 m3u8，直接交给播放器
    return J({
      parse: 0,
      url: url,
      header: { "User-Agent": conf.ua || UA },
    });
  },

  destroy: function () {},
};

export default api;
