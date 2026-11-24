(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rows = () => Array.from(document.querySelectorAll('#citySearchResults .search-row'));
  const rowText = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const meters = (a, b) => {
    const R = 6371008.8, D = Math.PI / 180;
    const la1 = a[0] * D, la2 = b[0] * D, dla = la2 - la1, dlo = (b[1] - a[1]) * D;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  };

  /* 等待初始播放结束，避免和搜索过程中的场景重建打架 */
  if (!window.__METRO__.Story.finished) window.__METRO__.Story.skip();
  await sleep(600);

  /* ------------------------------------------------ A 搜索面板 */
  document.getElementById('citySearchBtn').click();
  await sleep(400);
  add('城市搜索面板可打开', document.getElementById('searchSheet').classList.contains('is-on'));
  const input = document.getElementById('citySearchInput');
  add('搜索输入框存在', !!input);

  /* ------------------------------------------------ B 本地优先 */
  input.value = '株洲';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  add('本地城市立即可见', rows().length >= 1 && rowText(rows()[0]).indexOf('株洲') >= 0, rowText(rows()[0]));

  /* ------------------------------------------------ C 高德行政区：搜到区县 */
  input.value = '雨湖';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(2200);
  const texts = rows().map(rowText);
  const districtRow = rows().filter(el => rowText(el).indexOf('雨湖') >= 0)[0];
  add('能搜到县级/区级行政区', !!districtRow, texts.join(' | ') || 'none');
  add('结果标注行政级别', !!districtRow && /区县|地级市|省级/.test(rowText(districtRow)), rowText(districtRow));

  /* ------------------------------------------------ D 选中后建城（GCJ→WGS 转换） */
  const before = M.snapshot();
  if (districtRow) districtRow.click();
  await sleep(1500);
  const after = M.snapshot();
  add('选中后切换到新城市', after.cityId !== before.cityId && after.cityName.indexOf('雨湖') >= 0,
    after.cityId + '/' + after.cityName);
  add('新城市按区县级别取景（zoom ≥ 12）', A.plan.view.zoom >= 12, A.plan.view.zoom);
  const center = A.plan.view.center;
  const amapGcj = [27.856115, 112.907334];            // 高德返回的雨湖区中心（GCJ-02）
  add('中心点落在雨湖区附近（1km 内）', meters(center, amapGcj) < 1000, Math.round(meters(center, amapGcj)) + 'm');
  add('存档坐标为 WGS84（已做 GCJ→WGS 转换）', meters(center, amapGcj) > 100, Math.round(meters(center, amapGcj)) + 'm 偏移');
  add('新城市进入编辑态以便布点', M.Edit.active === true, M.Edit.active);
  add('新城市出现在城市选择器里', Array.from(document.getElementById('citySelect').options)
    .some(o => o.textContent.indexOf('雨湖') >= 0),
    Array.from(document.getElementById('citySelect').options).map(o => o.textContent).join('|'));

  /* ------------------------------------------------ E 选中已存在的城市则直接切换 */
  M.Edit.exit();
  await sleep(400);
  document.getElementById('citySearchBtn').click();
  await sleep(300);
  const input2 = document.getElementById('citySearchInput');
  input2.value = '湘潭';
  input2.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(1600);
  const presetRow = rows().filter(el => rowText(el).indexOf('湘潭') >= 0 && /地级市|内置/.test(rowText(el)))[0];
  add('内置城市出现在搜索结果里', !!presetRow, rows().map(rowText).join(' | '));
  if (presetRow) presetRow.click();
  await sleep(1200);
  add('选中内置城市直接切换（不新建）', A.cityId === 'xiangtan' && A.plan.cityName === '湘潭',
    A.cityId + '/' + A.plan.cityName);
  add('切换到内置城市后正常播放', window.__METRO__.Story.playing === true || window.__METRO__.Story.finished === true,
    JSON.stringify(M.snapshot().story));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
