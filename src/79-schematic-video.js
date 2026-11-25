/* ==========================================================================
   79 · 示意图的逐帧确定性视频导出
   —— 与「实时录屏式」导出不同：时间轴被暂停后按固定步长精确 seek（每帧严格
      对应 t = i / fps），再把当前状态画进 canvas。渲染一帧只需几毫秒，
      所以不会因为浏览器掉帧而丢内容；分辨率与屏幕无关，可出 1080p / 4K。
   ========================================================================== */

var SCHEMATIC_VIDEO = {
  width: 1920,
  height: 1080,
  fps: 30,
  bitrate: 12000000,
  background: '#f4f6f8'
};

var SchematicVideo = {
  canvas: null,
  ctx: null,
  recorder: null,
  chunks: [],
  mimeType: '',

  /** 当前环境是否支持录制 */
  available: function () {
    if (typeof MediaRecorder === 'undefined') return false;
    if (!HTMLCanvasElement.prototype || !HTMLCanvasElement.prototype.captureStream) return false;
    var types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9'];
    for (var i = 0; i < types.length; i += 1) {
      try { if (MediaRecorder.isTypeSupported(types[i])) return types[i]; } catch (err) { /* noop */ }
    }
    return false;
  },

  /**
   * 导出示意图视频。
   * @param {object} options { width, height, fps, maxSeconds, onProgress }
   * @returns {Promise<{blob: Blob, mimeType: string, frames: number, seconds: number}>}
   */
  export: function (options) {
    var self = this;
    var opts = Object.assign({}, SCHEMATIC_VIDEO, options || {});
    var mime = this.available();
    if (!mime) return Promise.reject(new Error('当前浏览器不支持视频录制'));
    if (typeof Schematic === 'undefined' || !Schematic.layout) return Promise.reject(new Error('请先进入示意图视图'));

    var width = Math.round(opts.width);
    var height = Math.round(opts.height);
    var fps = Math.max(10, Math.min(60, Math.round(opts.fps)));

    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.chunks = [];
    this.mimeType = mime;

    /* 1) 让时间轴回到起点并暂停：后面完全由我们逐帧 seek */
    Schematic.skip();                 // 先落到已知终态
    Schematic.replay();               // 重建时间轴
    var tl = Schematic.timeline;
    if (!tl) return Promise.reject(new Error('示意图时间轴不可用'));
    tl.pause(0);
    Schematic.lastSeek = 0;

    var total = tl.duration();
    var limit = opts.maxSeconds > 0 ? Math.min(opts.maxSeconds, total) : total;
    var frames = Math.max(1, Math.round(limit * fps));

    /* 2) 录制：captureStream(0) + requestFrame，一帧一帧喂 */
    var stream = this.canvas.captureStream(0);
    var track = stream.getVideoTracks()[0];
    this.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate });

    return new Promise(function (resolve, reject) {
      var settled = false;
      var finish = function (error) {
        if (settled) return;
        settled = true;
        if (error) { reject(error); return; }
        resolve({
          blob: new Blob(self.chunks, { type: mime.split(';')[0] }),
          mimeType: mime,
          frames: frames,
          seconds: frames / fps,
          width: width,
          height: height
        });
      };

      self.recorder.ondataavailable = function (event) {
        if (event.data && event.data.size) self.chunks.push(event.data);
      };
      self.recorder.onerror = function (event) { finish(event && event.error ? event.error : new Error('录制失败')); };
      self.recorder.onstop = function () { finish(null); };

      try {
        self.recorder.start(200);
      } catch (err) {
        finish(err);
        return;
      }

      var index = 0;
      var drawNext = function () {
        if (index >= frames) {
          window.setTimeout(function () {
            try { self.recorder.stop(); } catch (err) { finish(err); }
          }, 350);
          return;
        }
        // 精确 seek：时间轴暂停后只更新到该时刻；镜头直接用目标值，保证同一 t 同一画面
        try {
          Schematic.seek(index / fps);
        } catch (err) { /* 时间轴边界忽略 */ }

        self.drawFrame(width, height);
        if (track && track.requestFrame) track.requestFrame();

        index += 1;
        if (opts.onProgress) opts.onProgress(index / frames, index);
        // 按真实节奏喂帧，保证输出时长正确；渲染本身远快于一帧时间
        window.setTimeout(drawNext, Math.max(4, 1000 / fps));
      };
      drawNext();
    });
  },

  /* --------------------------------------------------------------- 绘制 */

  drawFrame: function (width, height) {
    var ctx = this.ctx;
    var layout = Schematic.layout;
    if (!ctx || !layout) return;

    /* 背景 + 视口变换（与页面上的 CSS transform 等价） */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SCHEMATIC_VIDEO.background;
    ctx.fillRect(0, 0, width, height);

    var scale = width / (Schematic.root ? Schematic.root.getBoundingClientRect().width || width : width);
    var s = Schematic.scale * scale;
    var ox = Schematic.offset.x * scale;
    var oy = Schematic.offset.y * scale;
    ctx.setTransform(s, 0, 0, s, ox, oy);

    this.drawLines(ctx);
    this.drawStations(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawHud(ctx, width, height, scale);
  },

  /** 线路：按已揭示进度描边（与页面上的 dash 揭示一致） */
  drawLines: function (ctx) {
    var layout = Schematic.layout;
    var self = this;
    layout.lines.forEach(function (entry) {
      var state = Schematic.lines[entry.line.key];
      if (!state) return;
      var progress = typeof state.progress === 'number' ? state.progress : 0;
      if (progress <= 0) return;
      var style = lineTypeStyle(entry.line.type);
      var points = self.prefixPoints(entry, progress);
      if (points.length < 2) return;

      var stroke = function (width, color, alpha, dash) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (var i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
        ctx.globalAlpha = alpha;
        ctx.lineWidth = width;
        ctx.strokeStyle = color;
        ctx.lineCap = dash ? 'butt' : 'round';
        ctx.lineJoin = 'round';
        if (ctx.setLineDash) ctx.setLineDash(dash ? [14, 9] : []);
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      };

      stroke(style.glowWeight + 6, entry.line.color, 0.1, false);
      stroke(style.casingWeight + 4, '#ffffff', 0.95, false);
      stroke(style.weight + 2, entry.line.color, 1, !!style.dashArray);
    });
  },

  /** 取折线前 progress 比例的点集 */
  prefixPoints: function (entry, progress) {
    var points = entry.points;
    var target = entry.total * Math.max(0, Math.min(1, progress));
    var result = [];
    for (var i = 0; i < points.length; i += 1) {
      if (entry.cumulative[i] <= target) {
        result.push(points[i]);
        continue;
      }
      // 落在这一段中间：插值后收尾
      var prevCumulative = entry.cumulative[i - 1] || 0;
      var span = entry.cumulative[i] - prevCumulative;
      var t = span > 1e-6 ? (target - prevCumulative) / span : 0;
      var a = points[i - 1] || points[i];
      var b = points[i];
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      break;
    }
    return result;
  },

  /** 站点：圆环 + 多色换乘 + 站名 */
  drawStations: function (ctx) {
    var layout = Schematic.layout;
    var self = this;
    layout.order.forEach(function (key) {
      var state = Schematic.nodes[key];
      if (!state || state.state === 'hidden') return;
      var node = state.node;
      var colors = node.lineKeys.map(function (lineKey) {
        var line = Schematic.plan.lines.filter(function (item) { return item.key === lineKey; })[0];
        return line ? line.color : '#666';
      });
      var transfer = colors.length >= 2;
      var primary = colors[0] || '#666';

      ctx.globalAlpha = state.state === 'ghost' ? 0.05 : 0.1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = primary;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (transfer) {
        var step = (Math.PI * 2) / colors.length;
        for (var i = 0; i < colors.length; i += 1) {
          ctx.beginPath();
          ctx.arc(node.x, node.y, 7.5, i * step - Math.PI / 2, (i + 1) * step - Math.PI / 2 - 0.06);
          ctx.lineWidth = 3.8;
          ctx.strokeStyle = colors[i];
          ctx.lineCap = 'butt';
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(node.x, node.y, 6, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = primary;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, transfer ? 2.8 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      self.drawLabel(ctx, node, state.state);
    });
  },

  drawLabel: function (ctx, node, state) {
    var side = node.labelSide || 'bottom';
    var text = node.name;
    ctx.font = '500 17px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textBaseline = 'middle';
    var gap = 20;
    var x = node.x;
    var y = node.y;
    if (side === 'bottom') { ctx.textAlign = 'center'; y += gap; }
    else if (side === 'top') { ctx.textAlign = 'center'; y -= gap; }
    else if (side === 'left') { ctx.textAlign = 'right'; x -= gap; }
    else { ctx.textAlign = 'left'; x += gap; }

    ctx.lineWidth = 4.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = state === 'ghost' ? '#7b838d' : '#232932';
    ctx.fillText(text, x, y);
  },

  /** HUD：日期胶囊 / 线路名 / 统计 / 署名（按画布尺寸等比放大） */
  drawHud: function (ctx, width, height, scale) {
    var get = function (id) {
      var el = document.getElementById(id);
      return el ? String(el.textContent || '').trim() : '';
    };
    var k = Math.max(1, width / 1280);
    var roundRect = function (x, y, w, h, r) {
      var radius = Math.min(r, h / 2, w / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    };

    var date = get('dateText');
    if (date) {
      ctx.font = '600 ' + Math.round(30 * k) + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      var dateWidth = ctx.measureText(date).width + 60 * k;
      var capsuleH = 64 * k;
      ctx.fillStyle = '#101317';
      roundRect(42 * k, 38 * k, dateWidth, capsuleH, capsuleH / 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(date, 42 * k + 30 * k, 38 * k + capsuleH / 2);
    }

    var name = get('lineName');
    var status = get('lineStatus');
    if (name) {
      var y2 = 140 * k;
      var badgeColor = (Schematic.focusColor || '#e60012');
      ctx.beginPath();
      ctx.arc(58 * k, y2 - 8 * k, 9 * k, 0, Math.PI * 2);
      ctx.fillStyle = badgeColor;
      ctx.fill();
      ctx.font = '600 ' + Math.round(26 * k) + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = '#12161b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, 82 * k, y2 - 8 * k);
      if (status) {
        ctx.font = '400 ' + Math.round(18 * k) + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#5b636e';
        ctx.fillText(status, 82 * k + ctx.measureText(name).width + 26 * k, y2 - 8 * k);
      }
    }

    var lines = get('statLines');
    var stations = get('statStations');
    var km = get('statKm');
    if (lines || stations) {
      var text = '线路 ' + (lines || '0') + '  ·  车站 ' + (stations || '0') + (km && km !== '—' ? '  ·  ' + km + ' km' : '');
      ctx.font = '500 ' + Math.round(20 * k) + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      var textWidth = ctx.measureText(text).width + 48 * k;
      var boxH = 56 * k;
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      roundRect(42 * k, height - boxH - 48 * k, textWidth, boxH, boxH / 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(18,22,27,0.08)';
      ctx.lineWidth = 1;
      roundRect(42 * k, height - boxH - 48 * k, textWidth, boxH, boxH / 2);
      ctx.stroke();
      ctx.fillStyle = '#2b3138';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 42 * k + 24 * k, height - boxH / 2 - 48 * k);
    }

    var credit = get('credit');
    if (credit) {
      ctx.font = '400 ' + Math.round(16 * k) + 'px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(18,22,27,0.42)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(credit, width - 40 * k, height - 30 * k);
    }
    void scale;
  }
};
