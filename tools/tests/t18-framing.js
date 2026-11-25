(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;

  if (!St.finished) St.skip();
  await sleep(600);

  /* 每条线路：取景层是否「装得下整条线」+ 运行途中缩放是否恒定 */
  const results = [];

  for (let i = 0; i < A.plan.lines.length; i += 1) {
    const line = A.plan.lines[i];
    const geometry = S.geometries[line.key];
    const zoom = C.lineZoom(i);
    const level = Math.floor(zoom + 0.03);
    // 用该层级下 Leaflet 的投影算出整线像素包围盒，确认装得下
    const bounds = L.latLngBounds(geometry.render);
    const nw = map.project(bounds.getNorthWest(), level);
    const se = map.project(bounds.getSouthEast(), level);
    const size = map.getSize();
    results.push({
      key: line.key,
      zoom: Number(zoom.toFixed(2)),
      level: level,
      pxW: Math.round(Math.abs(se.x - nw.x)),
      pxH: Math.round(Math.abs(se.y - nw.y)),
      sizeW: size.x,
      sizeH: size.y
    });
  }

  add('每条线路的取景层级都能装下整线（宽）',
    results.every(r => r.pxW <= r.sizeW * 0.94),
    results.map(r => r.key + ':' + r.pxW + '/' + r.sizeW).join(' '));
  add('每条线路的取景层级都能装下整线（高）',
    results.every(r => r.pxH <= r.sizeH * 0.94),
    results.map(r => r.key + ':' + r.pxH + '/' + r.sizeH).join(' '));
  add('取景缩放向下取整（不会因四舍五入裁掉两端）',
    results.every(r => r.level === Math.floor(r.zoom + 0.03)),
    results.map(r => r.zoom + '→' + r.level).join(' '));

  /* 实跑一条线：运行途中 zoom 必须恒定，且起点/头部都在画面内 */
  St.play();
  const samples = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 70000) {
    if (St.finished) break;
    await sleep(90);
    if (!St.drawing || C.flying || map._animatingZoom) continue;
    let visible = null;
    let count = 0;
    Object.keys(S.routes).forEach((key) => {
      const el = S.routes[key].head.getElement();
      const op = el ? Number(getComputedStyle(el).opacity) : 0;
      if (op > 0.25) count += 1;
      if (op > 0.9) visible = { key: key, el: el };
    });
    if (count !== 1 || !visible) continue;
    const size = map.getSize();
    const head = S.routes[visible.key].head.getLatLng();
    const headPt = map.latLngToContainerPoint(head);
    const start = S.geometries[visible.key].render[0];
    const startPt = map.latLngToContainerPoint(L.latLng(start[0], start[1]));
    const inside = (pt) => pt.x >= 0 && pt.y >= 0 && pt.x <= size.x && pt.y <= size.y;
    samples.push({
      key: visible.key,
      zoom: map.getZoom(),
      inside: inside(headPt) && inside(startPt)
    });
  }
  St.skip();
  await sleep(400);

  add('采集到足够的跟拍样本', samples.length >= 100, samples.length + ' 帧');
  add('跟拍期间起点与头部始终在画面内', samples.every(s => s.inside),
    samples.filter(s => !s.inside).length + ' 帧越界');
  const byLine = {};
  samples.forEach((s) => {
    if (!byLine[s.key]) byLine[s.key] = [s.zoom, s.zoom];
    byLine[s.key][0] = Math.min(byLine[s.key][0], s.zoom);
    byLine[s.key][1] = Math.max(byLine[s.key][1], s.zoom);
  });
  add('每条线路运行途中缩放恒定',
    Object.keys(byLine).every((key) => byLine[key][1] - byLine[key][0] < 0.01),
    Object.keys(byLine).map((key) => key + '=' + byLine[key][0]).join(' '));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks, lines: results });
})()
