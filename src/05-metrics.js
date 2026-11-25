/* ==========================================================================
   05 · 帧性能采样（自测/调优用，不参与业务逻辑）
   —— 统计 rAF 帧间隔、长帧数量，以及每帧在相机/场景上实际花掉的毫秒数，
      用来验证"高帧率"是不是真的做到了，而不是靠肉眼感觉。
   ========================================================================== */

var Metrics = {
  frames: 0,
  fps: 60,
  worstFrame: 0,
  longFrames: 0,          // 超过 32ms（≈掉两帧）的帧数
  work: {},               // 各模块累计耗时（毫秒）
  workSamples: 0,
  lastTs: 0,
  window: [],
  maxWindow: 900,
  running: false,

  now: function () {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  },

  add: function (name, ms) {
    if (!isFiniteNumber(ms) || ms < 0) return;
    this.work[name] = (this.work[name] || 0) + ms;
  },

  start: function () {
    if (this.running || typeof requestAnimationFrame !== 'function') return;
    this.running = true;
    var self = this;
    var loop = function (ts) {
      if (self.lastTs) {
        var dt = ts - self.lastTs;
        if (dt > 0) {
          self.fps = self.fps * 0.9 + (1000 / dt) * 0.1;
          if (dt > self.worstFrame) self.worstFrame = dt;
          if (dt > 32) self.longFrames += 1;
          self.window.push(dt);
          if (self.window.length > self.maxWindow) self.window.shift();
        }
        self.workSamples += 1;
      }
      self.lastTs = ts;
      self.frames += 1;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },

  reset: function () {
    this.frames = 0;
    this.worstFrame = 0;
    this.longFrames = 0;
    this.work = {};
    this.workSamples = 0;
    this.window = [];
  },

  summary: function () {
    var sorted = this.window.slice().sort(function (a, b) { return a - b; });
    var pct = function (q) {
      if (!sorted.length) return 0;
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    };
    var work = {};
    var samples = Math.max(1, this.workSamples);
    Object.keys(this.work).forEach(function (key) {
      work[key] = +(this.work[key] / samples).toFixed(3);
    }, this);
    return {
      fps: +this.fps.toFixed(1),
      worstFrame: +this.worstFrame.toFixed(1),
      p50: +pct(0.5).toFixed(1),
      p95: +pct(0.95).toFixed(1),
      longFrames: this.longFrames,
      frames: this.frames,
      workPerFrame: work
    };
  }
};

Metrics.start();
