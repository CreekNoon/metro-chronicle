(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;

  if (!St.finished) St.skip();
  await sleep(500);

  const canvas = document.querySelector('.route-canvas');
  add('存在线路 canvas', !!canvas);
  const ctx = canvas && canvas.getContext('2d', { willReadFrequently: true });

  const alphaAt = (pt) => {
    const dpr = canvas.width / map.getSize().x;
    try {
      const d = ctx.getImageData(Math.round(pt.x * dpr), Math.round(pt.y * dpr), 1, 1).data;
      return d[3];
    } catch (e) { return -1; }
  };
  const headKey = () => {
    let key = null;
    let count = 0;
    Object.keys(S.routes).forEach((k) => {
      const el = S.routes[k].head.getElement();
      const op = el ? Number(getComputedStyle(el).opacity) : 0;
      if (op > 0.25) count += 1;
      if (op > 0.9) key = k;
    });
    return count === 1 ? key : null;
  };

  /* 播放到第一条线开始延伸 */
  St.play();
  const waitStart = performance.now();
  while (!St.drawing && performance.now() - waitStart < 40000) await sleep(80);
  await sleep(1500);

  const samples = [];
  let drewPixels = 0;
  let aligned = 0;
  for (let i = 0; i < 25 && !St.finished; i += 1) {
    await sleep(200);
    if (!St.drawing) continue;
    const key = headKey();
    if (!key) continue;
    const geo = S.geometries[key];
    if (!geo) continue;
    const head = S.routes[key].head.getLatLng();
    const headPt = map.latLngToContainerPoint(head);
    const size = map.getSize();
    if (headPt.x < 0 || headPt.y < 0 || headPt.x > size.x || headPt.y > size.y) continue;

    const headAlpha = alphaAt(headPt);
    const startLatLng = L.latLng(geo.render[0][0], geo.render[0][1]);
    const startPt = map.latLngToContainerPoint(startLatLng);
    const startVisible = startPt.x > 16 && startPt.y > 16 && startPt.x < size.x - 16 && startPt.y < size.y - 16;
    const startAlpha = startVisible ? alphaAt(startPt) : null;
    samples.push({ headAlpha, startAlpha, visible: startVisible });
    if (headAlpha > 0) drewPixels += 1;
    if (headAlpha > 0 && (!startVisible || startAlpha > 0)) aligned += 1;
  }

  add('采到足够的绘制样本', samples.length >= 5, samples.length + ' 次');
  add('头部位置一定有线路像素（线与点对齐）', samples.length > 0 && drewPixels === samples.length,
    drewPixels + '/' + samples.length + '  headAlpha=' + samples.map((s) => s.headAlpha).join(','));
  add('起点可见时起点也有像素（≥80%）', samples.length > 0 && aligned >= samples.length * 0.8,
    aligned + '/' + samples.length);
  add('canvas 覆盖整个视口（不会画到屏幕外）',
    (() => {
      const rect = canvas.getBoundingClientRect();
      const box = map.getContainer().getBoundingClientRect();
      return Math.abs(rect.left - box.left) <= 16 && Math.abs(rect.top - box.top) <= 16 &&
        Math.abs(rect.width - box.width) <= 2 && Math.abs(rect.height - box.height) <= 2;
    })(),
    (() => {
      const r = canvas.getBoundingClientRect();
      const b = map.getContainer().getBoundingClientRect();
      return [Math.round(r.left - b.left), Math.round(r.top - b.top), Math.round(r.width - b.width), Math.round(r.height - b.height)].join(',');
    })());

  /* 画完之后 canvas 必须清空，且 SVG 折线接管 */
  St.skip();
  await sleep(900);
  const key0 = A.plan.lines[0].key;
  add('跳过后 SVG 接管了完整路径', S.routes[key0].main.getLatLngs().length > 1,
    S.routes[key0].main.getLatLngs().length + ' 点');
  add('跳过后 canvas 已清空', (() => {
    const d = ctx.getImageData(0, 0, Math.min(48, canvas.width), Math.min(48, canvas.height)).data;
    return d.every((v) => v === 0);
  })());

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
