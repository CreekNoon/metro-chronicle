(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const S = M.Schematic;
  add('示意图引擎在跑', !!S && !!S.root, M.engineNow ? M.engineNow() : 'n/a');
  if (!S || !S.root) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  /* ---------- A 事件表复用 Story ---------- */
  const storyEvents = (typeof M.Story !== 'undefined' && M.Story.buildEvents) ? M.Story.buildEvents() : [];
  const schematicEvents = S.computeEvents() || [];
  const label = (event) => event.type + ':' + event.dateText;
  add('示意图事件表与 Story.buildEvents 完全一致',
    storyEvents.map(label).join('|') === schematicEvents.map(label).join('|'),
    schematicEvents.map(label).join(' / '));
  add('包含「单独开通」的站点事件',
    schematicEvents.some((event) => event.type === 'station'),
    schematicEvents.filter((e) => e.type === 'station').map((e) => e.dateText).join(','));
  add('事件按日期升序',
    schematicEvents.every((event, index) => index === 0 || event.dateValue >= schematicEvents[index - 1].dateValue),
    schematicEvents.map((e) => e.dateValue).join(' < '));

  /* ---------- B 单站开通：不随整线提前点亮 ---------- */
  S.skip();
  await sleep(200);
  const apartStation = (() => {
    for (const line of M.App.plan.lines) {
      for (const station of line.stations) {
        if (station.openMode === 'alone') return station;
      }
    }
    return null;
  })();
  add('存在「单独开通」的站点', !!apartStation, apartStation ? apartStation.name : 'none');
  if (apartStation) {
    add('单独开通的站点在终点态被点亮', S.nodes[apartStation.key] && S.nodes[apartStation.key].state !== 'hidden',
      S.nodes[apartStation.key] ? S.nodes[apartStation.key].state : 'missing');
  }

  /* ---------- C 跳过 / 重播 ---------- */
  add('跳过之后进入完成态', S.phase === 'done' && S.finished === true && S.running === false,
    S.phase + '/' + S.running);
  const allRevealed = Object.keys(S.nodes).every((key) => S.nodes[key].state !== 'hidden');
  add('跳过后所有站点点亮', allRevealed, Object.keys(S.nodes).length + ' 个站点');
  const allDrawn = S.layout.lines.every((entry) => {
    const el = S.lines[entry.line.key] && S.lines[entry.line.key].main;
    if (!el) return false;
    const offset = Number(el.style.strokeDashoffset.replace('px', '')) || 0;
    return Math.abs(offset) < 1.5;
  });
  add('跳过后所有线路绘制完整（dashoffset≈0）', allDrawn);

  const snapDone = M.snapshot().story;
  add('快照反映示意图引擎状态', snapDone.engine === 'schematic' && snapDone.finished === true,
    JSON.stringify({ engine: snapDone.engine, finished: snapDone.finished, phase: snapDone.phase }));

  S.replay();
  await sleep(400);
  const revealedAfterReplay = Object.keys(S.nodes).filter((key) => S.nodes[key].state !== 'hidden').length;
  add('重播会复位到未点亮状态', revealedAfterReplay <= 2, revealedAfterReplay + ' 个已点亮');
  add('重播后重新开始播放', S.running === true && S.finished === false, S.phase);

  /* ---------- D 镜头节奏复用 STORY_TIMING ---------- */
  await sleep(3000);
  add('特写/全景比例符合节奏（特写 ≈ 全景 × 2.15）',
    Math.abs(S.focusScale / S.panoramaScale - 2.15) < 0.05,
    'panorama=' + S.panoramaScale.toFixed(2) + ' focus=' + S.focusScale.toFixed(2));

  /* ---------- E 统计口径与地理版一致 ---------- */
  S.skip();
  await sleep(200);
  const expected = M.snapshot().stats;
  add('终态统计 = 地理版口径（去重站数/线路数/里程）',
    S.stats && String(S.stats.stations) === String(expected.stations) &&
    String(S.stats.lines) === String(expected.lines) &&
    String(S.stats.km) === String(expected.km),
    JSON.stringify(S.stats) + ' vs ' + JSON.stringify(expected));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
