(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, B = M.Basemap;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const R = 6371008.8, D = Math.PI / 180;
  const dist = (a, b) => {
    const la1 = a[0] * D, la2 = b[0] * D, dla = la2 - la1, dlo = (b[1] - a[1]) * D;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const key = A.plan.lines[0].stations[0].key;
  const planBefore = [A.plan.lines[0].stations[0].lat, A.plan.lines[0].stations[0].lng];

  /* ---- 1) 默认就是高德底图（需求 1） ---- */
  add('默认底图为高德', B.mode === 'amap' && B.datum === 'gcj02', B.mode + '/' + B.datum);
  add('Key 校验通过', B.keyStatus === 'valid', B.keyStatus);
  add('高德瓦片图层已挂载', !!B.amapLayer && String(B.amapLayer._url).indexOf('autonavi') >= 0,
    B.amapLayer ? String(B.amapLayer._url).slice(0, 46) : 'none');
  add('版权显示高德', document.getElementById('creditSource').textContent.indexOf('高德') >= 0,
    document.getElementById('creditSource').textContent);
  add('容器带 basemap-amap 类', A.map.getContainer().classList.contains('basemap-amap'));

  const gcjPos = [S.stations[key].marker.getLatLng().lat, S.stations[key].marker.getLatLng().lng];
  add('plan 仍保存 WGS84（未被投影污染）',
    A.plan.lines[0].stations[0].lat === planBefore[0] && A.plan.lines[0].stations[0].lng === planBefore[1],
    planBefore.join(','));

  /* ---- 2) 切到栅格：坐标应回到 WGS84 ---- */
  M.forceBasemap('raster');
  M.rebuildScene();
  const wgsPos = [S.stations[key].marker.getLatLng().lat, S.stations[key].marker.getLatLng().lng];
  const offset = dist(gcjPos, wgsPos);
  add('切栅格后 datum=wgs84', B.datum === 'wgs84' && B.mode === 'raster', B.mode + '/' + B.datum);
  add('高德/栅格坐标差 100~900m（GCJ 偏移量级）', offset > 100 && offset < 900, Math.round(offset) + 'm');
  add('版权随底图切换', document.getElementById('creditSource').textContent.indexOf('Esri') >= 0,
    document.getElementById('creditSource').textContent);
  add('高德瓦片已移除', A.map.getContainer().classList.contains('basemap-amap') === false);

  /* ---- 3) 坐标往返精度 ---- */
  const p = A.plan.lines[0].stations[1];
  const projected = B.project(p.lat, p.lng);
  const back = B.unproject(projected[0], projected[1]);
  add('WGS84→GCJ02→WGS84 往返 <0.5m', dist([p.lat, p.lng], back) < 0.5, dist([p.lat, p.lng], back).toFixed(3) + 'm');

  M.forceBasemap('amap');
  M.rebuildScene();
  const gcjAgain = [S.stations[key].marker.getLatLng().lat, S.stations[key].marker.getLatLng().lng];
  add('切回高德坐标恢复投影', dist(gcjAgain, gcjPos) < 0.5, dist(gcjAgain, gcjPos).toFixed(3) + 'm');

  /* ---- 4) 明确无效的 32 位 Key：静默回退默认底图 ---- */
  document.getElementById('settingsBtn').click();
  document.getElementById('amapKeyInput').value = '0123456789abcdef0123456789abcdef';
  document.getElementById('saveAmapKey').click();
  await sleep(2600);
  add('无效 Key 校验结论为 invalid', B.keyStatus === 'invalid', B.keyStatus);
  add('无效 Key 静默回退（不再使用高德）', B.mode !== 'amap', B.mode);
  add('回退后坐标系回到 WGS84', B.datum === 'wgs84', B.datum);
  add('回退后场景仍可播放', M.Story.playing === true || M.Story.finished === true, JSON.stringify(M.snapshot().story));

  /* ---- 5) 非 32 位 Key：立即判定无效 ---- */
  document.getElementById('settingsBtn').click();
  document.getElementById('amapKeyInput').value = 'abc';
  document.getElementById('saveAmapKey').click();
  await sleep(900);
  add('短 Key 直接判为无效', B.keyStatus === 'invalid' && B.mode !== 'amap', B.keyStatus + '/' + B.mode);

  /* ---- 6) 清除 Key → 恢复默认底图 ---- */
  document.getElementById('settingsBtn').click();
  document.getElementById('clearAmapKey').click();
  await sleep(1500);
  add('清除 Key 后 localStorage 为空', (window.localStorage.getItem('metroChronicle.v2.amapKey') || '') === '',
    window.localStorage.getItem('metroChronicle.v2.amapKey'));
  add('清除后使用默认底图链路', B.mode !== 'amap' && B.isGcj() === false, B.mode + '/' + B.datum);
  add('清除后版权不是高德', document.getElementById('creditSource').textContent.indexOf('高德') < 0,
    document.getElementById('creditSource').textContent);
  add('清除后设置面板状态可读', /底图/.test(document.getElementById('basemapStatus').textContent || ''),
    document.getElementById('basemapStatus').textContent);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
