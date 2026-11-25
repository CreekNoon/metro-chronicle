/**
 * 构建：把 vendor 依赖与 src 分片合成一个可双击运行的单文件 HTML。
 * 用法：node build.mjs [输出路径]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'src');
const vendorDir = path.join(here, 'vendor');

const APP_PARTS = [
  '00-util.js',
  '05-metrics.js',
  '10-cities.js',
  '15-remote.js',
  '20-basemap.js',
  '30-geometry.js',
  '40-scene.js',
  '42-route-canvas.js',
  '45-camera.js',
  '50-story.js',
  '60-edit.js',
  '70-city.js',
  '72-search.js',
  '80-boot.js'
];

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(here, '地铁线网开通纪事.html');

/** 内联内容不允许出现 </script>，否则会提前结束脚本块 */
function guardInline(code, label) {
  const hits = code.match(/<\/script/gi);
  if (hits) {
    throw new Error(`${label} 中出现了 ${hits.length} 处 "</script"，会破坏内联脚本块`);
  }
  return code;
}

/** Leaflet 官方 CSS 里的图片引用改为 none：本页不使用默认图标与图层控件 */
function patchLeafletCss(css) {
  return css.replace(/url\(images\/[^)]+\)/g, 'none');
}

const [shell, leafletCssRaw, appCss] = await Promise.all([
  readFile(path.join(srcDir, 'shell.html'), 'utf8'),
  readFile(path.join(vendorDir, 'leaflet.css'), 'utf8'),
  readFile(path.join(srcDir, 'app.css'), 'utf8')
]);

const [leafletJs, gsapJs] = await Promise.all([
  readFile(path.join(vendorDir, 'leaflet.js'), 'utf8'),
  readFile(path.join(vendorDir, 'gsap.min.js'), 'utf8')
]);

const appJsParts = [];
for (const file of APP_PARTS) {
  const code = await readFile(path.join(srcDir, file), 'utf8');
  appJsParts.push(`/* ===== ${file} ===== */\n${code.trim()}\n`);
}

const appJs = [
  '/* 城市地铁线网开通纪事 —— 应用主程序（内联，无构建、无外部依赖） */',
  '(function () {',
  "'use strict';",
  '',
  appJsParts.join('\n'),
  '',
  '})();'
].join('\n');

const banner = [
  '<!--',
  '  城市地铁线网开通纪事 · 单文件离线版',
  '  内联依赖：Leaflet 1.9.4（BSD-2-Clause）、GSAP 3.12.5（GreenSock 标准授权）',
  '  底图：高德地图（需自备开发者 Key）/ OpenFreeMap Positron 矢量 / Esri World Light Gray 栅格',
  '  所有站点与线路均为虚构演示数据；坐标使用真实经纬度，内部统一以 WGS84 存储。',
  '-->'
].join('\n');

let html = shell;
const replacements = [
  ['/*__LEAFLET_CSS__*/', guardInline(patchLeafletCss(leafletCssRaw), 'leaflet.css')],
  ['/*__APP_CSS__*/', guardInline(appCss, 'app.css')],
  ['/*__LEAFLET_JS__*/', guardInline(leafletJs, 'leaflet.js')],
  ['/*__GSAP_JS__*/', guardInline(gsapJs, 'gsap.min.js')],
  ['/*__APP_JS__*/', guardInline(appJs, 'app.js')]
];

for (const [token, payload] of replacements) {
  if (!html.includes(token)) throw new Error(`模板缺少占位符 ${token}`);
  html = html.replace(token, () => payload);
}

html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + banner);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, 'utf8');

const bytes = Buffer.byteLength(html, 'utf8');
console.log(`OK  ${outputPath}`);
console.log(`    ${(bytes / 1024).toFixed(1)} KB · 应用脚本 ${APP_PARTS.length} 段 · 依赖已内联`);
