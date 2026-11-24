(async () => {
  const M = window.__METRO__;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  while (!M.Story.finished) await sleep(120);

  // 关掉矢量层，只留栅格；再切两次城市，观察 console 是否仍有 maplibre warning
  M.Basemap.destroyVector();
  M.Basemap.setMode('raster', 'wgs84');
  const sel = document.getElementById('citySelect');
  for (const id of ['xiangtan', 'zhuzhou']) {
    sel.value = id;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2000);
  }
  return JSON.stringify({ mode: M.Basemap.mode, vectorMap: !!M.Basemap.vectorMap, cityId: M.App.cityId });
})()
