(async () => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 上一阶段（保存地图源）会触发自动重播，这里先等它跑完
  let waitStart = performance.now();
  while (!M.Story.finished && performance.now() - waitStart < 150000) await sleep(120);
  await sleep(700);
  const endBefore = M.snapshot();
  add('重播前为完成态', endBefore.story.finished === true, JSON.stringify(endBefore.story));

  document.getElementById('replayBtn').click();
  await sleep(1400);

  /* ---- 播放中途：应已完全复位到 1 号线场景 ---- */
  const mid = M.snapshot();
  add('重播后日期复位 2030.06.28', mid.date === '2030.06.28', mid.date);
  add('重播后顶栏为首条线路', mid.badge === A.plan.lines[0].badge && mid.lineName === A.plan.lines[0].name, mid.badge + '/' + mid.lineName);
  add('重播后区间为首条线路区间', mid.range.indexOf(A.plan.lines[0].stations[0].name) === 0, mid.range);
  add('重播后状态为首条线路状态', mid.status === A.plan.lines[0].status, mid.status);
  add('重播后面板从 0 开始累加', mid.stats.lines === '0' && mid.stats.stations === '0' && mid.stats.km === '0', JSON.stringify(mid.stats));
  add('重播后清水塘回到未开通/未揭示', ['hidden', 'ghost'].indexOf(mid.stationStates['zz-qingshuitang']) >= 0, mid.stationStates['zz-qingshuitang']);
  add('重播后无任何换乘态', Object.keys(mid.stationStates).every(k => mid.stationStates[k] !== 'transfer'),
    JSON.stringify(mid.stationStates));
  add('重播中地图仍锁定', A.locked === true);
  const veilOpacity = Number(getComputedStyle(document.getElementById('veil')).opacity);
  add('遮罩正在淡出(0~1)', veilOpacity >= 0 && veilOpacity <= 1, veilOpacity);

  /* ---- 先真实播放一段时间确认在推进，再跳到终态检查复位结果 ---- */
  await sleep(6000);
  const advancing = M.Story.playing === true && M.Story.finished === false;
  add('重播后时间轴在推进', advancing, JSON.stringify(M.snapshot().story));
  const t0 = performance.now();
  M.Story.skip();
  await sleep(800);
  const waited = Math.round(performance.now() - t0) + 7400;

  const end = M.snapshot();
  const plan = A.plan;
  const lastLine = plan.lines[plan.lines.length - 1];
  const entries = Object.keys(S.stations).length;
  add('重播可完整播放到结束', end.story.finished === true, '用时 ' + waited + 'ms');
  add('结束态日期为末线日期', end.date === lastLine.dateText, end.date);
  add('结束态线路数=线路总数', Number(end.stats.lines) === plan.lines.length, end.stats.lines);
  add('结束态站点数=去重站数', Number(end.stats.stations) === entries, end.stats.stations + ' vs ' + entries);
  add('结束态清水塘为换乘', end.stationStates['zz-qingshuitang'] === 'transfer', end.stationStates['zz-qingshuitang']);

  /* ---- 复位残留检查 ---- */
  const headOpacity = plan.lines.map((line) => Number(S.routes[line.key].head.options.opacity));
  add('头部标记无透明度残留', headOpacity.every(v => v === 0), JSON.stringify(headOpacity));
  const uniqueStations = entries;
  add('站点标记数量=去重站数（无重复图层）',
    A.map.getContainer().querySelectorAll('.st').length === uniqueStations,
    A.map.getContainer().querySelectorAll('.st').length + ' vs ' + uniqueStations);
  add('线路图层数量=线路数×3',
    A.map.getContainer().querySelectorAll('.route-layer').length === plan.lines.length * 3,
    A.map.getContainer().querySelectorAll('.route-layer').length);
  await sleep(700);
  const statsEl = document.getElementById('stats');
  add('数据面板无残留透明度', !statsEl.style.opacity || Number(statsEl.style.opacity) > 0.99, statsEl.style.opacity || 'auto');
  const dateEl = document.getElementById('dateText');
  add('日期无残留旋转', !dateEl.style.transform || dateEl.style.transform.indexOf('rotate') < 0 || /matrix\(1, 0, 0, 1/.test(dateEl.style.transform), dateEl.style.transform || 'none');

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
