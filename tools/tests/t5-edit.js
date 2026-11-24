(async () => {
  const M = window.__METRO__;
  const S = M.Scene, A = M.App, E = M.Edit, B = M.Basemap;
  const checks = [];
  let phase = 'init';
  const P = (n) => { phase = n; };
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const line = (i) => (A.plan && A.plan.lines ? A.plan.lines[i] : null);
  const count = (i) => { const l = line(i); return l ? l.stations.length : -1; };
  const allEntries = () => A.plan.lines.reduce((sum, l) => sum + l.stations.length, 0);
  const uniqueKeys = () => {
    const set = {};
    A.plan.lines.forEach(l => l.stations.forEach(s => { set[s.key] = true; }));
    return Object.keys(set).length;
  };
  const toastText = () => document.getElementById('toast').textContent;
  /** 把 WGS84 经纬度换算成当前底图渲染空间再点图（高德模式需要 GCJ-02） */
  const clickMapAt = (lat, lng) => {
    const rp = B.project(lat, lng);
    const pt = A.map.latLngToContainerPoint(L.latLng(rp[0], rp[1]));
    const box = A.map.getContainer().getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: box.left + pt.x, clientY: box.top + pt.y };
    const el = A.map.getContainer();
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };
  const clickMarker = (key) => {
    const marker = E.markers[key] || (S.stations[key] && S.stations[key].marker);
    if (!marker) return false;
    marker.getElement().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  };
  const cardBtn = (act) => {
    const el = document.querySelector('#editCard [data-act="' + act + '"]');
    if (el) el.click();
    return !!el;
  };
  const barBtn = (act) => {
    const el = document.querySelector('#editBar [data-act="' + act + '"]');
    if (el) el.click();
    return !!el;
  };
  const barLineBtn = (i) => {
    const list = document.querySelectorAll('#editBar [data-act="line"]');
    if (list[i]) list[i].click();
    return !!list[i];
  };
  /** 两点距离（米） */
  const meters = (a, b) => {
    const R = 6371008.8, D = Math.PI / 180;
    const la1 = a[0] * D, la2 = b[0] * D, dla = la2 - la1, dlo = (b[1] - a[1]) * D;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  try {
    /* ---------------------------------------------------- A 进入编辑 */
    P('A-enter');
    document.getElementById('editBtn').click();
    await sleep(400);
    add('进入编辑态', E.active === true && document.body.classList.contains('is-editing'));
    add('编辑态解锁地图', A.map.dragging.enabled() === true && A.map.scrollWheelZoom.enabled() === true);
    add('编辑态取消双击缩放', A.map.doubleClickZoom.enabled() === false);
    add('编辑态显示可编辑图层（=去重站数）', Object.keys(E.markers).length === uniqueKeys(),
      Object.keys(E.markers).length + ' vs ' + uniqueKeys());
    add('播放层已销毁（无头部标记残留）', S.built === false && A.map.getContainer().querySelectorAll('.route-head').length === 0);
    add('工具条列出全部线路', document.querySelectorAll('#editBar [data-act="line"]').length === A.plan.lines.length,
      document.querySelectorAll('#editBar [data-act="line"]').length);
    add('工具条含新建线路按钮', !!document.querySelector('#editBar [data-act="add-metro"]') && !!document.querySelector('#editBar [data-act="add-intercity"]'));

    /* ---------------------------------------------------- B 加站 / 吸附 */
    P('B-add');
    const baseCount = count(0);
    clickMapAt(27.9250, 113.2000);
    await sleep(160);
    add('点击地图追加站点到当前线末尾', count(0) === baseCount + 1, count(0));
    const added = line(0).stations[count(0) - 1];
    add('新站被自动选中并弹出卡片', !!added && E.selectedKey === added.key && document.getElementById('editCard').classList.contains('is-on'), E.selectedKey);

    const anchor = line(0).stations[1];
    clickMapAt(anchor.lat + 0.0002, anchor.lng);
    await sleep(140);
    add('同线 45m 内点击=选中已有站', count(0) === baseCount + 1 && E.selectedKey === anchor.key,
      count(0) + ' / ' + E.selectedKey);

    barLineBtn(1);
    await sleep(140);
    add('工具条可切换线路', E.lineIndex === 1, E.lineIndex);
    const other = line(0).stations[3];
    clickMapAt(other.lat - 0.0005, other.lng);
    await sleep(180);
    add('跨线 90m 内吸附（当前线 +1）', count(1) === 6, count(1));
    const sharedLast = line(1).stations[count(1) - 1];
    add('吸附站共用同一 key', sharedLast.key === other.key, sharedLast.key + ' vs ' + other.key);
    add('提示已与目标站设为换乘站', /换乘站/.test(toastText()), toastText());
    add('吸附站显示为换乘标记', E.markers[other.key].getElement().querySelector('.st').classList.contains('is-transfer'));

    /* ---------------------------------------------------- C 改名 / ghost / 拖动 */
    P('C-attributes');
    const nameInput = document.querySelector('#editCard [data-act="name"]');
    nameInput.value = '测试站名<&>';
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    const renamed = line(1).stations[count(1) - 1];
    add('站名写入方案', renamed.name === '测试站名<&>', renamed.name);
    add('站名已转义渲染', E.markers[renamed.key].getElement().querySelector('.st-name').textContent === '测试站名<&>',
      E.markers[renamed.key].getElement().querySelector('.st-name').textContent);
    add('尖括号未破版（标记数不变）', A.map.getContainer().querySelectorAll('.st').length === uniqueKeys(),
      A.map.getContainer().querySelectorAll('.st').length + ' vs ' + uniqueKeys());

    const ghostBox = document.querySelector('#editCard [data-act="ghost"]');
    ghostBox.checked = true;
    ghostBox.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
    add('勾选暂未开通写入数据', line(1).stations[count(1) - 1].ghost === true);
    add('暂未开通视觉标识生效', E.markers[renamed.key].getElement().querySelector('.st').classList.contains('is-ghost'));

    const posBefore = [line(1).stations[count(1) - 1].lat, line(1).stations[count(1) - 1].lng];
    const targetWgs = [posBefore[0] + 0.004, posBefore[1] + 0.004];
    const rp = B.project(targetWgs[0], targetWgs[1]);
    const marker = E.markers[renamed.key];
    marker.setLatLng(L.latLng(rp[0], rp[1]));
    marker.fire('dragend');
    await sleep(160);
    const moved = [line(1).stations[count(1) - 1].lat, line(1).stations[count(1) - 1].lng];
    add('拖动更新坐标（WGS84 回写）', meters(moved, targetWgs) < 1.2, meters(moved, targetWgs).toFixed(2) + 'm 偏差');
    const synced = line(0).stations.filter(s => s.key === renamed.key)[0];
    add('同 key 跨线坐标同步', !!synced && meters([synced.lat, synced.lng], moved) < 0.05,
      synced ? meters([synced.lat, synced.lng], moved).toFixed(4) + 'm' : 'not-found');

    /* ---------------------------------------------------- D 排序即走向 */
    P('D-reorder');
    const orderBefore = line(1).stations.map(s => s.name).join('>');
    const movedKey = line(1).stations[1].key;
    E.select(movedKey);
    await sleep(80);
    cardBtn('down');
    await sleep(160);
    add('后移改变站序', line(1).stations.map(s => s.name).join('>') !== orderBefore, line(1).stations.map(s => s.name).join('>'));
    add('后移后序号顺延', line(1).stations[2].key === movedKey, line(1).stations.map(s => s.key).join(','));
    E.select(movedKey);
    await sleep(60);
    cardBtn('up');
    await sleep(160);
    add('前移恢复站序', line(1).stations.map(s => s.name).join('>') === orderBefore, line(1).stations.map(s => s.name).join('>'));
    add('走向变化后路线随之重算', E.routes[line(1).key].main.getLatLngs().length > 40,
      E.routes[line(1).key].main.getLatLngs().length + ' 点');

    /* ---------------------------------------------------- E 删除 / 最少 2 站 */
    P('E-delete');
    const beforeDelete = count(1);
    E.select(line(1).stations[count(1) - 1].key);
    await sleep(80);
    cardBtn('delete');
    await sleep(140);
    add('删除站点生效', count(1) === beforeDelete - 1, count(1));

    E.restoreDefault();
    await sleep(200);
    add('恢复默认按钮可用', count(0) === 6 && count(1) === 5 && A.plan.lines.length === 4,
      `${count(0)}/${count(1)} lines=${A.plan.lines.length}`);
    let guard = 0;
    while (count(0) > 2 && guard < 12) {
      E.select(line(0).stations[2].key);
      await sleep(40);
      cardBtn('delete');
      await sleep(70);
      guard += 1;
    }
    add('可删除至 2 站', count(0) === 2, count(0));
    E.select(line(0).stations[1].key);
    await sleep(60);
    cardBtn('delete');
    await sleep(100);
    add('删除到 1 站被拦截', count(0) === 2, count(0));
    add('拦截时给出 Toast', /至少保留/.test(toastText()), toastText());

    /* ---------------------------------------------------- F 清空本线（二次确认） */
    P('F-clear');
    barBtn('clear');
    await sleep(100);
    add('清空需二次确认（首次不清空）', count(0) === 2, count(0));
    add('首次点击提示确认', /再次点击/.test(toastText()), toastText());
    barBtn('clear');
    await sleep(160);
    add('二次点击清空本线', count(0) === 0, count(0));

    P('F-done-blocked');
    for (let i = 1; i < A.plan.lines.length; i += 1) {
      barLineBtn(i);
      await sleep(70);
      barBtn('clear');
      await sleep(70);
      barBtn('clear');
      await sleep(110);
    }
    add('所有线路均已清空', A.plan.lines.every(l => l.stations.length === 0),
      A.plan.lines.map(l => l.stations.length).join('/'));
    barBtn('done');
    await sleep(160);
    add('全空时完成并播放被拦截', E.active === true, E.active);
    add('拦截提示明确', /至少需要一条线路|至少保留/.test(toastText()), toastText());

    /* ---------------------------------------------------- G 恢复默认 / 加入本线 */
    P('G-reset');
    barBtn('reset');
    await sleep(220);
    add('恢复默认可复原', count(0) === 6 && count(1) === 5 && A.plan.lines.length === 4,
      `${count(0)}/${count(1)} lines=${A.plan.lines.length}`);
    add('恢复后清除该城市存档', !window.localStorage.getItem('metroChronicle.v2.plan.zhuzhou'),
      window.localStorage.getItem('metroChronicle.v2.plan.zhuzhou') ? 'exists' : 'cleared');
    barLineBtn(0);
    await sleep(120);
    const lineTwoOnly = line(1).stations[2];
    clickMarker(lineTwoOnly.key);
    await sleep(160);
    add('点击其它线路站点可选中', E.selectedKey === lineTwoOnly.key, E.selectedKey);
    add('卡片出现「加入本线」按钮', !!document.querySelector('#editCard [data-act="join"]'));
    cardBtn('join');
    await sleep(160);
    add('加入本线成功', line(0).stations.some(s => s.key === lineTwoOnly.key), count(0));
    add('加入后标记为换乘站', !!(line(0).stations.filter(s => s.key === lineTwoOnly.key)[0] || {}).shared);

    /* ---------------------------------------------------- H 完成并播放 */
    P('H-play');
    barBtn('done');
    await sleep(1800);
    add('完成后退出编辑态', E.active === false && !document.body.classList.contains('is-editing'));
    add('退出后无编辑图层残留', E.group === null && document.querySelectorAll('.edit-bar.is-on').length === 0);
    add('退出后从头播放（首条线路场景）', M.snapshot().badge === A.plan.lines[0].badge, M.snapshot().badge);
    add('退出后地图重新锁定', A.locked === true && A.map.dragging.enabled() === false);
    const t0 = performance.now();
    while (!M.Story.finished && performance.now() - t0 < 80000) await sleep(120);
    const end = M.snapshot();
    add('播放可完整结束', end.story.finished === true, Math.round(performance.now() - t0) + 'ms');
    add('跨线加入的站点显示为换乘', end.stationStates[lineTwoOnly.key] === 'transfer', end.stationStates[lineTwoOnly.key]);
    add('站点数由数据实时计算（去重）', Number(end.stats.stations) === uniqueKeys(), end.stats.stations + ' vs ' + uniqueKeys());
    add('里程随编辑重算', Number(end.stats.km) > 0, end.stats.km);

    /* ---------------------------------------------------- I 持久化 / 校验 */
    P('I-persist');
    const raw = window.localStorage.getItem('metroChronicle.v2.plan.zhuzhou');
    add('方案已写入 localStorage', !!raw, raw ? raw.length + ' 字节' : 'missing');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    add('存档结构合法', !!parsed && Array.isArray(parsed.lines) && parsed.lines.length === A.plan.lines.length && typeof parsed.cityId === 'string');
    add('存档坐标为 WGS84 范围', !!parsed && Math.abs(parsed.lines[0].stations[0].lat) < 90,
      parsed ? parsed.lines[0].stations[0].lat : 'n/a');
    add('存档保留线路类型', !!parsed && parsed.lines.every(l => l.type === 'metro' || l.type === 'intercity'),
      parsed ? parsed.lines.map(l => l.type).join(',') : 'n/a');

    P('I-invalid');
    window.localStorage.setItem('metroChronicle.v2.plan.zhuzhou', '{"cityId":"zhuzhou","lines":[{"stations":[{"lat":"x"}]}]}');
    const reloaded = A.loadCity('zhuzhou');
    add('非法存档自动回退默认方案', !!reloaded && reloaded.fromStorage === false, reloaded ? String(reloaded.fromStorage) : 'null');
    add('回退后为默认线路方案', count(0) === 6 && count(1) === 5 && A.plan.lines.length === 4,
      `${count(0)}/${count(1)} lines=${A.plan.lines.length}`);
  } catch (err) {
    return JSON.stringify({ failedAt: phase, error: String(err && err.message), pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
  }

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
