(async () => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App, E = M.Edit, C = M.CityUI;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFinish = async (label, limit) => {
    const t0 = performance.now();
    while (!M.Story.finished && performance.now() - t0 < (limit || 30000)) await sleep(120);
    add(label, M.Story.finished === true, Math.round(performance.now() - t0) + 'ms');
    await sleep(300);
  };
  const selectCity = (id) => {
    const sel = document.getElementById('citySelect');
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickMapAt = (lat, lng) => {
    const map = A.map;
    const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
    const box = map.getContainer().getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: box.left + pt.x, clientY: box.top + pt.y };
    const el = map.getContainer();
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  await waitFinish('初始城市播放完成');

  /* ---- 城市选择器内容 ---- */
  const options = Array.from(document.getElementById('citySelect').options).map(o => o.value);
  add('内置 2 个城市预设', options.indexOf('zhuzhou') >= 0 && options.indexOf('xiangtan') >= 0, options.join('|'));
  add('提供自定义城市入口', options.indexOf('__custom__') >= 0);

  /* ---- 在编辑态改株洲方案，然后直接切城市（应先保存） ---- */
  E.enter();
  await sleep(80);
  const target = A.plan.lines[0].stations[0];
  E.select(target.key);
  const input = document.querySelector('#editCard [data-act="name"]');
  input.value = '云龙新城';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  add('编辑态已改名', A.plan.lines[0].stations[0].name === '云龙新城', A.plan.lines[0].stations[0].name);

  /* ---- 切到湘潭 ---- */
  const zhuzhouGeoBefore = Object.keys(S.geometries).length;
  selectCity('xiangtan');
  await sleep(400);
  const afterSwitch = M.snapshot();
  add('切换城市后方案切换', afterSwitch.cityId === 'xiangtan' && afterSwitch.cityName === '湘潭', afterSwitch.cityId);
  add('切城后进入该城市播放', M.Story.playing === true || M.Story.finished === true, JSON.stringify(M.snapshot().story));
  add('切城后顶栏随城市更新', afterSwitch.range.indexOf('—') > 0, afterSwitch.range);
  add('切城后版权含新城市名', document.getElementById('creditCity').textContent.indexOf('湘潭') >= 0,
    document.getElementById('creditCity').textContent);
  add('切城后旧场景图层已销毁重建', afterSwitch.stationStates && Object.keys(afterSwitch.stationStates).every(k => k.indexOf('xt-') === 0),
    Object.keys(afterSwitch.stationStates).join(','));
  add('切城后视野按新城市适配', Math.abs(A.map.getCenter().lat - 27.87) < 0.35, A.map.getCenter().lat.toFixed(3));

  await waitFinish('湘潭播放完成');
  const xt = M.snapshot();
  add('湘潭终态线路数 3', xt.stats.lines === '3', xt.stats.lines);
  add('湘潭终态站点数 9（去重）', xt.stats.stations === '9', xt.stats.stations);
  add('湘潭终态里程实时计算', Number(xt.stats.km) > 20 && Number(xt.stats.km) < 60, xt.stats.km);
  add('湘潭末线为城际且开通运营', xt.badge === '城际' && xt.status === '开通运营', xt.badge + '/' + xt.status);
  add('湘潭换乘站（湘潭站）为换乘态', xt.stationStates['xt-xiangtanzhan'] === 'transfer', xt.stationStates['xt-xiangtanzhan']);

  /* ---- 切回株洲：编辑方案应仍在 ---- */
  selectCity('zhuzhou');
  await sleep(500);
  const backSnap = M.snapshot();
  add('切回株洲', backSnap.cityId === 'zhuzhou', backSnap.cityId);
  add('切回后编辑方案仍在', A.plan.lines[0].stations[0].name === '云龙新城', A.plan.lines[0].stations[0].name);
  add('切回后自动重播（1 号线场景）', M.snapshot().badge === '1', M.snapshot().badge);
  add('切回后线路头区间含改后站名', M.snapshot().range.indexOf('云龙新城') === 0, M.snapshot().range);
  await waitFinish('切回株洲后播放完成');
  const backEnd = M.snapshot();
  add('切回后终态线路数=株洲线路数', Number(backEnd.stats.lines) === A.plan.lines.length,
    backEnd.stats.lines + ' vs ' + A.plan.lines.length);
  add('切回后终态站点数=去重站数',
    Number(backEnd.stats.stations) === Object.keys(S.stations).length,
    backEnd.stats.stations + ' vs ' + Object.keys(S.stations).length);

  /* ---- 切城市时不应产生重复图层 ---- */
  const lineCount = A.plan.lines.length;
  const uniqueStations = Object.keys(S.stations).length;
  add('无重复线路图层', A.map.getContainer().querySelectorAll('.route-layer').length === lineCount * 3,
    A.map.getContainer().querySelectorAll('.route-layer').length + ' vs ' + lineCount * 3);
  add('无重复站点标记', A.map.getContainer().querySelectorAll('.st').length === uniqueStations,
    A.map.getContainer().querySelectorAll('.st').length + ' vs ' + uniqueStations);
  add('无重复头部标记', A.map.getContainer().querySelectorAll('.route-head').length === lineCount,
    A.map.getContainer().querySelectorAll('.route-head').length + ' vs ' + lineCount);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
