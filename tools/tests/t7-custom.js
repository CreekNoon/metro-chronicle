(async () => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App, E = M.Edit;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFinish = async (label) => {
    const t0 = performance.now();
    while (!M.Story.finished && performance.now() - t0 < 30000) await sleep(120);
    add(label, M.Story.finished === true, Math.round(performance.now() - t0) + 'ms');
    await sleep(400);
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
  const barLine = (i) => { document.querySelectorAll('#editBar [data-act="line"]')[i].click(); };
  const barBtn = (act) => {
    const el = document.querySelector('#editBar [data-act="' + act + '"]');
    if (el) el.click();
    return !!el;
  };

  await waitFinish('初始播放完成');

  /* ---- 打开自定义城市面板 ---- */
  const sel = document.getElementById('citySelect');
  sel.value = '__custom__';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  add('自定义城市面板打开', document.getElementById('citySheet').classList.contains('is-on'));
  add('面板预填当前地图中心坐标（WGS84）',
    Math.abs(Number(document.getElementById('customCityLat').value) - A.map.getCenter().lat) < 0.6,
    document.getElementById('customCityLat').value + ',' + document.getElementById('customCityLng').value);
  add('选择器自动回退到当前城市', sel.value === 'zhuzhou', sel.value);

  /* ---- 创建空白城市 ---- */
  document.getElementById('customCityName').value = '衡阳';
  document.getElementById('createCity').click();
  await sleep(1400);
  const created = M.snapshot();
  add('创建自定义城市', created.cityName === '衡阳' && created.cityId.indexOf('custom-') === 0, created.cityId + '/' + created.cityName);
  add('新城市为空白线网并进入编辑态', E.active === true && created.stats.stations === '0',
    'active=' + E.active + ' stations=' + created.stats.stations);
  add('新城市出现在选择器中', Array.from(sel.options).some(o => o.textContent === '衡阳'),
    Array.from(sel.options).map(o => o.textContent).join('|'));
  add('空白城市默认视口 zoom=12', Math.round(A.map.getZoom()) === 12, A.map.getZoom());

  /* ---- 从零添加两条线 ---- */
  const center = A.map.getCenter();
  const c0 = [center.lat, center.lng];
  barLine(0);
  clickMapAt(c0[0] + 0.004, c0[1] - 0.006);
  await sleep(100);
  clickMapAt(c0[0] - 0.004, c0[1] + 0.010);
  await sleep(100);
  add('往 1 号线添加 2 站', A.plan.lines[0].stations.length === 2, A.plan.lines[0].stations.length);

  barLine(1);
  await sleep(80);
  clickMapAt(c0[0] + 0.010, c0[1] + 0.012);
  await sleep(100);
  clickMapAt(c0[0] + 0.016, c0[1] - 0.002);
  await sleep(100);
  add('往 2 号线添加 2 站', A.plan.lines[1].stations.length === 2, A.plan.lines[1].stations.length);

  /* ---- 修改终点站名，然后完成并播放 ---- */
  E.select(A.plan.lines[1].stations[1].key);
  await sleep(80);
  const nameInput = document.querySelector('#editCard [data-act="name"]');
  nameInput.value = '衡阳东站';
  nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);

  barBtn('done');
  await sleep(800);
  add('完成后开始播放', E.active === false && (M.Story.playing === true || M.Story.finished === true));
  await waitFinish('自定义城市播放完成');
  const end = M.snapshot();
  add('自定义城市终态 2 条线', end.stats.lines === '2', end.stats.lines);
  add('自定义城市终态 4 站', end.stats.stations === '4', end.stats.stations);
  add('自定义城市里程由数据计算', Number(end.stats.km) > 0, end.stats.km);
  add('自定义城市区间含改后站名', end.range.indexOf('衡阳东站') > 0, end.range);

  /* ---- 城市间互不干扰 ---- */
  sel.value = 'zhuzhou';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(600);
  add('切回株洲方案独立', A.plan.lines[0].stations.length === 6 && A.plan.lines[1].stations.length === 5,
    A.plan.lines[0].stations.length + '/' + A.plan.lines[1].stations.length);
  await waitFinish('切回株洲播放完成');

  const customOption = Array.from(sel.options).filter(o => o.textContent === '衡阳')[0];
  sel.value = customOption.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(600);
  add('切回自定义城市方案仍在', A.plan.cityName === '衡阳' && A.plan.lines[0].stations.length === 2 && A.plan.lines[1].stations.length === 2,
    A.plan.lines[0].stations.length + '/' + A.plan.lines[1].stations.length);
  await waitFinish('自定义城市再次播放完成');

  /* ---- 事件监听未重复累积 ---- */
  add('地图 click 监听未重复累积', A.map._events && A.map._events.click ? A.map._events.click.length <= 2 : true,
    A.map._events && A.map._events.click ? A.map._events.click.length : 'n/a');

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
