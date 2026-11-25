(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;

  if (!St.finished) St.skip();
  await sleep(600);

  const panorama = C.panoramaZoom;
  const focus = C.focusZoom;

  /* ---- A 比例约定：全景 / 特写 ---- */
  add('存在统一的全景比例', Number.isFinite(panorama) && panorama > 4, panorama.toFixed(2));
  add('特写比例 A 高于全景比例', focus > panorama, focus.toFixed(2) + ' > ' + panorama.toFixed(2));
  add('所有线路共用同一特写比例 A',
    A.plan.lines.every((_, i) => Math.abs(C.lineZoom(i) - focus) < 1e-9),
    A.plan.lines.map((_, i) => C.lineZoom(i).toFixed(2)).join('/'));

  /* ---- B 全景比例必须装得下整张线网 ---- */
  const allPoints = Object.keys(S.geometries).reduce((acc, key) => acc.concat(S.geometries[key].render), []);
  const bounds = L.latLngBounds(allPoints);
  const level = Math.floor(panorama + 0.03);
  const nw = map.project(bounds.getNorthWest(), level);
  const se = map.project(bounds.getSouthEast(), level);
  const size = map.getSize();
  add('全景层级能装下整张线网（宽）', Math.abs(se.x - nw.x) <= size.x * 0.98, Math.round(Math.abs(se.x - nw.x)) + '/' + size.x);
  add('全景层级能装下整张线网（高）', Math.abs(se.y - nw.y) <= size.y * 0.98, Math.round(Math.abs(se.y - nw.y)) + '/' + size.y);

  /* ---- C 实跑：每条线都在 A 上绘制，画完回到全景 ---- */
  let zoomStarts = 0;
  map.on('zoomstart', function () { zoomStarts += 1; });
  St.play();
  const drawZooms = {};
  const panoramaReturns = [];
  let lastWasDrawing = false;
  let headsInside = 0;
  let headSamples = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 150000) {
    if (St.finished) break;
    await sleep(100);
    const zoom = map.getZoom();
    if (St.drawing) {
      let key = null;
      let count = 0;
      Object.keys(S.routes).forEach((k) => {
        if (S.routes[k].active && S.routes[k].headPoint) { count += 1; key = k; }
      });
      if (count === 1 && key && !map._animatingZoom) {
        drawZooms[key] = drawZooms[key] || [zoom, zoom];
        drawZooms[key][0] = Math.min(drawZooms[key][0], zoom);
        drawZooms[key][1] = Math.max(drawZooms[key][1], zoom);
        const hp = S.routes[key].headPoint;
        const pt = map.latLngToContainerPoint(L.latLng(hp[0], hp[1]));
        headSamples += 1;
        if (pt.x >= 0 && pt.y >= 0 && pt.x <= size.x && pt.y <= size.y) headsInside += 1;
      }
      lastWasDrawing = true;
    } else if (lastWasDrawing && !C.flying) {
      lastWasDrawing = false;
      panoramaReturns.push(Number(zoom.toFixed(2)));
    }
  }
  St.skip();
  await sleep(500);

  const keys = Object.keys(drawZooms);
  add('缩放切换一次到位（缩放动画次数≈事件切换次数，无逐级顿挫）', zoomStarts <= 12, zoomStarts + ' 次动画 / ' + A.plan.lines.length + ' 条线路');
  add('每条线路都在特写比例上绘制', keys.length >= 3 && keys.every((k) => Math.abs(drawZooms[k][0] - drawZooms[k][1]) < 0.01),
    keys.map((k) => k + '=' + drawZooms[k][0]).join(' '));
  add('各线路使用的比例完全相同', keys.every((k) => Math.abs(drawZooms[k][0] - drawZooms[keys[0]][0]) < 0.01),
    keys.map((k) => drawZooms[k][0]).join('/'));
  add('绘制期间头部始终在画面内', headSamples > 0 && headsInside === headSamples,
    headsInside + '/' + headSamples);
  // 每一条线都配置了「回到全景」的目标，且该目标恰好等于全景比例
  add('每条线都有回到全景的目标且等于全景比例',
    A.plan.lines.every((_, i) => {
      const target = C.linePanoramaTarget(i);
      return !!target && Math.abs(target.zoom - C.panoramaZoom) < 1e-9;
    }),
    A.plan.lines.map((_, i) => C.linePanoramaTarget(i).zoom.toFixed(2)).join('/'));


  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
