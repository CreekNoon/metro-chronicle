(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const C = M.TileCache;

  add('存在瓦片缓存模块', !!C);
  await sleep(4000);
  const s = C.summary();
  add('缓存后端可用（indexedDB 或 memory）', s.backend === 'indexeddb' || s.backend === 'memory', s.backend);
  add('首次加载会把瓦片写入缓存', s.put >= 10, s.put + ' 张');
  add('瓦片确实显示出来了', document.querySelectorAll('.leaflet-tile-loaded').length > 10,
    document.querySelectorAll('.leaflet-tile-loaded').length + ' 张已加载');
  add('超时/失败次数很少', s.fail <= Math.max(4, s.miss * 0.3), 'fail=' + s.fail + ' miss=' + s.miss);

  if (s.backend !== 'indexeddb') {
    add('（内存后端：无法验证跨刷新缓存）', true, 'skipped');
    return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks, phase: 'first' });
  }
  window.__CACHE_BEFORE__ = s;
  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks, phase: 'first', stats: s });
})()
