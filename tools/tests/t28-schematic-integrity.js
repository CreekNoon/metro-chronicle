(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const S = M.Schematic;
  add('示意图引擎在跑', !!S && !!S.root, M.engineNow ? M.engineNow() : 'n/a');
  add('构建戳可读（便于确认版本）', typeof M.buildStamp === 'function' && M.buildStamp() !== 'unknown', M.buildStamp ? M.buildStamp() : 'n/a');
  if (!S || !S.root) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  /* ---------- A 角度：所有渲染线段严格 45°/90° ---------- */
  const measureAngles = () => {
    const offenders = [];
    let total = 0;
    Array.from(document.querySelectorAll('#scMap .sc-line .sc-main')).forEach((path) => {
      const d = path.getAttribute('d') || '';
      const nums = (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
      const pts = [];
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      for (let k = 1; k < pts.length; k += 1) {
        total += 1;
        const deg = (Math.atan2(pts[k].y - pts[k - 1].y, pts[k].x - pts[k - 1].x) * 180) / Math.PI;
        const rest = ((deg % 45) + 45) % 45;
        const dev = Math.min(rest, 45 - rest);
        if (dev > 0.6) offenders.push(Number(dev.toFixed(1)));
      }
    });
    return { total, offenders };
  };

  const angles0 = measureAngles();
  add('渲染出的每条线段都落在 45° 整数倍上', angles0.offenders.length === 0,
    angles0.total + ' 段，越界 ' + angles0.offenders.length + (angles0.offenders.length ? ' → ' + angles0.offenders.join(',') : ''));

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
  const angles1 = measureAngles();
  add('切换城市后角度仍然严格', angles1.offenders.length === 0, angles1.total + ' 段');

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
  add('取消勾选后角度仍然严格', afterSel.maxAngleDeviationDeg <= 0.6, afterSel.maxAngleDeviationDeg + '°');

  /* ---------- E report() 结构 ---------- */
  const rep = S.report();
  add('report() 含关键字段',
    typeof rep.city === 'string' && typeof rep.visibleCount === 'number' &&
    typeof rep.maxAngleDeviationDeg === 'number' && !!rep.fidelity,
    JSON.stringify({ city: rep.city, visible: rep.visibleCount, maxDev: rep.maxAngleDeviationDeg }));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
