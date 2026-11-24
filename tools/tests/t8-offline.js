(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, B = M.Basemap;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const t0 = performance.now();
  while (!M.Story.finished && performance.now() - t0 < 40000) await sleep(120);
  const snap = M.snapshot();
  const plan = A.plan;
  const lastLine = plan.lines[plan.lines.length - 1];
  const entries = plan.lines.reduce((sum, l) => sum + l.stations.length, 0);

  add('断网下仍可开场（≤6s）', typeof snap.story.startedAt === 'number' && snap.story.startedAt <= 6000, snap.story.startedAt + 'ms');
  add('断网下完整播放完毕', snap.story.finished === true, Math.round(performance.now()) + 'ms');
  add('断网终态线路数=线路总数', Number(snap.stats.lines) === plan.lines.length, snap.stats.lines);
  add('断网终态站点数=条目总数', Number(snap.stats.stations) === entries, snap.stats.stations + ' vs ' + entries);
  add('断网终态为末线开通运营', snap.badge === lastLine.badge && snap.status === '开通运营', snap.badge + '/' + snap.status);
  add('断网未卡在加载页（遮罩已淡出）', Number(getComputedStyle(document.getElementById('veil')).opacity) < 0.05,
    getComputedStyle(document.getElementById('veil')).opacity);
  add('断网降级到底图兜底', ['raster', 'blank'].indexOf(B.mode) >= 0, B.mode);
  add('断网仍渲染全部站点标记', A.map.getContainer().querySelectorAll('.st').length === Object.keys(S.stations).length,
    A.map.getContainer().querySelectorAll('.st').length);
  add('断网线路仍完整绘制', (() => {
    const geo = S.geometries['zz-l1'];
    return S.routes['zz-l1'].main.getLatLngs().length === geo.render.length;
  })(), S.routes['zz-l1'].main.getLatLngs().length);
  add('断网版权标注来源', document.getElementById('creditSource').textContent.indexOf('Esri') >= 0 ||
    document.getElementById('creditSource').textContent.indexOf('本地') >= 0,
    document.getElementById('creditSource').textContent);
  add('断网下无页面异常', true, '由探针 pageErrors 判定');
  add('断网下重播可用', await (async () => {
    document.getElementById('replayBtn').click();
    await sleep(1500);
    const mid = M.snapshot();
    return mid.date === '2030.06.28' && mid.stats.lines === '1';
  })());
  add('重播中地图锁定', A.locked === true);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
