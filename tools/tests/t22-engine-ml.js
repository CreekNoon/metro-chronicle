(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('URL 参数 ?engine=ml 生效', M.engineNow() === 'maplibre', M.engineNow());
  add('存在 MapLibre 实例', !!(M.MlPreview && M.MlPreview.map && M.MlPreview.map.getStyle));
  if (!M.MlPreview || !M.MlPreview.map) {
    return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
  }

  const P = M.MlPreview;
  const map = P.map;

  // 等地图样式与图层就绪（MapLibre 的 load 事件是异步的）
  const ready0 = performance.now();
  while (performance.now() - ready0 < 30000) {
    if (map.loaded() && map.getStyle().layers.length > 2 && Object.keys(P.geometries || {}).length > 0) break;
    await sleep(150);
  }
  const layers = map.getStyle().layers.map((l) => l.id);
  ['bg', 'base', 'line-glow', 'line-casing', 'line-main', 'line-main-ic', 'line-active', 'st-halo', 'st-dot', 'st-label']
    .forEach((id) => add('图层存在：' + id, layers.indexOf(id) >= 0, layers.join(',')));

  const stationKeys = Object.keys(P.stationIndex || {});
  add('站点要素数 = 去重站点数', P.snapshot().stations === stationKeys.length, P.snapshot().stations + ' 个');
  add('线路几何全部构建完成', Object.keys(P.geometries).length === M.App.plan.lines.length,
    Object.keys(P.geometries).length + ' 条');

  /* 播放推进 */
  const center0 = map.getCenter();
  const before = { phase: P.phase, revealed: P.snapshot().revealed, zoom: map.getZoom(), center: [center0.lat, center0.lng] };
  await sleep(9000);
  const center1 = map.getCenter();
  const after = { phase: P.phase, revealed: P.snapshot().revealed, zoom: map.getZoom(), center: [center1.lat, center1.lng] };
  add('播放时间轴在推进', P.running === true || P.phase !== 'idle', P.phase);
  // 若播放已经结束，就断言"全部点亮"；否则断言确实在推进
  const totalStations = P.snapshot().stations;
  if (P.phase === 'done' || after.revealed >= totalStations) {
    add('站点已全部点亮（播放完成）', after.revealed === totalStations, after.revealed + '/' + totalStations);
  } else {
    add('站点随绘制逐个点亮', after.revealed > before.revealed, before.revealed + ' → ' + after.revealed);
  }
  const moved = Math.abs(after.zoom - before.zoom) > 0.2 ||
    Math.abs(after.center[0] - before.center[0]) > 1e-4 ||
    Math.abs(after.center[1] - before.center[1]) > 1e-4 ||
    after.phase !== before.phase;
  add('镜头或阶段在推进', moved,
    'zoom ' + before.zoom.toFixed(2) + '→' + after.zoom.toFixed(2) + ' / phase ' + before.phase + '→' + after.phase);
  add('存在统一的全景/特写比例', P.panorama > 4 && P.focus > P.panorama,
    'panorama=' + P.panorama.toFixed(2) + ' focus=' + P.focus.toFixed(2));

  /* WebGL 真的渲染出了要素（读回像素在未开 preserveDrawingBuffer 时不可靠，
     改用 queryRenderedFeatures 验证"已进入渲染结果"） */
  const renderedStations = map.queryRenderedFeatures({ layers: ['st-dot'] });
  add('站点已渲染到画布上', renderedStations.length > 0, renderedStations.length + ' 个可见站点');
  const renderedLines = map.queryRenderedFeatures({ layers: ['line-glow', 'line-casing', 'line-main', 'line-main-ic', 'line-active'] });
  add('线路已渲染到画布上', renderedLines.length > 0, renderedLines.length + ' 段可见线');
  add('画布尺寸与容器一致',
    map.getCanvas().clientWidth === map.getContainer().clientWidth &&
    map.getCanvas().clientHeight === map.getContainer().clientHeight,
    map.getCanvas().clientWidth + 'x' + map.getCanvas().clientHeight);
  /* HUD 同步 */
  const dateText = (document.getElementById('dateText') || {}).textContent || '';
  const lineName = (document.getElementById('lineName') || {}).textContent || '';
  add('HUD 日期已更新', /\d{4}\.\d{2}\.\d{2}/.test(dateText), dateText);
  add('HUD 线路名已更新', lineName.length > 0, lineName);
  add('Leaflet 容器已隐藏（避免双引擎叠加）',
    document.getElementById('map').style.display === 'none',
    document.getElementById('map').style.display);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
