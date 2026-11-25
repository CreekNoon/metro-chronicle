(async () => {
  const M = window.__METRO__;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  add('存在视频导出模块', !!M.VideoExport);
  if (!M.VideoExport) return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });

  const V = M.VideoExport;
  const mime = V.available();
  add('浏览器支持录制 MP4（H.264）', typeof mime === 'string' && /mp4/.test(mime), mime);
  add('页面上有「导出视频」按钮', !!document.getElementById('videoBtn'));
  add('有录制进度提示容器', !!document.getElementById('videoStatus'));

  /* 录制 6 秒样本；顺便在录制过程中检查 canvas 真的画了东西 */
  let midSample = null;
  V.onProgress = function (seconds) {
    if (!midSample && seconds > 2 && V.canvas) {
      try {
        const probe = document.createElement('canvas');
        probe.width = 80;
        probe.height = 48;
        const pctx = probe.getContext('2d');
        pctx.drawImage(V.canvas, 0, 0, probe.width, probe.height);
        const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
        const seen = {};
        for (let i = 0; i < data.length; i += 4) {
          seen[data[i] + ',' + data[i + 1] + ',' + data[i + 2]] = true;
        }
        midSample = Object.keys(seen).length;
      } catch (err) {
        midSample = -1;
      }
    }
  };

  const result = await V.start({ width: 640, fps: 24, maxSeconds: 6, videoBitsPerSecond: 3000000 });
  V.onProgress = null;

  add('录制返回 MP4 类型', /video\/mp4/.test(result.mimeType), result.mimeType);
  add('产物体积合理（>50KB）', result.blob.size > 50 * 1024, Math.round(result.blob.size / 1024) + ' KB');
  add('绘制帧数充足', result.frames > 60, result.frames + ' 帧');

  const head = new Uint8Array(await result.blob.slice(0, 12).arrayBuffer());
  const boxType = String.fromCharCode(head[4], head[5], head[6], head[7]);
  add('MP4 容器头正确（ftyp）', boxType === 'ftyp', boxType);

  /* 浏览器自己能否解码这段 MP4 */
  const video = document.createElement('video');
  const url = URL.createObjectURL(result.blob);
  const meta = await new Promise((resolve) => {
    let done = false;
    video.onloadedmetadata = () => {
      if (done) return;
      done = true;
      resolve({ width: video.videoWidth, height: video.videoHeight, duration: Number(video.duration.toFixed(2)) });
    };
    video.onerror = () => {
      if (done) return;
      done = true;
      resolve({ error: 'decode failed' });
    };
    video.src = url;
    setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ error: 'timeout' });
    }, 8000);
  });
  URL.revokeObjectURL(url);

  add('MP4 可被浏览器解码', !meta.error, JSON.stringify(meta));
  add('分辨率符合导出设置', meta.width === result.width && meta.height === result.height,
    meta.width + 'x' + meta.height + ' vs ' + result.width + 'x' + result.height);
  add('时长与录制时长相符', Math.abs((meta.duration || 0) - result.seconds) < 2.5,
    (meta.duration || 0) + 's vs ' + result.seconds.toFixed(1) + 's');
  add('录制中的画面不是空白', midSample === -1 || midSample >= 8, midSample + ' 种颜色');

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks, sizeKB: Math.round(result.blob.size / 1024) });
})()
