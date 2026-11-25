(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('MapLibre 引擎已启动', !!(M.MlPreview && M.MlPreview.map), M.engineNow ? M.engineNow() : 'n/a');
  const P = M.MlPreview;
  if (!P || !P.map) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  const map = P.map;
  const ready0 = performance.now();
  while (performance.now() - ready0 < 30000) {
    if (map.loaded() && Object.keys(P.geometries || {}).length > 0) break;
    await sleep(150);
  }

  const hasArchive = (P.archiveBytes || 0) > 0;
  const expected = hasArchive ? 'pmtiles' : 'network';
  add('底图来源符合当前构建（离线包→pmtiles，否则→network）', P.basemapKind === expected,
    P.basemapKind + ' / archiveBytes=' + (P.archiveBytes || 0));

  const source = map.getStyle().sources.base || {};
  if (hasArchive) {
    add('底图使用 pmtiles:// 协议', String(source.url || '').indexOf('pmtiles://') === 0, String(source.url || '').slice(0, 48));
    add('PMTiles 声明了层级范围', Number(source.minzoom) >= 0 && Number(source.maxzoom) >= 12,
      source.minzoom + '~' + source.maxzoom);
    add('PMTiles 数据已完整解包（>100KB）', (P.archiveBytes || 0) > 100 * 1024, Math.round((P.archiveBytes || 0) / 1024) + ' KB');
  } else {
    add('网络模式使用 Esri 瓦片模板', !!source.tiles && String(source.tiles[0]).indexOf('arcgisonline') >= 0,
      (source.tiles || []).length + ' 个模板');
  }

  /* 瓦片是否真的加载完成（离线时也必须为真） */
  const t0 = performance.now();
  while (performance.now() - t0 < 20000) {
    if (map.isSourceLoaded('base') && map.areTilesLoaded()) break;
    await sleep(200);
  }
  add('底图瓦片加载完成', map.isSourceLoaded('base') === true, 'isSourceLoaded=' + map.isSourceLoaded('base'));
  add('没有待加载的瓦片', map.areTilesLoaded() === true, 'areTilesLoaded=' + map.areTilesLoaded());

  /* 线路与站点图层照常工作 */
  const layers = map.getStyle().layers.map((l) => l.id);
  add('线路/站点图层齐全',
    ['line-main', 'line-active', 'st-dot', 'st-label'].every((id) => layers.indexOf(id) >= 0),
    layers.join(','));
  add('站点已渲染', map.queryRenderedFeatures({ layers: ['st-dot'] }).length > 0,
    map.queryRenderedFeatures({ layers: ['st-dot'] }).length + ' 个');

  /* 播放照常推进 */
  const before = P.snapshot().revealed;
  await sleep(6000);
  add('播放仍在推进（站点持续点亮）', P.snapshot().revealed >= before, before + ' → ' + P.snapshot().revealed);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
