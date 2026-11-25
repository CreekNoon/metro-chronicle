(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const C = M.TileCache;

  /* 刷新后：同样的瓦片应当直接命中本地缓存，而不是重新下载 */
  const t0 = performance.now();
  await sleep(3500);
  const s = C.summary();
  const firstTiles = document.querySelectorAll('.leaflet-tile-loaded').length;

  add('刷新后仍然可用缓存后端', s.backend === 'indexeddb', s.backend);
  add('刷新后有命中本地缓存的瓦片', s.hit >= 10, 'hit=' + s.hit + ' miss=' + s.miss);
  add('重复访问的瓦片走缓存（命中占比 ≥ 20%）', s.hit / Math.max(1, s.hit + s.miss) >= 0.2,
    'hit=' + s.hit + ' miss=' + s.miss);
  add('刷新后首屏瓦片很快就位', firstTiles > 10, firstTiles + ' 张 / ' + Math.round(performance.now() - t0) + 'ms 采样窗口');
  add('底图确实渲染出来了（瓦片元素存在）',
    document.querySelectorAll('.leaflet-tile').length > 10,
    document.querySelectorAll('.leaflet-tile').length + ' 个瓦片元素');
  add('没有因为缓存导致底图空白（BaseMap 模式正常）',
    M.Basemap.mode === 'amap' || M.Basemap.mode === 'raster' || M.Basemap.mode === 'vector',
    M.Basemap.mode);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks, phase: 'after', stats: s });
})()
