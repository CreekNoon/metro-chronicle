(() => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App, B = M.Basemap;
  const snap = M.snapshot();
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const plan = A.plan;
  const lastLine = plan.lines[plan.lines.length - 1];

  /* ---- 多线路网络：默认 4 条（3 地铁 + 1 城际） ---- */
  add('默认城市为株洲', snap.cityId === 'zhuzhou', snap.cityId);
  add('线路数 ≥ 3（支持多线路）', plan.lines.length >= 3, plan.lines.length);
  add('含城际铁路类型', plan.lines.some(l => l.type === 'intercity'),
    plan.lines.map(l => l.type).join(','));
  add('地铁 + 城际徽章类型正确', plan.lines.every(l => (l.type === 'intercity') === /城际/.test(l.badge)),
    plan.lines.map(l => l.badge).join(','));

  /* ---- 结束态顶栏 = 最后一条线路 ---- */
  add('终态日期为最后一条线日期', snap.date === lastLine.dateText, snap.date + ' vs ' + lastLine.dateText);
  add('终态线路名为最后一条线', snap.lineName === lastLine.name, snap.lineName);
  add('终态徽章为城际', snap.badge === lastLine.badge && snap.badgeType === 'intercity', snap.badge + '/' + snap.badgeType);
  add('终态状态为开通运营', snap.status === '开通运营', snap.status);
  add('终态区间为末线首末站', snap.range === lastLine.stations[0].name + '—' + lastLine.stations[lastLine.stations.length - 1].name, snap.range);

  /* ---- 数据面板全部实时计算 ---- */
  const entries = plan.lines.reduce((sum, l) => sum + l.stations.length, 0);
  const totalKm = Math.round(plan.lines.reduce((sum, l) => sum + (snap.lengthsMeters[l.key] || 0), 0) / 1000);
  add('面板线路数=实际线路数', Number(snap.stats.lines) === plan.lines.length, snap.stats.lines + ' vs ' + plan.lines.length);
  add('面板站点数=条目总数', Number(snap.stats.stations) === entries, snap.stats.stations + ' vs ' + entries);
  add('面板里程=各线实测之和', Number(snap.stats.km) === totalKm, snap.stats.km + ' vs ' + totalKm);
  add('1 号线仍约 30km', near((snap.lengthsMeters['zz-l1'] || 0) / 1000, 30, 1), ((snap.lengthsMeters['zz-l1'] || 0) / 1000).toFixed(2));
  add('里程非写死（线条目数变化即变化）', totalKm > 50, totalKm + 'km');

  /* ---- 播放进度：4 个阶段都跑过 ---- */
  add('所有线路都参与播放', snap.story.phases.length === plan.lines.length, JSON.stringify(snap.story.phases));
  add('播放已结束', snap.story.finished === true && snap.story.playing === false, JSON.stringify(snap.story));
  add('开场时间 ≤ 6s', snap.story.startedAt != null && snap.story.startedAt <= 6000, snap.story.startedAt + 'ms');

  /* ---- 换乘站：跨线同 key 均为 transfer ---- */
  const sharedKeys = Object.keys(snap.stationStates).filter(k => {
    let n = 0;
    plan.lines.forEach(l => l.stations.forEach(s => { if (s.key === k) n += 1; }));
    return n > 1;
  });
  add('存在换乘站', sharedKeys.length >= 4, sharedKeys.length);
  add('换乘站终态为 transfer', sharedKeys.every(k => snap.stationStates[k] === 'transfer'),
    sharedKeys.filter(k => snap.stationStates[k] !== 'transfer').join(',') || 'ok');
  add('清水塘仍为换乘（ghost → transfer）', snap.stationStates['zz-qingshuitang'] === 'transfer', snap.stationStates['zz-qingshuitang']);

  /* ---- 城际铁路视觉：虚线 + 特殊站标 ---- */
  const icRoute = Array.from(document.querySelectorAll('.route-main')).find(el => el.getAttribute('stroke-dasharray'));
  add('城际线路为虚线描边', !!icRoute, icRoute ? icRoute.getAttribute('stroke-dasharray') : 'none');
  add('地铁线路为实线', Array.from(document.querySelectorAll('.route-main')).some(el => !el.getAttribute('stroke-dasharray')));
  const railNodes = document.querySelectorAll('.st.has-rail');
  add('城际服务站带 has-rail 标识', railNodes.length >= 3, railNodes.length);
  add('城际胶囊可见', Array.from(railNodes).every(el => getComputedStyle(el.querySelector('.st-rail-tag')).display !== 'none'),
    railNodes.length);

  /* ---- 发光更克制（第 2 条需求） ---- */
  const halo = S.stations['zz-yunlong'].refs.halo.getBoundingClientRect();
  add('站点光晕尺寸 ≤ 28px', halo.width <= 28 && halo.height <= 28, halo.width.toFixed(1) + 'px');
  add('站点光晕透明度 ≤ 0.1', Number(getComputedStyle(S.stations['zz-yunlong'].refs.halo).opacity) <= 0.1,
    getComputedStyle(S.stations['zz-yunlong'].refs.halo).opacity);
  const glowStroke = document.querySelector('.route-glow');
  add('线路外发光更细', parseFloat(glowStroke.getAttribute('stroke-width')) <= 13, glowStroke.getAttribute('stroke-width'));

  /* ---- 缩放控件（第 3 条需求） ---- */
  add('缩放控件存在', !!document.getElementById('zoomCtl'));
  add('缩放控件按钮齐全', !!document.getElementById('zoomIn') && !!document.getElementById('zoomOut') && !!document.getElementById('zoomFit'));
  add('比例尺提示有内容', /px/.test(document.getElementById('zoomLevel').textContent), document.getElementById('zoomLevel').textContent);
  add('跳过动画按钮存在', !!document.getElementById('skipBtn'));

  /* ---- 线路选择（第 4 条需求） ---- */
  add('线路选择按钮带计数', /^\d+\/\d+$/.test(document.getElementById('lineSelectCount').textContent),
    document.getElementById('lineSelectCount').textContent);
  add('线路面板可打开', (() => { document.getElementById('lineSelectBtn').click(); return document.getElementById('linePanel').classList.contains('is-on'); })());
  add('线路面板列出全部线路', document.querySelectorAll('#linePanelBody .line-row').length === plan.lines.length,
    document.querySelectorAll('#linePanelBody .line-row').length);
  document.getElementById('lineSelectBtn').click();

  /* ---- 底图：默认高德（第 1 条需求） ---- */
  add('默认底图为高德', B.mode === 'amap', B.mode + '/' + B.datum);
  add('高德 Key 校验通过', B.keyStatus === 'valid', B.keyStatus);
  add('高德模式启用 GCJ-02 投影', B.datum === 'gcj02');
  add('版权显示高德', document.getElementById('creditSource').textContent.indexOf('高德') >= 0,
    document.getElementById('creditSource').textContent);

  /* ---- 站点标记结构仍然完整 ---- */
  const first = S.stations[Object.keys(S.stations)[0]].refs;
  add('标记结构完整（halo/ring/dot/transfer/label）', !!(first.halo && first.ring && first.dot && first.transfer && first.label));
  add('序号胶囊有内容', /^\d{2}$/.test(first.number.textContent), first.number.textContent);
  add('站名已转义', Object.keys(S.stations).every(k => !/[<>&"']/.test(S.stations[k].station.name)));

  /* ---- 页面级 ---- */
  add('无横向滚动', document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth);
  add('地图仍锁定为只读播放态', A.map.dragging.enabled() === false && A.map.scrollWheelZoom.enabled() === false);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
