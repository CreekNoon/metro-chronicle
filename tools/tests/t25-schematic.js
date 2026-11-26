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
  // 不再强制 45°：改为校验「站点之间是直线、没有隐藏折角、没有碎段」
  let extraPoints = 0;
  let tinySegments = 0;
  let minSegLen = Infinity;
  L.lines.forEach((entry) => {
    extraPoints += Math.max(0, entry.points.length - entry.line.stations.length);
    for (let i = 1; i < entry.points.length; i += 1) {
      const len = Math.hypot(entry.points[i].x - entry.points[i - 1].x, entry.points[i].y - entry.points[i - 1].y);
      minSegLen = Math.min(minSegLen, len);
      if (len < 12) tinySegments += 1;
    }
  });
  add('站点之间直接连线（没有隐藏折角点）', extraPoints === 0, extraPoints + ' 个多余折点');
  add('没有碎段（每段 ≥ 12px）', tinySegments === 0, '最短 ' + minSegLen.toFixed(1) + 'px');

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
  // 换乘配色是"渐进"的：只有已开通线路 ≥2 条时才用多色环（详见 t29）
  const nodeAtStart = Array.from(nodeEls);
  const wronglyTransfer = nodeAtStart.filter((el) => {
    const key = el.getAttribute('data-station-key');
    const entry = S.nodes[key];
    const opened = entry ? S.openedColorsFor(entry.node).length : 0;
    return opened < 2 && el.classList.contains('is-transfer');
  });
  add('未开通第二条线时不使用换乘双色样式', wronglyTransfer.length === 0,
    wronglyTransfer.length + ' 个误标');
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

  /* ---------- B2 字号 & 标签不重叠 ---------- */
  const labelInner = document.querySelector('#scMap .sc-nodes .st-label-inner');
  const labelFont = labelInner ? parseFloat(getComputedStyle(labelInner).fontSize) : 0;
  add('站名字号放大（≥15px）', labelFont >= 15, labelFont + 'px');

  const labelBoxes = Array.prototype.map.call(
    document.querySelectorAll('#scMap .sc-nodes .st-label'),
    (el) => {
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    }
  );
  let labelOverlaps = 0;
  for (let i = 0; i < labelBoxes.length; i += 1) {
    for (let j = i + 1; j < labelBoxes.length; j += 1) {
      const a = labelBoxes[i];
      const b = labelBoxes[j];
      const hit = !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
      if (hit) labelOverlaps += 1;
    }
  }
  add('站名标签互不重叠', labelOverlaps === 0, labelOverlaps + ' 组重叠 / ' + labelBoxes.length + ' 个标签');

  /* ---------- B3 走向保真度（照着真实线路走向生成） ---------- */
  const fidelity = L.fidelity || (S.fidelity || null);
  add('记录走向保真度指标', !!fidelity, JSON.stringify(fidelity));
  if (fidelity) {
    add('站对相对方位与真实地理一致率 ≥ 90%', fidelity.quadrants >= 0.9,
      (fidelity.quadrants * 100).toFixed(1) + '% / ' + fidelity.pairs + ' 对');
    add('每条线整体走向平均偏差 ≤ 8°', fidelity.bearingMeanDeg <= 8, fidelity.bearingMeanDeg + '°');
  }

  /* ---------- B4 顶栏「示意图」按钮（运行中切换） ---------- */
  const btn = document.getElementById('schematicBtn');
  add('顶栏存在示意图按钮', !!btn, btn ? btn.textContent : 'missing');
  if (btn) {
    add('进入示意图后按钮文案为「返回地图」', btn.textContent === '返回地图', btn.textContent);
    btn.click();
    await sleep(900);
    add('点击后可返回地图视图',
      M.engineNow() === 'leaflet' && document.getElementById('scMap').style.display === 'none',
      M.engineNow() + ' / scMap=' + document.getElementById('scMap').style.display);
    btn.click();
    await sleep(1400);
    add('再次点击可回到示意图',
      M.engineNow() === 'schematic' && !!M.Schematic.root && M.Schematic.layout.order.length > 0,
      M.engineNow() + ' / nodes=' + (M.Schematic.layout ? M.Schematic.layout.order.length : 0));
    add('按钮文案随状态切换', btn.textContent === '返回地图', btn.textContent);
  }

  /* ---------- D 编辑后自动重新派生 ---------- */
  const nodesBefore = S.layout.order.length;
  M.CityUI.switchCity('xiangtan');
  await sleep(1200);
  const nodesAfter = S.layout.order.length;
  const xiangtanKeys = new Set();
  M.App.plan.lines.forEach((line) => line.stations.forEach((station) => xiangtanKeys.add(station.key)));
  add('切换城市后示意图自动重新派生', nodesAfter === xiangtanKeys.size && nodesAfter !== nodesBefore,
    nodesBefore + ' → ' + nodesAfter);
  add('重新派生后仍是直线、无碎段', (() => {
    let extra = 0;
    let tiny = 0;
    S.layout.lines.forEach((entry) => {
      extra += Math.max(0, entry.points.length - entry.line.stations.length);
      for (let i = 1; i < entry.points.length; i += 1) {
        const len = Math.hypot(entry.points[i].x - entry.points[i - 1].x, entry.points[i].y - entry.points[i - 1].y);
        if (len < 12) tiny += 1;
      }
    });
    return extra === 0 && tiny === 0;
  })(), S.layout.lines.length + ' 条线');

  /* 编辑保存后也应重新派生：直接改一条线路的日期再重建 */
  const beforeRebuild = S.layout.width;
  M.App.plan.lines[0].dateText = '2031.01.01';
  M.Schematic.rebuild();
  await sleep(300);
  add('手动 rebuild 可用（编辑保存路径同源）', typeof S.layout.width === 'number' && S.layout.order.length > 0,
    beforeRebuild.toFixed(0) + ' → ' + S.layout.width.toFixed(0));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
