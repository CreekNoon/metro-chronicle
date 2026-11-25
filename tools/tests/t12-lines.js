(async () => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App, E = M.Edit, LS = M.LineSelection;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // 该套件只关心交互结果，用「跳过动画」把每次播放直接推到终态，避免总时长超限
  const waitFinish = async () => {
    if (!M.Story.finished) M.Story.skip();
    await sleep(450);
    return M.Story.finished;
  };

  await waitFinish();

  /* ---------------------------------------------------- 1) 缩放控件（播放期可用） */
  const map = A.map;
  document.getElementById('zoomFit').click();
  await sleep(700);
  const zoom0 = map.getZoom();
  add('播放中地图手势已锁定', map.dragging.enabled() === false && map.scrollWheelZoom.enabled() === false);
  document.getElementById('zoomIn').click();
  await sleep(700);
  const zoom1 = map.getZoom();
  add('播放中点击「＋」可放大', zoom1 > zoom0, zoom0 + ' → ' + zoom1);
  document.getElementById('zoomOut').click();
  await sleep(700);
  const zoom2 = map.getZoom();
  add('点击「－」可缩小', zoom2 < zoom1, zoom1 + ' → ' + zoom2);
  document.getElementById('zoomFit').click();
  await sleep(900);
  add('「复位视野」恢复适配视野', Math.abs(map.getZoom() - zoom0) <= 1, map.getZoom() + ' vs ' + zoom0);
  add('缩放后地图仍锁定', map.dragging.enabled() === false);

  /* ---------------------------------------------------- 2) 跳过动画 */
  document.getElementById('replayBtn').click();
  await sleep(900);
  add('重播开始（未完成）', M.Story.finished === false, JSON.stringify(M.snapshot().story));
  const tSkip = performance.now();
  document.getElementById('skipBtn').click();
  await sleep(400);
  add('「跳过动画」直达终态', M.Story.finished === true, Math.round(performance.now() - tSkip) + 'ms');
  const afterSkip = M.snapshot();
  add('跳过后数据为全量', Number(afterSkip.stats.lines) === A.plan.lines.length,
    afterSkip.stats.lines + ' vs ' + A.plan.lines.length);
  add('跳过后顶栏为最后一条线', afterSkip.badgeType === A.plan.lines[A.plan.lines.length - 1].type, afterSkip.badgeType);
  add('跳过后换乘站已点亮', Object.keys(afterSkip.stationStates).filter(k => afterSkip.stationStates[k] === 'transfer').length >= 4,
    Object.keys(afterSkip.stationStates).filter(k => afterSkip.stationStates[k] === 'transfer').length);

  /* ---------------------------------------------------- 3) 线路多选 */
  const totalLines = A.plan.lines.length;
  const icLine = A.plan.lines.filter(l => l.type === 'intercity')[0];
  const metroLine = A.plan.lines.filter(l => l.type === 'metro')[0];
  add('选择状态默认全选', LS.count() === totalLines, LS.count() + '/' + totalLines);

  // 只保留城际线：先取消所有地铁
  A.plan.lines.filter(l => l.type === 'metro').forEach((line) => {
    if (line.key !== icLine.key) LS.toggle(line.key);
  });
  LS.persist();
  M.LineUI.render();
  add('可取消多条线路', LS.count() === 1, LS.count());
  document.getElementById('replayBtn').click();
  await sleep(700);
  M.Story.skip();
  await sleep(450);
  const icOnly = M.snapshot();
  add('仅城际线播放：只有一个整线事件', icOnly.story.lineEventCount === 1, JSON.stringify(icOnly.story.events));
  add('仅城际线播放：顶栏为城际徽章', icOnly.badgeType === 'intercity' && icOnly.badge === icLine.badge,
    icOnly.badge + '/' + icOnly.badgeType);
  await waitFinish();
  const icEnd = M.snapshot();
  add('仅城际线统计为 1 条', icEnd.stats.lines === '1', icEnd.stats.lines);
  add('仅城际线站点数=该线条目数', Number(icEnd.stats.stations) === icLine.stations.length,
    icEnd.stats.stations + ' vs ' + icLine.stations.length);

  // 至少保留一条：再取消会被拦截
  const before = LS.count();
  const blocked = LS.toggle(icLine.key) === false;
  add('至少保留一条线路（拦截取消最后一条）', blocked && LS.count() === before, 'blocked=' + blocked + ' count=' + LS.count());
  add('拦截时提示 Toast', document.getElementById('toast').textContent.indexOf('至少保留') >= 0,
    document.getElementById('toast').textContent);

  // 恢复全选
  LS.setAll(true);
  M.LineUI.render();
  document.getElementById('replayBtn').click();
  await sleep(1000);
  add('恢复全选后整线事件数=线路数', M.snapshot().story.lineEventCount === totalLines,
    JSON.stringify(M.snapshot().story.events));
  await waitFinish();

  /* ---------------------------------------------------- 3.5) 播放期间禁止改比例 */
  const mapZoomBefore = map.getZoom();
  M.Story.play();
  await sleep(900);
  const zoomDisabled = ['zoomIn', 'zoomOut', 'zoomFit'].every((id) => document.getElementById(id).disabled === true);
  add('播放中缩放按钮被禁用', zoomDisabled, ['zoomIn', 'zoomOut', 'zoomFit'].map((id) => document.getElementById(id).disabled).join(','));
  document.getElementById('zoomIn').click();
  await sleep(500);
  add('播放中点击缩放按钮不会接管镜头', M.Camera.active === true, 'cameraActive=' + M.Camera.active);
  add('滚轮缩放始终关闭', map.scrollWheelZoom.enabled() === false);
  M.Story.skip();
  await sleep(700);
  add('播放结束后缩放按钮恢复可用', ['zoomIn', 'zoomOut', 'zoomFit'].every((id) => document.getElementById(id).disabled === false),
    ['zoomIn', 'zoomOut', 'zoomFit'].map((id) => document.getElementById(id).disabled).join(','));

  /* ---------------------------------------------------- 4) 编辑态增删线路 */
  document.getElementById('editBtn').click();
  await sleep(400);
  const linesBefore = A.plan.lines.length;
  document.querySelectorAll('#editBar [data-act="add-metro"]')[0].click();
  await sleep(300);
  add('可新建地铁线路', A.plan.lines.length === linesBefore + 1, A.plan.lines.length);
  add('新建线路为当前编辑线', E.lineIndex === A.plan.lines.length - 1, E.lineIndex);

  document.querySelectorAll('#editBar [data-act="add-intercity"]')[0].click();
  await sleep(300);
  const added = A.plan.lines[A.plan.lines.length - 1];
  add('可新建城际线路', added.type === 'intercity' && A.plan.lines.length === linesBefore + 2, added.type + '/' + A.plan.lines.length);
  add('城际新线徽章为城际', added.badge === '城际', added.badge);
  add('新建线路默认空站', added.stations.length === 0, added.stations.length);
  add('工具条列出全部线路（含新线）', document.querySelectorAll('#editBar [data-act="line"]').length === A.plan.lines.length,
    document.querySelectorAll('#editBar [data-act="line"]').length);

  E.openLineSheet();
  await sleep(350);
  document.getElementById('deleteLineBtn').click();
  await sleep(250);
  add('删除线路需二次确认', A.plan.lines.length === linesBefore + 2, A.plan.lines.length);
  add('首次点击按钮变为确认文案', document.getElementById('deleteLineBtn').textContent.indexOf('确认') >= 0,
    document.getElementById('deleteLineBtn').textContent);
  document.getElementById('deleteLineBtn').click();
  await sleep(400);
  add('二次点击删除线路', A.plan.lines.length === linesBefore + 1, A.plan.lines.length);
  E.openLineSheet();
  await sleep(300);
  document.getElementById('deleteLineBtn').click();
  await sleep(200);
  document.getElementById('deleteLineBtn').click();
  await sleep(400);
  add('删回原始线路数', A.plan.lines.length === linesBefore, A.plan.lines.length);

  /* ---- 编辑态完成并播放 ---- */
  document.querySelector('#editBar [data-act="done"]').click();
  await sleep(1200);
  add('完成后开始播放', E.active === false && (M.Story.playing || M.Story.finished));
  await waitFinish();

  /* ---- 城际站标在播放态也生效 ---- */
  const railTagged = Array.from(document.querySelectorAll('.st.has-rail'));
  add('城际服务站带 has-rail 标识', railTagged.length >= 3, railTagged.length);
  add('城际胶囊可见', railTagged.length > 0 && railTagged.every(el => getComputedStyle(el.querySelector('.st-rail-tag')).display !== 'none'),
    railTagged.length);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
