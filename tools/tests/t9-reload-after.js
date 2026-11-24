(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* 第二段：页面已重新加载，验证方案从 localStorage 恢复并自动播放 */
  const first = A.plan.lines[0].stations[0];
  add('刷新后读取到已保存方案', first.name === '持久化云龙', first.name);
  add('刷新后 ghost 状态仍在', A.plan.lines[0].stations[3].ghost === true, A.plan.lines[0].stations[3].ghost);
  add('刷新后城市仍为株洲', A.cityId === 'zhuzhou', A.cityId);
  add('刷新后线路数与类型完整', A.plan.lines.length === 4 && A.plan.lines.some(l => l.type === 'intercity'),
    A.plan.lines.length + '/' + A.plan.lines.map(l => l.type).join(','));
  add('刷新后线路头使用保存的站名', M.snapshot().range.indexOf('持久化云龙') === 0, M.snapshot().range);
  add('刷新后自动播放', M.Story.playing === true || M.Story.finished === true, JSON.stringify(M.snapshot().story));
  add('刷新后仍为本地存储模式（file://）', M.RemoteStore.enabled === false && M.snapshot().storage === 'local',
    M.snapshot().storage);

  const t0 = performance.now();
  while (!M.Story.finished && performance.now() - t0 < 40000) await sleep(120);
  const snap = M.snapshot();
  const entries = A.plan.lines.reduce((sum, l) => sum + l.stations.length, 0);
  add('刷新后完整播放', snap.story.finished === true, Math.round(performance.now() - t0) + 'ms');
  add('刷新后站点数=条目总数', Number(snap.stats.stations) === entries, snap.stats.stations + ' vs ' + entries);
  const ghostStation = A.plan.lines[0].stations[3];
  add('刷新后 ghost 数据仍在（换乘态按规则覆盖为 transfer）',
    ghostStation.ghost === true && ['ghost', 'transfer'].indexOf(snap.stationStates[ghostStation.key]) >= 0,
    ghostStation.ghost + '/' + snap.stationStates[ghostStation.key]);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
