/* ==========================================================================
   92 · 视频导出（页内直接产出 MP4）
   —— 用 Chrome 的 MediaRecorder（video/mp4;codecs=avc1）录制一块自绘 canvas：
      底图瓦片 + 线路 + 站点 + HUD 全部按当前状态重绘，因此不依赖 DOM 截图，
      也不需要在机器上安装 FFmpeg。
   ========================================================================== */

var VideoExport = {
  running: false,
  canvas: null,
  ctx: null,
  recorder: null,
  chunks: [],
  rafId: 0,
  options: { width: 1280, fps: 30, videoBitsPerSecond: 8000000 },
  startedAt: 0,
  frameCount: 0,
  onProgress: null,
  mimeType: '',

  /** 浏览器是否支持直接录 MP4 */
  available: function () {
    if (typeof MediaRecorder === 'undefined') return false;
    if (typeof HTMLCanvasElement === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return false;
    var types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
    for (var i = 0; i < types.length; i += 1) {
      try {
        if (MediaRecorder.isTypeSupported(types[i])) return types[i];
      } catch (err) { /* noop */ }
    }
    return false;
  },

  /**
   * 录制一段视频。
   * @param {object} options { width, fps, videoBitsPerSecond, maxSeconds }
   * @returns {Promise<{blob: Blob, mimeType: string, seconds: number, frames: number}>}
   */
  start: function (options) {
    var self = this;
    if (this.running) return Promise.reject(new Error('已经在导出中'));
    var mime = this.available();
    if (!mime) return Promise.reject(new Error('当前浏览器不支持 MediaRecorder 录制'));

    var opts = Object.assign({}, this.options, options || {});
    var map = App.map;
    if (!map) return Promise.reject(new Error('地图尚未初始化'));

    var container = map.getContainer();
    var width = Math.round(opts.width);
    var height = Math.round((width * container.clientHeight) / Math.max(1, container.clientWidth));
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.mimeType = mime;
    this.chunks = [];
    this.frameCount = 0;
    this.running = true;
    this.startedAt = performance.now();

    var stream = this.canvas.captureStream(opts.fps);
    this.recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: opts.videoBitsPerSecond
    });
    this.recorder.ondataavailable = function (event) {
      if (event.data && event.data.size) self.chunks.push(event.data);
    };

    return new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function (error) {
        if (settled) return;
        settled = true;
        self.stopLoop();
        self.running = false;
        if (error) { reject(error); return; }
        var blob = new Blob(self.chunks, { type: mime.split(';')[0] });
        resolve({
          blob: blob,
          mimeType: mime,
          seconds: (performance.now() - self.startedAt) / 1000,
          frames: self.frameCount,
          width: width,
          height: height
        });
      };

      self.recorder.onerror = function (event) { finish(event && event.error ? event.error : new Error('录制失败')); };
      self.recorder.onstop = function () { finish(null); };

      try {
        self.recorder.start(250);
      } catch (err) {
        finish(err);
        return;
      }

      // 从头播放，一边播一边把画面重绘进 canvas
      Story.replay();
      self.startedAt = performance.now();
      self.maxSeconds = opts.maxSeconds || 0;

      var draw = function () {
        if (!self.running) return;
        self.drawFrame();
        self.frameCount += 1;
        var elapsed = (performance.now() - self.startedAt) / 1000;
        if (self.onProgress) self.onProgress(elapsed, self.frameCount);
        if (Story.finished || (self.maxSeconds && elapsed >= self.maxSeconds)) {
          // 结尾多留 0.6s，避免最后一帧被判丢
          window.setTimeout(function () {
            try { self.recorder.stop(); } catch (err) { finish(err); }
          }, 600);
          return;
        }
        self.rafId = requestAnimationFrame(draw);
      };
      self.rafId = requestAnimationFrame(draw);
    });
  },

  stopLoop: function () {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  },

  /** 取消导出 */
  cancel: function () {
    if (!this.running) return;
    this.running = false;
    this.stopLoop();
    try { this.recorder.stop(); } catch (err) { /* noop */ }
  },

  /* ------------------------------------------------------------ 绘制 */

  drawFrame: function () {
    var ctx = this.ctx;
    var map = App.map;
    if (!ctx || !map) return;
    var container = map.getContainer();
    var cw = this.canvas.width;
    var ch = this.canvas.height;
    var scale = cw / Math.max(1, container.clientWidth);
    var origin = container.getBoundingClientRect();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#eef0f2';
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    this.drawTiles(ctx, origin);
    this.drawLines(ctx);
    this.drawStations(ctx);
    this.drawHud(ctx, container);
  },

  /** 底图：直接把已经在页面里的瓦片图搬进 canvas（离线包是 blob，不会污染画布） */
  drawTiles: function (ctx, origin) {
    var tiles = document.querySelectorAll('#map img.leaflet-tile-loaded');
    for (var i = 0; i < tiles.length; i += 1) {
      var img = tiles[i];
      if (!img.getAttribute('src')) continue;
      var rect = img.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      var x = rect.left - origin.left;
      var y = rect.top - origin.top;
      try {
        ctx.drawImage(img, x, y, rect.width, rect.height);
      } catch (err) { /* 单张瓦片失败不影响整体 */ }
    }
  },

  /** 线路：已开通的整线 + 正在绘制的前缀 */
  drawLines: function (ctx) {
    var map = App.map;
    var self = this;
    var plan = App.plan;
    if (!map || !plan) return;

    var toPoints = function (render, upTo) {
      var points = [];
      var limit = Math.min(render.length, upTo);
      for (var i = 0; i < limit; i += 1) {
        var pt = map.latLngToContainerPoint(L.latLng(render[i][0], render[i][1]));
        points.push([pt.x, pt.y]);
      }
      return points;
    };

    var stroke = function (points, width, color, opacity, dash) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (var i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
      ctx.globalAlpha = opacity;
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.lineCap = dash ? 'butt' : 'round';
      ctx.lineJoin = 'round';
      if (ctx.setLineDash) ctx.setLineDash(dash ? [9, 6] : []);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    };

    plan.lines.forEach(function (line) {
      var geometry = Scene.geometries[line.key];
      if (!geometry || !geometry.render.length) return;
      var style = lineTypeStyle(line.type);
      var route = Scene.routes[line.key];
      var active = !!(route && route.active);
      var progress = route ? clamp(route.progress === undefined ? (route.full ? 1 : 0) : route.progress, 0, 1) : 1;
      if (!active && route && route.progress !== undefined && route.progress < 1 && route.main.getLatLngs().length === 0) return;

      var cutoff = active ? cutIndexAt(geometry, progress) + 1 : geometry.render.length;
      var points = toPoints(geometry.render, cutoff);
      if (active) {
        var head = headPointAt(geometry, progress);
        if (head) {
          var hp = map.latLngToContainerPoint(L.latLng(head[0], head[1]));
          points.push([hp.x, hp.y]);
        }
      }
      if (points.length < 2) return;
      var dash = !!style.dashArray;
      stroke(points, style.glowWeight, line.color, style.glowOpacity, false);
      stroke(points, style.casingWeight, '#ffffff', 0.96, false);
      stroke(points, style.weight, line.color, 1, dash);
    });
  },

  /** 站点：已点亮的画圆点 + 站名 */
  drawStations: function (ctx) {
    var map = App.map;
    var self = this;
    Object.keys(Scene.stations).forEach(function (key) {
      var node = Scene.stations[key];
      if (!node || !node.revealed) return;
      var latlng = node.marker.getLatLng();
      var pt = map.latLngToContainerPoint(latlng);
      var colors = (node.lineKeys || []).map(function (lineKey) {
        var line = App.plan.lines.filter(function (item) { return item.key === lineKey; })[0];
        return line ? line.color : '#666';
      });
      var primary = colors[0] || '#666';
      var isTransfer = colors.length >= 2;

      // 光晕
      ctx.globalAlpha = node.state === 'ghost' ? 0.05 : 0.1;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 13, 0, Math.PI * 2);
      ctx.fillStyle = primary;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (isTransfer) {
        // 换乘：按线路数等分多色圆环
        var step = (Math.PI * 2) / colors.length;
        for (var i = 0; i < colors.length; i += 1) {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 6.4, i * step - Math.PI / 2, (i + 1) * step - Math.PI / 2 - 0.06);
          ctx.lineWidth = 3.2;
          ctx.strokeStyle = colors[i];
          ctx.lineCap = 'butt';
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
        ctx.lineWidth = 2.6;
        ctx.strokeStyle = primary;
        ctx.stroke();
      }

      // 中心白点
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isTransfer ? 2.4 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 站名
      var label = node.station.name;
      if (!label) return;
      var fontSize = 11.5;
      ctx.font = '500 ' + fontSize + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      var y = pt.y + 10;
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeText(label, pt.x, y);
      ctx.fillStyle = node.state === 'ghost' ? '#7b838d' : '#2b3138';
      ctx.fillText(label, pt.x, y);
    });
  },

  /** HUD：直接沿用页面上的文案，保证和时间轴完全一致 */
  drawHud: function (ctx, container) {
    var text = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.textContent || '').trim() : '';
    };
    var width = container.clientWidth;
    var height = container.clientHeight;
    var radius = 22;

    // 时间胶囊
    var date = text('dateText');
    if (date) {
      ctx.font = '500 19px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      var dateWidth = ctx.measureText(date).width + 40;
      ctx.fillStyle = '#101317';
      this.roundRect(ctx, 28, 26, dateWidth, 44, radius);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(date, 48, 49);
    }

    // 线路名 + 状态
    var name = text('lineName');
    var status = text('lineStatus');
    if (name) {
      var y = 92;
      var badgeColor = (document.getElementById('lineBadge') && getComputedStyle(document.getElementById('lineBadge')).backgroundColor) || '#e60012';
      ctx.beginPath();
      ctx.arc(38, y - 4, 6, 0, Math.PI * 2);
      ctx.fillStyle = badgeColor;
      ctx.fill();
      ctx.font = '500 16px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#12161b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, 52, y - 4);
      if (status) {
        ctx.font = '400 12px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#5b636e';
        ctx.fillText(status, 58 + ctx.measureText(name).width, y - 4);
      }
    }

    // 统计
    var lines = text('statLines');
    var stations = text('statStations');
    var km = text('statKm');
    if (lines || stations) {
      var stat = '线路 ' + (lines || '0') + '  ·  车站 ' + (stations || '0') + (km && km !== '—' ? '  ·  ' + km + ' km' : '');
      ctx.font = '500 13px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      var w = ctx.measureText(stat).width + 32;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      this.roundRect(ctx, 28, height - 74, w, 38, 19);
      ctx.fill();
      ctx.strokeStyle = 'rgba(18,22,27,0.08)';
      ctx.lineWidth = 1;
      this.roundRect(ctx, 28, height - 74, w, 38, 19);
      ctx.stroke();
      ctx.fillStyle = '#2b3138';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(stat, 44, height - 55);
    }

    // 右下角平台署名
    var credit = text('credit');
    if (credit) {
      ctx.font = '400 11px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(18,22,27,0.45)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(credit, width - 26, height - 22);
    }
  },

  roundRect: function (ctx, x, y, width, height, radius) {
    var r = Math.min(radius, height / 2, width / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
};
