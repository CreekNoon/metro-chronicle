(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera, E = M.Edit;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;

  /* ---------------------------------------------- A 事件表：按日期排序 */
  St.stop();
  await sleep(200);
  const events = St.buildEvents();
  const dates = events.map(e => e.dateText);
  const values = events.map(e => {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(e.dateText);
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : Infinity;
  });
  add('事件表非空', events.length >= 4, events.length);
  add('事件按日期升序', values.every((v, i) => i === 0 || v >= values[i - 1]), dates.join(' → '));
  add('同时包含整线事件与单站事件',
    events.some(e => e.type === 'line') && events.some(e => e.type === 'station'),
    events.map(e => e.type).join(','));
  const hetangEvent = events.filter(e => e.type === 'station' && e.stationKey === 'zz-hetang')[0];
  add('荷塘被识别为单独开通事件', !!hetangEvent && hetangEvent.dateText === '2035.06.01',
    hetangEvent ? hetangEvent.dateText : 'missing');
  add('单站事件落在 3 号线与城际之间', (() => {
    const idx3 = events.findIndex(e => e.type === 'line' && A.plan.lines[e.lineIndex].key === 'zz-l3');
    const idxIc = events.findIndex(e => e.type === 'line' && A.plan.lines[e.lineIndex].key === 'zz-ic');
    const idxH = events.indexOf(hetangEvent);
    return idx3 >= 0 && idxIc >= 0 && idx3 < idxH && idxH < idxIc;
  })(), events.map(e => e.type + '@' + e.dateText).join(' | '));

  /* --------------------------------- B 画线时不提前点亮「单独开通」的站 */
  S.build(A.plan);
  S.drawProgress(2, 1);                      // 3 号线画完
  const hetangState = S.stations['zz-hetang'] ? S.stations['zz-hetang'].state : 'missing';
  add('整线绘制不会提前点亮单独开通的站', hetangState === 'hidden', hetangState);
  add('同线其它站已被点亮', S.stations['zz-shennong'].state === 'opened', S.stations['zz-shennong'].state);
  const revealed = S.revealStandalone('zz-hetang');
  add('单站开通可单独点亮', revealed === true && S.stations['zz-hetang'].state === 'opened',
    S.stations['zz-hetang'].state);

  /* --------------------------------- C 换乘站：单点多色圆环（不是两个点） */
  S.build(A.plan);
  S.openedLineKeys = { 'zz-l1': true };
  S.drawProgress(0, 1);
  S.openedLineKeys['zz-l2'] = true;
  S.drawProgress(1, 1);                      // 清水塘此时应变成换乘
  await sleep(450);                          // 等圆点颜色的 CSS 过渡结束
  const qNode = S.stations['zz-qingshuitang'];
  const qSt = qNode.refs.st;
  const ringStyle = getComputedStyle(qNode.refs.ring);
  add('换乘站为单点（无 st-transfer 元素）', !document.querySelector('.st-transfer'), !!document.querySelector('.st-transfer'));
  add('换乘环使用多色 conic 渐变', /conic-gradient/.test(ringStyle.backgroundImage), String(ringStyle.backgroundImage).slice(0, 80));
  add('渐变包含两条线路颜色',
    new RegExp('230, ?0, ?18').test(ringStyle.backgroundImage) && new RegExp('0, ?104, ?183').test(ringStyle.backgroundImage),
    String(ringStyle.backgroundImage).slice(0, 120));
  add('换乘站中心是白色单点', getComputedStyle(qNode.refs.dot).backgroundColor === 'rgb(255, 255, 255)',
    getComputedStyle(qNode.refs.dot).backgroundColor);
  add('同一站点只渲染一个标记', document.querySelectorAll('.st[data-station-key="zz-qingshuitang"]').length === 1,
    document.querySelectorAll('.st[data-station-key="zz-qingshuitang"]').length);

  /* --------------------------------- D 镜头：固定缩放 + 平移 + 全览 */
  St.play();
  const samples = [];
  let stationEventSample = null;
  const lineZooms = {};
  const t0 = performance.now();
  while (performance.now() - t0 < 150000) {
    if (St.finished) break;
    await sleep(110);
    const size = map.getSize();

    // 站名/状态采样（单站事件没有头部标记，需要单独统计）
    const statusText = document.getElementById('lineStatus').textContent;
    if (statusText === '站点开通') {
      const z = map.getZoom();
      if (!stationEventSample) {
        stationEventSample = {
          date: document.getElementById('dateText').textContent,
          name: document.getElementById('lineName').textContent,
          zoom: z
        };
      } else if (z > stationEventSample.zoom) {
        stationEventSample.zoom = z;      // 事件期间取最大缩放（飞行抵达后的特写值）
      }
    }

    // 只在「稳定跟拍单条线路」时采样，排除事件交接与飞行瞬间
    let visible = null;
    let visibleCount = 0;
    Object.keys(S.routes).forEach((key) => {
      const route = S.routes[key];
      if (route.active && route.headPoint) { visibleCount += 1; visible = { key: key, route: route, op: 1 }; }
    });
    if (!St.drawing || C.flying || map._animatingZoom || visibleCount !== 1 || !visible) continue;

    const head = L.latLng(visible.route.headPoint[0], visible.route.headPoint[1]);
    const headPt = map.latLngToContainerPoint(head);
    const start = S.geometries[visible.key].render[0];
    const startPt = map.latLngToContainerPoint(L.latLng(start[0], start[1]));
    const midPt = map.latLngToContainerPoint(L.latLng((start[0] + head.lat) / 2, (start[1] + head.lng) / 2));
    const zoom = map.getZoom();
    lineZooms[visible.key] = lineZooms[visible.key] || [zoom, zoom];
    lineZooms[visible.key][0] = Math.min(lineZooms[visible.key][0], zoom);
    lineZooms[visible.key][1] = Math.max(lineZooms[visible.key][1], zoom);
    samples.push({
      key: visible.key,
      zoom: zoom,
      dx: Math.abs(headPt.x - size.x / 2) / size.x,
      dy: Math.abs(headPt.y - size.y / 2) / size.y,
      midDx: Math.abs(midPt.x - size.x / 2) / size.x,
      midDy: Math.abs(midPt.y - size.y / 2) / size.y,
      startInside: startPt.x >= 0 && startPt.y >= 0 && startPt.x <= size.x && startPt.y <= size.y,
      headInside: headPt.x >= 0 && headPt.y >= 0 && headPt.x <= size.x && headPt.y <= size.y
    });
  }
  St.skip();
  await sleep(700);
  add('播放可完整结束', St.finished === true, Math.round(performance.now() - t0) + 'ms');
  add('采样到线路跟拍', samples.length >= 8, samples.length + ' 次采样');

  /* D1 每条线路运行途中缩放不变 */
  const spreads = Object.keys(lineZooms).map((key) => ({
    key: key,
    spread: lineZooms[key][1] - lineZooms[key][0],
    zoom: lineZooms[key][0]
  }));
  add('每条线路运行途中缩放保持不变', spreads.every(s => s.spread <= 0.02),
    spreads.map(s => s.key + '=' + s.zoom + '(±' + s.spread + ')').join(' '));

  /* D1.5 首条线路取景比全览更近（不会"最后一站反而放大"） */
  const firstLineZoom = C.lineZoom(0);
  const overview = C.fitTarget(Object.keys(S.geometries).reduce((acc, key) => acc.concat(S.geometries[key].render), []));
  add('首线取景比全览更近', !!overview && firstLineZoom >= overview.zoom,
    firstLineZoom.toFixed(2) + ' vs ' + (overview ? overview.zoom.toFixed(2) : 'n/a'));
  add('所有线路取景都不比全览更远',
    A.plan.lines.every((_, i) => C.lineZoom(i) >= (overview ? overview.zoom : -1)),
    A.plan.lines.map((_, i) => C.lineZoom(i).toFixed(2)).join('/'));
  add('所有线路共用同一个特写比例 A',
    A.plan.lines.every((_, i) => Math.abs(C.lineZoom(i) - C.focusZoom) < 1e-9),
    'A=' + C.focusZoom.toFixed(2) + ' / 全景=' + C.panoramaZoom.toFixed(2));

  /* D1.6 缩放值是连续量（小数），说明不再按整级跳动 */
  add('取景缩放为连续值（非整级跳变）',
    Math.abs(firstLineZoom - Math.round(firstLineZoom)) > 0.02 ||
    A.plan.lines.some((_, i) => Math.abs(C.lineZoom(i) - Math.round(C.lineZoom(i))) > 0.02),
    A.plan.lines.map((_, i) => C.lineZoom(i).toFixed(3)).join('/'));

  /* D2 特写跟拍：头部始终在画面内（特写下起点允许出画） */
  add('绘制过程中头部始终在画面内', samples.every(s => s.headInside),
    samples.filter(s => !s.headInside).length + ' 次越界');

  /* D3 延伸路径中点居中 */
  const maxHeadOffset2 = samples.reduce((m, s) => Math.max(m, s.dx, s.dy), 0);
  add('镜头始终跟着延伸头部（头部贴近画面中心）', maxHeadOffset2 < 0.16, maxHeadOffset2.toFixed(3));

  /* D4 单站开通为特写 */
  add('单站开通时顶栏切换为「站点开通」', !!stationEventSample, JSON.stringify(stationEventSample));
  add('单站开通日期正确', !!stationEventSample && stationEventSample.date === '2035.06.01',
    stationEventSample ? stationEventSample.date : 'n/a');
  add('单站开通显示站名', !!stationEventSample && stationEventSample.name === '荷塘',
    stationEventSample ? stationEventSample.name : 'n/a');
  add('单站开通为特写缩放（≥13）', !!stationEventSample && stationEventSample.zoom >= 13,
    stationEventSample ? stationEventSample.zoom : 'n/a');

  /* D5 全览 */
  const size = map.getSize();
  const outside = Object.keys(S.stations).filter((key) => {
    const pt = map.latLngToContainerPoint(S.stations[key].marker.getLatLng());
    return pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y;
  });
  add('结束后收束为全览（所有站点在视口内）', outside.length === 0, outside.join(',') || 'ok');
  const snap = M.snapshot();
  add('终态统计为全量（去重站数）', Number(snap.stats.stations) === Object.keys(S.stations).length,
    snap.stats.stations + ' vs ' + Object.keys(S.stations).length);
  add('终态线路数=线路总数', Number(snap.stats.lines) === A.plan.lines.length, snap.stats.lines);

  /* --------------------------------- E 编辑：输入开通时间 / 单独开通 */
  E.enter();
  await sleep(500);
  const targetKey = A.plan.lines[0].stations[1].key;
  E.select(targetKey);
  await sleep(250);
  const modeSelect = document.querySelector('#editCard [data-act="open-mode"]');
  add('编辑卡片有开通方式选择', !!modeSelect);
  modeSelect.value = 'alone';
  modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);
  const stationEntry = A.plan.lines[0].stations[1];
  add('可设为单独开通', stationEntry.openMode === 'alone', stationEntry.openMode);
  add('单独开通后出现日期输入框', (() => {
    const input = document.querySelector('#editCard [data-act="open-date"]');
    return !!input && input.offsetParent !== null;
  })());

  const dateInput = document.querySelector('#editCard [data-act="open-date"]');
  dateInput.value = '2099-03-05';
  dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);
  add('日期输入被规范化为 YYYY.MM.DD', stationEntry.openDate === '2099.03.05', stationEntry.openDate);

  const eventsAfter = St.buildEvents();
  add('新日期让该站排到最后', (() => {
    const last = eventsAfter[eventsAfter.length - 1];
    return last.type === 'station' && last.stationKey === targetKey;
  })(), eventsAfter.map(e => e.type + '@' + e.dateText).join(' | '));

  /* 线路设置面板：修改开通日期 */
  E.openLineSheet();
  await sleep(400);
  add('线路设置面板可打开', document.getElementById('lineSheet').classList.contains('is-on'));
  document.getElementById('lineDateInput').value = '2033.07.07';
  document.getElementById('saveLineBtn').click();
  await sleep(450);
  add('线路开通日期可修改', A.plan.lines[E.lineIndex].dateText === '2033.07.07', A.plan.lines[E.lineIndex].dateText);
  add('修改日期后事件顺序随之变化', (() => {
    const evts = St.buildEvents();
    const lineEvent = evts.filter(e => e.type === 'line' && e.lineIndex === E.lineIndex)[0];
    return !!lineEvent && lineEvent.dateText === '2033.07.07';
  })());
  E.restoreDefault();
  E.exit();

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
