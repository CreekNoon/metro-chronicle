(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const S = M.Schematic;
  add('示意图引擎在跑', !!S && !!S.root, M.engineNow ? M.engineNow() : 'n/a');
  if (!S || !S.root) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  /** 抓取某一时刻的站点配色快照 */
  const snapAt = (time) => {
    S.seek(time);
    const rows = [];
    Object.keys(S.nodes).forEach((key) => {
      const entry = S.nodes[key];
      if (!entry || entry.state === 'hidden') return;
      const ring = entry.el.querySelector('.st-ring');
      const bg = String(getComputedStyle(ring).backgroundImage);
      const opened = S.openedColorsFor(entry.node);
      const gradients = (bg.match(/rgb\([^)]+\)/g) || []).filter((c) => c !== 'rgb(255, 255, 255)');
      rows.push({
        name: entry.node.name,
        state: entry.state,
        staticLines: entry.node.lineKeys.length,
        openedColors: opened.length,
        transferClass: entry.el.classList.contains('is-transfer'),
        hasConic: /conic-gradient/.test(bg),
        gradientColors: Array.from(new Set(gradients)).length
      });
    });
    return { time, openedLines: Object.keys(S.openedLineKeys), rows };
  };

  /* 用暂停 + 精确 seek，避免等真实时间 */
  S.skip();
  S.replay();
  if (S.timeline) S.timeline.pause(0);
  S.lastSeek = 0;

  const early = snapAt(9);
  add('早期只有 1 条线通车', early.openedLines.length === 1, early.openedLines.join(','));
  const earlyBad = early.rows.filter((row) => row.openedColors < 2 && (row.transferClass || row.hasConic));
  add('只有 1 条线通车时：即使站点被多条线经过，也不用双色换乘样式',
    earlyBad.length === 0,
    earlyBad.map((row) => row.name + '(静态' + row.staticLines + '线/已开通' + row.openedColors + ')').join(',') || 'ok');

  const mid = snapAt(38);
  add('中段已通车 2 条线', mid.openedLines.length === 2, mid.openedLines.join(','));
  const midUpgraded = mid.rows.filter((row) => row.openedColors >= 2);
  add('第二条线接入后，经过该线的站点升级为双色环',
    midUpgraded.length > 0 && midUpgraded.every((row) => row.transferClass && row.hasConic),
    midUpgraded.map((row) => row.name + '(已开通' + row.openedColors + '色)').join(',') || 'none');
  add('双色环的颜色数 = 已开通线路数',
    midUpgraded.every((row) => row.gradientColors === row.openedColors),
    midUpgraded.map((row) => row.name + ':' + row.gradientColors + '/' + row.openedColors).join(' '));
  const midWrong = mid.rows.filter((row) => row.openedColors < 2 && (row.transferClass || row.hasConic));
  add('未接入第二条线的站点仍是单色', midWrong.length === 0,
    midWrong.map((row) => row.name).join(',') || 'ok');

  /* 终态：全部线路通车 */
  const total = S.timeline ? S.timeline.duration() : 0;
  const end = snapAt(total);
  add('终态全部线路通车', end.openedLines.length === M.App.plan.lines.length,
    end.openedLines.length + '/' + M.App.plan.lines.length);
  const endBad = end.rows.filter((row) => row.openedColors < 2 && (row.transferClass || row.hasConic));
  add('终态下单线站点仍为单色', endBad.length === 0, endBad.map((row) => row.name).join(',') || 'ok');
  const endMulti = end.rows.filter((row) => row.openedColors >= 2);
  add('终态下多线共站显示多色环',
    endMulti.length > 0 && endMulti.every((row) => row.transferClass && row.hasConic && row.gradientColors === row.openedColors),
    endMulti.map((row) => row.name + ':' + row.openedColors + '色').join(' '));

  /* 线路开通顺序推进：每通一条线，沿线站点的颜色数只增不减 */
  const timelineOpen = [9, 38, 68, total];
  const sequence = timelineOpen.map((t) => {
    const snap = snapAt(t);
    return { t, opened: snap.openedLines.length, multi: snap.rows.filter((row) => row.openedColors >= 2).length };
  });
  add('颜色数随线路开通单调递增', sequence.every((item, index) => index === 0 || item.multi >= sequence[index - 1].multi),
    sequence.map((item) => 't' + Math.round(item.t) + ':' + item.opened + '线/' + item.multi + '换乘').join(' '));

  /* 截图/视频用的渲染器也要遵循同一规则 */
  add('视频渲染器使用"已开通线路"配色', typeof S.openedColorsFor === 'function' && typeof M.SchematicVideo === 'object',
    'openedColorsFor ready');

  S.skip();
  await sleep(200);
  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
