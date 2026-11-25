(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const S = M.Schematic;
  const SV = M.SchematicVideo;
  add('示意图引擎在跑', !!S && !!S.root, M.engineNow ? M.engineNow() : 'n/a');
  add('存在逐帧视频导出模块', !!SV && typeof SV.export === 'function');
  if (!S || !S.root || !SV) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  const mime = SV.available();
  add('支持逐帧渲染出 MP4（H.264）', typeof mime === 'string' && /mp4/.test(mime), mime);

  /* ---------- A 逐帧渲染的确定性：同一时间点重复 seek 必须得到同样画面 ---------- */
  S.skip();
  S.replay();
  if (S.timeline) S.timeline.pause(0);

  const probe = document.createElement('canvas');
  probe.width = 640;
  probe.height = 360;
  const probeCtx = probe.getContext('2d');
  SV.canvas = probe;
  SV.ctx = probeCtx;

  const hashAt = (time) => {
    S.seek(time);
    SV.drawFrame(640, 360);
    const data = probeCtx.getImageData(0, 0, 640, 360).data;
    let hash = 0;
    let drawn = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4 * 11) {
      const isBg = Math.abs(data[i] - 244) < 6 && Math.abs(data[i + 1] - 246) < 6 && Math.abs(data[i + 2] - 248) < 6;
      if (!isBg) drawn += 1;
      total += 1;
      hash = (hash + data[i] * 3 + data[i + 1] * 5 + data[i + 2] * 7) % 1000003;
    }
    return { hash, ratio: drawn / total, revealed: Object.keys(S.nodes).filter((k) => S.nodes[k].state !== 'hidden').length };
  };

  const duration = S.timeline ? S.timeline.duration() : 0;
  add('时间轴可选时长', duration > 10, duration.toFixed(1) + 's');

  const t8a = hashAt(8);
  const t14 = hashAt(14);
  const t14b = hashAt(14);
  const t8b = hashAt(8);
  add('同一时间点重复渲染像素完全一致', t14.hash === t14b.hash, t14.hash + ' / ' + t14b.hash);
  add('倒退 seek 后画面也能复现', t8a.hash === t8b.hash, t8a.hash + ' / ' + t8b.hash);
  add('倒退 seek 后站点状态同步复位', t8a.revealed === t8b.revealed, t8a.revealed + ' / ' + t8b.revealed);
  add('帧内容随进度变化（不是空画面）', t14.ratio > 0.05 && t14.ratio !== t8a.ratio,
    't8=' + (t8a.ratio * 100).toFixed(1) + '% t14=' + (t14.ratio * 100).toFixed(1) + '%');

  /* ---------- B 4K 画布也能渲染（分辨率与屏幕无关） ---------- */
  const big = document.createElement('canvas');
  big.width = 3840;
  big.height = 2160;
  const bigCtx = big.getContext('2d');
  SV.canvas = big;
  SV.ctx = bigCtx;
  let bigOk = true;
  try {
    S.seek(14);
    SV.drawFrame(3840, 2160);
    const sample = bigCtx.getImageData(1920, 1080, 8, 8).data;
    bigOk = sample.length === 256;
  } catch (err) {
    bigOk = false;
  }
  add('3840×2160 画布可正常渲染', bigOk, bigOk ? 'ok' : 'failed');

  /* ---------- C 真正导出一段 MP4 ---------- */
  SV.canvas = null;
  SV.ctx = null;
  const result = await SV.export({ width: 640, height: 360, fps: 24, maxSeconds: 5 });
  add('导出返回 MP4', /video\/mp4/.test(result.mimeType), result.mimeType);
  add('帧数 = 时长 × fps', result.frames === 5 * 24, result.frames + ' 帧');
  add('产物体积合理（每秒钟 >3KB）', result.blob.size / 5 > 3 * 1024, Math.round(result.blob.size / 1024) + ' KB / ' + (result.blob.size / 5 / 1024).toFixed(1) + ' KB/s');

  const head = new Uint8Array(await result.blob.slice(0, 12).arrayBuffer());
  add('MP4 容器头正确（ftyp）', String.fromCharCode(head[4], head[5], head[6], head[7]) === 'ftyp');

  const video = document.createElement('video');
  const url = URL.createObjectURL(result.blob);
  const meta = await new Promise((resolve) => {
    let done = false;
    video.onloadedmetadata = () => {
      if (done) return;
      done = true;
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: Number(video.duration.toFixed(2)) });
    };
    video.onerror = () => { if (!done) { done = true; resolve({ error: 'decode failed' }); } };
    video.src = url;
    setTimeout(() => { if (!done) { done = true; resolve({ error: 'timeout' }); } }, 8000);
  });
  URL.revokeObjectURL(url);
  add('MP4 可被浏览器解码', !meta.error, JSON.stringify(meta));
  add('分辨率与导出设置一致', meta.width === 640 && meta.height === 360, meta.width + 'x' + meta.height);
  add('时长与设定一致（±1s）', Math.abs((meta.duration || 0) - 5) <= 1, (meta.duration || 0) + 's');

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
