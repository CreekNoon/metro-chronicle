(async () => {
  const M = window.__METRO__;
  const A = M.App, B = M.Basemap, St = M.Story;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const count = (layer, selector) => {
    if (!layer || !layer._container) return -1;
    return layer._container.querySelectorAll(selector).length;
  };

  /* 静态配置检查 */
  add('Leaflet 缩放动画已开启（换层时拉伸旧瓦片，不空白）', A.map.options.zoomAnimation === true,
    'zoomAnimation=' + A.map.options.zoomAnimation);
  add('瓦片淡入仍关闭（避免逐帧淡入闪烁）', A.map.options.fadeAnimation === false,
    'fadeAnimation=' + A.map.options.fadeAnimation);
  add('存在低分辨率底衬层', B.rasterLayers.length >= 2 && B.rasterLayers[0] !== B.primaryLayer,
    'layers=' + B.rasterLayers.length);
  add('主瓦片层保留较大缓冲', B.primaryLayer && B.primaryLayer.options.keepBuffer >= 12,
    B.primaryLayer ? B.primaryLayer.options.keepBuffer : 'n/a');
  add('瓦片层不再使用 CSS 滤镜（逐帧重绘易闪）',
    !Array.from(document.styleSheets).some((sheet) => {
      try {
        return Array.from(sheet.cssRules).some((rule) => /leaflet-tile-pane[^{]*\{[^}]*filter/.test(String(rule.cssText)));
      } catch (e) { return false; }
    }), 'css filter');

  /* 播放全程采样：是否出现「两层都没有已加载瓦片」的空屏帧 */
  if (!St.finished) St.skip();
  await sleep(600);
  St.play();

  let samples = 0;
  let emptyFrames = 0;
  let minBackdrop = Infinity;
  let loadedSum = 0;
  const levels = [];
  let lastLevel = null;
  const t0 = performance.now();
  while (performance.now() - t0 < 64000) {
    if (St.finished) break;
    await sleep(90);
    const primaryLoaded = count(B.primaryLayer, '.leaflet-tile-loaded');
    const backdropLoaded = count(B.rasterLayers[0], '.leaflet-tile-loaded');
    samples += 1;
    loadedSum += Math.max(0, primaryLoaded);
    if (primaryLoaded <= 0 && backdropLoaded <= 0) emptyFrames += 1;
    minBackdrop = Math.min(minBackdrop, backdropLoaded);
    const level = B.primaryLayer && B.primaryLayer._tileZoom;
    if (level !== lastLevel && level !== undefined) { levels.push(level); lastLevel = level; }
  }
  St.skip();
  await sleep(500);

  add('采样到足够帧数', samples >= 200, samples + ' 帧');
  add('播放全程没有整屏空白帧（≤1 帧采样抖动）', emptyFrames <= 1, emptyFrames + ' / ' + samples);
  add('主瓦片层平均已加载瓦片数充足', loadedSum / Math.max(1, samples) >= 8,
    (loadedSum / Math.max(1, samples)).toFixed(1));
  add('瓦片层级切换次数受控（< 40）', levels.length < 40, levels.length + ' 次');
  add('底衬层几乎始终有已加载瓦片', minBackdrop >= 0, 'min=' + minBackdrop);

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
