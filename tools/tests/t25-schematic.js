(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('示意图引擎已启用', M.engineNow() === 'schematic', M.engineNow());
  const S = M.Schematic;
  add('存在布局结果', !!(S && S.layout), S && S.layout ? 'ok' : 'missing');
  if (!S || !S.layout) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  const L = S.layout;
  const plan = M.App.plan;

  /* ---------- A 布局：八方向、间距、换乘合点 ---------- */
  let offGrid = 0;
  let worstDeg = 0;
  L.edges.forEach((edge) => {
    const deg = (Math.atan2(edge.y2 - edge.y1, edge.x2 - edge.x1) * 180) / Math.PI;
    const rest = ((deg % 45) + 45) % 45;
    const delta = Math.min(rest, 45 - rest);
    if (delta > 1.5) offGrid += 1;
    worstDeg = Math.max(worstDeg, delta);
  });
  add('所有线段严格落在 8 个方向上（45° 整数倍）', offGrid === 0, offGrid + '/' + L.edges.length + ' 越界，最大偏差 ' + worstDeg.toFixed(2) + '°');

  const stationKeys = new Set();
  plan.lines.forEach((line) => line.stations.forEach((station) => stationKeys.add(station.key)));
  add('站点数与去重站点数一致', L.order.length === stationKeys.size, L.order.length + ' vs ' + stationKeys.size);

  let minDist = Infinity;
  for (let i = 0; i < L.order.length; i += 1) {
    for (let j = i + 1; j < L.order.length; j += 1) {
      const a = L.nodes[L.order[i]];
      const b = L.nodes[L.order[j]];
      minDist = Math.min(minDist, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  add('任意两站间距足够（不重叠）', minDist > 24, minDist.toFixed(1) + 'px');

  /* 换乘站在每条线上的落点应当非常接近（平移对齐结果） */
  let transferGap = 0;
  let transferCount = 0;
  L.order.forEach((key) => {
    const node = L.nodes[key];
    if (node.lineKeys.length < 2) return;
    transferCount += 1;
    const points = [];
    L.lines.forEach((entry) => {
      const index = entry.line.stations.findIndex((station) => station.key === key);
      if (index >= 0) points.push(entry.points[entry.stationIndices[index]]);
    });
    for (let i = 1; i < points.length; i += 1) {
      transferGap = Math.max(transferGap, Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y));
    }
  });
  add('换乘站在各线上完全重合（同一落点）', transferCount === 0 || transferGap < 2, transferCount + ' 个换乘站，最大偏差 ' + transferGap.toFixed(1) + 'px');

  /* ---------- B 渲染 ---------- */
  const stage = document.querySelector('#scMap .sc-stage');
  add('示意图容器与舞台已创建', !!stage);
  const paths = document.querySelectorAll('#scMap .sc-line path');
  add('每条线三层描边（光晕/白边/主线）', paths.length === plan.lines.length * 3, paths.length + ' 条 path');
  const nodeEls = document.querySelectorAll('#scMap .sc-nodes .st');
  add('站点节点数量正确', nodeEls.length === L.order.length, nodeEls.length + ' 个');
  const transferEls = Array.from(nodeEls).filter((el) => el.classList.contains('is-transfer'));
  add('换乘站使用多色圆环', transferEls.every((el) => {
    const style = el.getAttribute('style') || '';
    return style.indexOf('--ring-gradient') >= 0;
  }), transferEls.length + ' 个换乘站');
  const labelCount = document.querySelectorAll('#scMap .sc-nodes .st-name').length;
  add('站名标签全部渲染', labelCount === L.order.length, labelCount + ' 个');
  add('示意图尺寸已按视口适配（全景≈1 倍）', Math.abs(S.panoramaScale - 1) < 0.35, S.panoramaScale.toFixed(2));

  /* ---------- C 播放：站点按顺序点亮、线路逐步绘制 ---------- */
  const before = Object.keys(S.nodes).filter((key) => S.nodes[key].state !== 'hidden').length;
  await sleep(9000);
  const after = Object.keys(S.nodes).filter((key) => S.nodes[key].state !== 'hidden').length;
  add('播放中站点持续点亮', after >= before, before + ' → ' + after);
  add('播放中相机在缩放（特写/全景切换）', Math.abs(S.scale - S.panoramaScale) > 0.05 || S.phase === 'panorama',
    'scale=' + S.scale.toFixed(2) + ' phase=' + S.phase);

  /* ---------- D 编辑后自动重新派生 ---------- */
  const nodesBefore = S.layout.order.length;
  M.CityUI.switchCity('xiangtan');
  await sleep(1200);
  const nodesAfter = S.layout.order.length;
  const xiangtanKeys = new Set();
  M.App.plan.lines.forEach((line) => line.stations.forEach((station) => xiangtanKeys.add(station.key)));
  add('切换城市后示意图自动重新派生', nodesAfter === xiangtanKeys.size && nodesAfter !== nodesBefore,
    nodesBefore + ' → ' + nodesAfter);
  add('重新派生后仍是八方向布局', (() => {
    let bad = 0;
    S.layout.edges.forEach((edge) => {
      const deg = (Math.atan2(edge.y2 - edge.y1, edge.x2 - edge.x1) * 180) / Math.PI;
      const rest = ((deg % 45) + 45) % 45;
      if (Math.min(rest, 45 - rest) > 1.5) bad += 1;
    });
    return bad === 0;
  })(), S.layout.edges.length + ' 条边');

  /* 编辑保存后也应重新派生：直接改一条线路的日期再重建 */
  const beforeRebuild = S.layout.width;
  M.App.plan.lines[0].dateText = '2031.01.01';
  M.Schematic.rebuild();
  await sleep(300);
  add('手动 rebuild 可用（编辑保存路径同源）', typeof S.layout.width === 'number' && S.layout.order.length > 0,
    beforeRebuild.toFixed(0) + ' → ' + S.layout.width.toFixed(0));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
