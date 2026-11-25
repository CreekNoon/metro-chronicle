(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story, C = M.Camera;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const map = A.map;

  /* ---------- A 架构检查：平移必须走纯 transform，不能每帧重投影 */
  let setViewCalls = 0;
  let rawPanCalls = 0;
  const origSetView = map.setView.bind(map);
  const origRawPan = map._rawPanBy.bind(map);
  map.setView = function () { setViewCalls += 1; return origSetView.apply(null, arguments); };
  map._rawPanBy = function () { rawPanCalls += 1; return origRawPan.apply(null, arguments); };

  if (!St.finished) St.skip();
  await sleep(600);

  add('存在帧性能采样器', !!M.Metrics && typeof M.Metrics.summary === 'function');
  add('线路延伸改用 canvas 渲染器', !!document.querySelector('.route-canvas'));
  add('已完成线路用 SVG 折线（绘制一次）',
    !!S.routes[A.plan.lines[0].key].main && typeof S.routes[A.plan.lines[0].key].main.setLatLngs === 'function');

  /* ---------- B 实跑：等第一条线真正开始延伸，稳定 2.5s 后按每秒窗口采样 */
  M.Metrics.reset();
  St.play();
  const waitStart = performance.now();
  while (!St.drawing && performance.now() - waitStart < 60000) await sleep(80);
  await sleep(2500);                       // 让首批瓦片加载完，测稳定态

  const setViewBefore = setViewCalls;
  const panBefore = rawPanCalls;
  const longBefore = M.Metrics.longFrames;
  const fBefore = M.Metrics.frames;
  const fpsWindows = [];
  let wFrames = M.Metrics.frames;
  let wStart = performance.now();
  let drawing = 0;
  while (performance.now() - waitStart < 90000) {
    await sleep(60);
    if (St.drawing) drawing += 1;
    if (performance.now() - wStart >= 1000) {
      fpsWindows.push(((M.Metrics.frames - wFrames) * 1000) / (performance.now() - wStart));
      wFrames = M.Metrics.frames;
      wStart = performance.now();
      if (fpsWindows.length >= 5) break;
    }
  }
  const frames = M.Metrics.frames - fBefore;
  const sorted = fpsWindows.slice().sort((a, b) => a - b);
  const median = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : 0;
  const summary = M.Metrics.summary();
  const work = summary.workPerFrame || {};
  const workSum = Object.keys(work).reduce((acc, key) => acc + work[key], 0);

  add('采样时确实处在绘制阶段', drawing >= 20, drawing + ' 次采样');
  add('绘制阶段帧率中位数 ≥ 25fps（无 GPU 的无头环境合成瓦片上限约 40）', median >= 25,
    median + 'fps  窗口=' + sorted.map((v) => Math.round(v)).join('/'));
  add('每帧自有 JS 开销 < 1ms', workSum < 1, workSum.toFixed(3) + 'ms ' + JSON.stringify(work));
  add('平移走 transform（panBy/rawPan 次数远多于 setView）',
    rawPanCalls - panBefore > Math.max(1, setViewCalls - setViewBefore) * 5,
    'pan=' + (rawPanCalls - panBefore) + ' setView=' + (setViewCalls - setViewBefore));

  /* 参照组：隐藏底图瓦片后的帧率，证明瓶颈在浏览器合成底图而不是我们的图层 */
  const tilePane = map.getPane('tilePane');
  const tileEls = Array.from(tilePane.children);
  tileEls.forEach((el) => { el.style.display = 'none'; });
  M.Metrics.reset();
  const nf0 = M.Metrics.frames;
  const nt0 = performance.now();
  await sleep(2200);
  const nfps = Math.round(((M.Metrics.frames - nf0) * 1000) / (performance.now() - nt0));
  tileEls.forEach((el) => { el.style.display = ''; });
  add('去掉底图后自绘图层可达 ≥ 55fps（瓶颈不在自绘层）', nfps >= 55, nfps + 'fps');
  /* ---------- C 收尾：整段仍能正常完成 */
  St.skip();
  await sleep(800);
  add('跳过后可到达终态', St.finished === true);
  add('终态线路均已用 SVG 完整绘制',
    A.plan.lines.every((line, index) => {
      const route = S.routes[line.key];
      return route && route.main.getLatLngs().length > 1;
    }),
    A.plan.lines.map((line) => S.routes[line.key].main.getLatLngs().length).join('/'));
  add('canvas 已清空（无残留的半条线）',
    (() => {
      const canvas = document.querySelector('.route-canvas');
      if (!canvas) return true;
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, Math.min(64, canvas.width), Math.min(64, canvas.height)).data;
      return data.every((v) => v === 0);
    })(), 'corner pixels');

  map.setView = origSetView;
  map._rawPanBy = origRawPan;

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
