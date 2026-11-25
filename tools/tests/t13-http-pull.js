(async () => {
  const M = window.__METRO__;
  const A = M.App;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('全新浏览器（无本地缓存）已连接后端', M.RemoteStore.enabled === true, M.RemoteStore.status);
  add('启动时从服务端拉取方案', A.plan.lines[0].stations[0].name === '服务端云龙', A.plan.lines[0].stations[0].name);
  add('服务端方案含 4 条线路与城际类型', A.plan.lines.length === 4 && A.plan.lines.some(l => l.type === 'intercity'),
    A.plan.lines.length + '/' + A.plan.lines.map(l => l.type).join(','));
  add('本地已写入服务端方案副本', !!window.localStorage.getItem('metroChronicle.v2.plan.' + A.cityId));
  add('顶栏使用服务端方案站名', M.snapshot().range.indexOf('服务端云龙') === 0, M.snapshot().range);
  add('自动开始播放', M.Story.playing === true || M.Story.finished === true, JSON.stringify(M.snapshot().story));

  const t0 = performance.now();
  while (!M.Story.finished && performance.now() - t0 < 150000) await sleep(120);
  add('播放可完整结束', M.Story.finished === true, Math.round(performance.now() - t0) + 'ms');

  /* 清除城市方案：同时清理服务端与本地 */
  M.RemoteStore.request('DELETE', '/plans?city=' + A.cityId, undefined, 3000).then((res) => {
    if (res) window.__DELETE_OK__ = true;
  });
  await sleep(900);
  add('服务端 DELETE 接口可用', window.__DELETE_OK__ === true, String(window.__DELETE_OK__));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
