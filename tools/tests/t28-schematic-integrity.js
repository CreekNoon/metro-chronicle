(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const S = M.Schematic;
  add('示意图引擎在跑', !!S && !!S.root, M.engineNow ? M.engineNow() : 'n/a');
  add('构建戳可读（便于确认版本）', typeof M.buildStamp === 'function' && M.buildStamp() !== 'unknown', M.buildStamp ? M.buildStamp() : 'n/a');
  if (!S || !S.root) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  /* ---------- A 直线性：站点之间是直线，没有折角/碎段/断线 ---------- */
  const measureStraightness = () => {
    let segments = 0;
    let extraPoints = 0;
    let tiny = 0;
    let minLen = Infinity;
    const data = (S.layout && S.layout.lines) || [];
    data.forEach((entry) => {
      extraPoints += Math.max(0, entry.points.length - entry.line.stations.length);
      for (let i = 1; i < entry.points.length; i += 1) {
        const len = Math.hypot(entry.points[i].x - entry.points[i - 1].x, entry.points[i].y - entry.points[i - 1].y);
        segments += 1;
        minLen = Math.min(minLen, len);
        if (len < 12) tiny += 1;
      }
    });
    return { segments, extraPoints, tiny, minLen };
  };

  const line0 = measureStraightness();
  add('渲染折线点数 = 站数（没有隐藏折角点）', line0.extraPoints === 0, line0.extraPoints + ' 个多余点');
  add('没有短于 12px 的碎段（不会出现断线/错位观感）', line0.tiny === 0, '最短 ' + line0.minLen.toFixed(1) + 'px');

  // 每个站点都必须落在它的线路上（距离 ≈ 0）
  let maxStationOffset = 0;
  (S.layout ? S.layout.lines : []).forEach((entry) => {
    entry.line.stations.forEach((station, index) => {
      const node = S.layout.nodes[station.key];
      const point = entry.points[entry.stationIndices[index]];
      maxStationOffset = Math.max(maxStationOffset, Math.hypot(node.x - point.x, node.y - point.y));
    });
  });
  add('每个站点都精确落在其线路折线上', maxStationOffset < 0.01, maxStationOffset.toFixed(3) + 'px');

  /* ---------- B 站点点亮规则：只能出现在"已开通线路"上 ---------- */
  const auditVisible = (label) => {
    const report = S.report();
    const bad = report.visible.filter((item) => !item.opened);
    return { label, count: report.visibleCount, bad, report };
  };

  /* 播放到中段，逐次审计 */
  const audits = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(3000);
    audits.push(auditVisible('t+' + (i + 1) * 3 + 's'));
  }
  const badTotal = audits.reduce((sum, item) => sum + item.bad.length, 0);
  add('不存在"孤立出现"的站点（每个可见站都属于已开通线路）', badTotal === 0,
    audits.map((a) => a.label + ':' + a.count + (a.bad.length ? '(bad:' + a.bad.map((b) => b.name).join(',') + ')' : '')).join(' '));

  /* ---------- C 切换城市后不能残留旧城市的站 ---------- */
  M.CityUI.switchCity('xiangtan');
  await sleep(5000);
  const sw = S.report();
  const planKeys = new Set();
  M.App.plan.lines.forEach((line) => line.stations.forEach((station) => planKeys.add(station.key)));
  const strayNames = sw.visible.filter((item) => !item.opened).map((item) => item.name);
  add('切换城市后布局换成新数据', sw.totalNodes === planKeys.size, sw.totalNodes + ' vs ' + planKeys.size);
  add('切换城市后时间轴重新开始（不复用旧事件）', S.running === true || S.phase !== 'done', S.phase + '/' + S.running);
  add('切换城市后没有残留错站', strayNames.length === 0, strayNames.join(',') || 'ok');
  const line1 = measureStraightness();
  add('切换城市后仍是直线、无碎段', line1.extraPoints === 0 && line1.tiny === 0, line1.segments + ' 段');

  /* ---------- D 取消线路选择后，示意图不再为它布局 ---------- */
  const beforeSel = S.report();
  M.LineSelection.toggle('xt-ic');
  if (M.LineUI && M.LineUI.applyChange) M.LineUI.applyChange();
  await sleep(2500);
  const afterSel = S.report();
  add('取消勾选后已选线路减少', afterSel.selectedLines.length === beforeSel.selectedLines.length - 1,
    beforeSel.selectedLines.join(',') + ' → ' + afterSel.selectedLines.join(','));
  add('取消勾选后线段数减少（不再为它留位置）', afterSel.segments < beforeSel.segments,
    beforeSel.segments + ' → ' + afterSel.segments);
  add('取消勾选后仍无隐藏折角/碎段', (afterSel.extraPoints || 0) === 0 && (afterSel.tinySegments || 0) === 0,
    'extra=' + (afterSel.extraPoints || 0) + ' tiny=' + (afterSel.tinySegments || 0));

  /* ---------- E report() 结构 ---------- */
  const rep = S.report();
  add('report() 含关键字段',
    typeof rep.city === 'string' && typeof rep.visibleCount === 'number' &&
    typeof rep.extraPoints === 'number' && !!rep.fidelity,
    JSON.stringify({ city: rep.city, visible: rep.visibleCount, extra: rep.extraPoints }));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
