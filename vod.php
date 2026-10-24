<?php
/**
 * 晚安影视 · 影视配置（PHP 版）：读 site.txt，一个链接多个站
 * ------------------------------------------------------------------
 * 关键点：
 *   - api 用相对路径 ./js/xxx.js，App 会按 vod.php 自身地址展开成绝对 URL，
 *     所以整个目录搬到哪、换什么域名都成立（层级别改：js/ 必须和 vod.php 同级）。
 *   - site.txt 写 key=地址，一行一个；换镜像域名只改它，App 里填的链接不用动。
 *   - 这些站都不需要 cookie，所以这里没有 cookie.txt。
 *   - key 不能重复，重复会被 App 去重掉。
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

/* ------------------------- 读 site.txt ------------------------- */

$defaults = [
    'guobayu'  => 'https://www.guobayu.com',
    'cupfox7'  => 'https://www.cupfox7.com',
    'mahuabox' => 'https://www.mahuabox.com',
    'nfg'      => 'https://nfg.oddym.com',
    'kkjpliu'  => 'https://www.kkjpliu.com',
    'chicey'   => 'https://chicey.com',
    'tiaozhanjia' => 'https://www.tiaozhanjia.com',
    'pbstore'  => 'https://www.pb-store.com',
    'silidm'   => 'https://silidm.com',
];
$hosts = $defaults;

$siteFile = __DIR__ . '/site.txt';
if (is_file($siteFile)) {
    foreach (preg_split('/[\r\n]+/', (string) file_get_contents($siteFile)) as $row) {
        $row = trim(str_replace("\xEF\xBB\xBF", '', $row)); // 去 BOM（第一行常见）
        if ($row === '' || $row[0] === '#') {
            continue;
        }
        if (strpos($row, '=') !== false) {
            list($k, $v) = explode('=', $row, 2);
            $k = strtolower(trim($k));
            $v = trim($v);
            if ($k !== '' && $v !== '') {
                $hosts[$k] = $v;
            }
        }
    }
}

/** 没写协议补 https://，末尾斜杠去掉 */
function norm($url)
{
    $url = trim($url);
    if ($url === '') {
        return '';
    }
    if (stripos($url, 'http') !== 0) {
        $url = 'https://' . $url;
    }
    return rtrim($url, '/');
}

/* --------------------------- 站点表 --------------------------- */

// 一段一个站：key / 显示名 / 脚本文件名 / 超时秒数（聚合站 nfg 跨站取源，给大点）
$rows = [
    ['guobayu',  '锅巴鱼影院', 'guobayu.js',  20],
    ['cupfox7',  '茶杯狐',     'cupfox7.js',  20],
    ['mahuabox', '麻花影视',   'mahuabox.js', 20],
    ['nfg',      '哒哒影漫',   'nfg.js',      30],
    ['kkjpliu',  '金牌影院',   'kkjpliu.js',  20],
    ['chicey',   '策驰影院',   'chicey.js',   20],
    // 樱花影视：MacCMS v10 静态 HTML（官方 JSON 接口 404），只抓页面；换镜像改 site.txt
    ['tiaozhanjia', '樱花影视', 'tiaozhanjia.js', 20],
    // 全能影视：/api.php 关了，但站内 /api/show/v2/* JSON 接口全开放，直连接口取数据
    ['pbstore',  '全能影视',   'pbstore.js',  20],
    // 丝粒影视：MacCMS 标准接口开放（/api.php/provide/vod/ 直出 JSON），直接消费 JSON，无需抓页、无 cookie
    ['silidm',   '丝粒影视',   'silidm.js',   20],
];

$sites = [];
foreach ($rows as $r) {
    $sites[] = [
        'key'         => $r[0],
        'name'        => $r[1],
        'type'        => 3,
        'api'         => './js/' . $r[2],
        'ext'         => ['api' => norm(isset($hosts[$r[0]]) ? $hosts[$r[0]] : $defaults[$r[0]])],
        'searchable'  => 1,
        'quickSearch' => 1,
        'changeable'  => 1,
        'timeout'     => $r[3],
    ];
}

echo json_encode([
    'name'   => '晚安影视',
    'notice' => '晚安影视，免费分享',
    'sites'  => $sites,
    'parses' => [],
    'flags'  => [],
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
