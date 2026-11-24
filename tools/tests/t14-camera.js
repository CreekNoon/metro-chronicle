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
  S.drawProgress(0, 1);
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

  /* --------------------------------- D 镜头：跟拍 + 拉远 + 全览 */
  St.play();
  const samples = [];
  let sawStationEvent = null;
  const t0 = performance.now();
  while (performance.now() - t0 < 40000) {
    if (St.finished) break;
    await sleep(110);
    const size = map.getSize();
    const center = { x: size.x / 2, y: size.y / 2 };
    // 只跟「当前真正可见」的头部（元素透明度最高者），避免读到正在淡出的旧头标
    let visible = null;
    Object.keys(S.routes).forEach((key) => {
      const route = S.routes[key];
      const el = route.head.getElement();
      const op = el ? Number(getComputedStyle(el).opacity) : 0;
      if (op > 0.6 && (!visible || op > visible.op)) visible = { key: key, route: route, op: op };
    });
    if (visible) Object.keys({ [visible.key]: 1 }).forEach((key) => {
      const route = S.routes[key];
      const head = route.head.getLatLng();
      const pt = map.latLngToContainerPoint(head);
      const geometry = S.geometries[key];
      if (!geometry || !geometry.render.length) return;
      const start = L.latLng(geometry.render[0][0], geometry.render[0][1]);
      const mid = map.latLngToContainerPoint(L.latLng((start.lat + head.lat) / 2, (start.lng + head.lng) / 2));
      samples.push({
        key: key,
        dx: Math.abs(pt.x - center.x) / size.x,
        dy: Math.abs(pt.y - center.y) / size.y,
        midDx: Math.abs(mid.x - center.x) / size.x,
        midDy: Math.abs(mid.y - center.y) / size.y,
        zoom: map.getZoom()
      });
    });
    const statusText = document.getElementById('lineStatus').textContent;
    if (!sawStationEvent && statusText === '站点开通') {
      sawStationEvent = {
        date: document.getElementById('dateText').textContent,
        name: document.getElementById('lineName').textContent,
        range: document.getElementById('lineRange').textContent
      };
    }
  }
  const finished = St.finished;
  add('播放可完整结束', finished === true, Math.round(performance.now() - t0) + 'ms');
  add('采样到线路跟拍', samples.length >= 8, samples.length + ' 次采样');

  const maxMidOffset = samples.reduce((m, s) => Math.max(m, s.midDx, s.midDy), 0);
  add('延伸路径中点始终贴近画面中心', maxMidOffset < 0.1, maxMidOffset.toFixed(3));
  const maxHeadOffset = samples.reduce((m, s) => Math.max(m, s.dx, s.dy), 0);
  add('绘制头部始终在画面内', maxHeadOffset < 0.45, maxHeadOffset.toFixed(3));
  const maxZoom = samples.reduce((m, s) => Math.max(m, s.zoom), 0);
  const minZoom = samples.reduce((m, s) => Math.min(m, s.zoom), 99);
  add('线路绘制期有特写（zoom ≥ 13）', maxZoom >= 13, maxZoom.toFixed(2));
  add('线路绘制期有拉远（zoom 明显变化）', maxZoom - minZoom >= 1.2, (maxZoom - minZoom).toFixed(2));

  add('单站开通时顶栏切换为「站点开通」', !!sawStationEvent, JSON.stringify(sawStationEvent));
  add('单站开通日期正确', !!sawStationEvent && sawStationEvent.date === '2035.06.01',
    sawStationEvent ? sawStationEvent.date : 'n/a');
  add('单站开通显示站名', !!sawStationEvent && sawStationEvent.name === '荷塘',
    sawStationEvent ? sawStationEvent.name : 'n/a');

  /* 全览：所有站点都在视口内 */
  const size = map.getSize();
  const outside = Object.keys(S.stations).filter((key) => {
    const pt = map.latLngToContainerPoint(S.stations[key].marker.getLatLng());
    return pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y;
  });
  add('结束后收束为全览（所有站点在视口内）', outside.length === 0, outside.join(',') || 'ok');
  add('全览 zoom 小于特写', map.getZoom() < maxZoom, map.getZoom().toFixed(2) + ' < ' + maxZoom.toFixed(2));
  const snap = M.snapshot();
  add('终态统计为全量（去重站数）', Number(snap.stats.stations) === Object.keys(S.stations).length,
    snap.stats.stations + ' vs ' + Object.keys(S.stations).length);
  add('终态线路数=线路总数', Number(snap.stats.lines) === A.plan.lines.length, snap.stats.lines);

  /* --------------------------------- E 编辑：输入开通时间 / 单独开通 */
  E.enter();
  await sleep(400);
  const targetKey = A.plan.lines[0].stations[1].key;
  E.select(targetKey);
  await sleep(200);
  const modeSelect = document.querySelector('#editCard [data-act="open-mode"]');
  add('编辑卡片有开通方式选择', !!modeSelect);
  modeSelect.value = 'alone';
  modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  const stationEntry = A.plan.lines[0].stations[1];
  add('可设为单独开通', stationEntry.openMode === 'alone', stationEntry.openMode);
  add('单独开通后出现日期输入框', (() => {
    const input = document.querySelector('#editCard [data-act="open-date"]');
    return !!input && input.offsetParent !== null;
  })());

  const dateInput = document.querySelector('#editCard [data-act="open-date"]');
  dateInput.value = '2099-03-05';
  dateInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(250);
  add('日期输入被规范化为 YYYY.MM.DD', stationEntry.openDate === '2099.03.05', stationEntry.openDate);

  const eventsAfter = St.buildEvents();
  add('新日期让该站排到最后', (() => {
    const last = eventsAfter[eventsAfter.length - 1];
    return last.type === 'station' && last.stationKey === targetKey;
  })(), eventsAfter.map(e => e.type + '@' + e.dateText).join(' | '));

  /* 线路设置面板：修改开通日期 */
  E.openLineSheet();
  await sleep(300);
  add('线路设置面板可打开', document.getElementById('lineSheet').classList.contains('is-on'));
  document.getElementById('lineDateInput').value = '2033.07.07';
  document.getElementById('saveLineBtn').click();
  await sleep(350);
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
