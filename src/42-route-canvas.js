/* ==========================================================================
   42 · 线路延伸的 canvas 渲染器（高帧率关键）
   —— SVG 路径上做 dash 动画会每帧重绘整条路径的外接矩形，长线路直接把帧率打到
      15~25fps。这里把「正在延伸的那条线」改为 canvas 逐帧绘制：
      只描已揭示的那一段，成本 ∝ 已画长度；画完后一次性交还 SVG（只画一次）。
   ========================================================================== */

var RouteCanvas = {
  map: null,
  canvas: null,
  ctx: null,
  dpr: 1,
  activeKey: null,
  cache: {},          // 每个线路 key 的预投影点（按缩放层级缓存）

  init: function (map) {
    if (!map || this.canvas) return;
    var canvas = document.createElement('canvas');
    canvas.className = 'route-canvas';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    map.getPane('overlayPane').appendChild(canvas);
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    var self = this;
    map.on('resize', function () { self.resize(); });
    map.on('zoom', function () { self.cache = {}; });
  },

  resize: function () {
    if (!this.map || !this.canvas) return;
    var size = this.map.getSize();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(size.x * dpr));
    this.canvas.height = Math.max(1, Math.round(size.y * dpr));
    this.canvas.style.width = size.x + 'px';
    this.canvas.style.height = size.y + 'px';
    this.cache = {};
  },

  /** 预投影：同一缩放层级下只算一次，之后每帧零投影开销 */
  projected: function (key, geometry) {
    var zoom = this.map.getZoom();
    var cache = this.cache[key];
    if (cache && cache.zoom === zoom && cache.src === geometry.render) return cache;
    var map = this.map;
    var origin = map.getPixelOrigin();
    var raw = geometry.render;
    var pts = new Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) {
      var pp = map.project(L.latLng(raw[i][0], raw[i][1]), zoom).subtract(origin);
      pts[i] = [pp.x, pp.y];
    }
    cache = { zoom: zoom, src: raw, pts: pts };
    this.cache[key] = cache;
    return cache;
  },

  /** 让 canvas 始终盖住当前视口（平移时由 Camera.tick 调用） */
  syncPosition: function () {
    if (!this.canvas || !this.map) return;
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));
  },

  begin: function (key) {
    this.activeKey = key;
    this.clear();
  },

  clear: function () {
    if (!this.ctx || !this.canvas) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },

  /**
   * 绘制正在延伸的线路。
   * @param {string} key 线路 key
   * @param {object} geometry 渲染几何（render/cumulative/totalMeters）
   * @param {number} index 已完整走过的点下标
   * @param {Array} head 头部插值点（WGS84 lat/lng）
   * @param {object} style 线型样式（weight/glowWeight/casingWeight/颜色/dash）
   * @param {number} ratio 进度（0~1）
   */
  draw: function (key, geometry, index, head, style, ratio) {
    var ctx = this.ctx;
    var map = this.map;
    if (!ctx || !map) return;
    var t0 = (typeof Metrics !== 'undefined' && Metrics.now) ? Metrics.now() : 0;

    var cache = this.projected(key, geometry);
    var pts = cache.pts;
    var dpr = this.dpr;

    /*
     * 视口左上角在 layer 坐标系里的位置 = canvas 元素该放的位置；
     * 绘制时用 -topLeft 做平移，于是 layer 坐标点 p 正好落在 canvas 像素 (p - topLeft)。
     * （之前这里符号搞反过一次，线路会被画到屏幕外/错位）
     */
    var topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this.canvas, topLeft);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, -topLeft.x * dpr, -topLeft.y * dpr);

    var headPt = null;
    if (head) {
      var hp = map.project(L.latLng(head[0], head[1]), map.getZoom()).subtract(map.getPixelOrigin());
      headPt = [hp.x, hp.y];
    }

    var trace = function () {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i <= index && i < pts.length; i += 1) ctx.lineTo(pts[i][0], pts[i][1]);
      if (headPt) ctx.lineTo(headPt[0], headPt[1]);
    };

    var paint = function (weight, color, opacity, dash) {
      if (!(weight > 0)) return;
      trace();
      ctx.globalAlpha = opacity;
      ctx.lineWidth = weight;
      ctx.strokeStyle = color;
      ctx.lineCap = dash ? 'butt' : 'round';
      ctx.lineJoin = 'round';
      if (dash && ctx.setLineDash) ctx.setLineDash(dash); else if (ctx.setLineDash) ctx.setLineDash([]);
      ctx.stroke();
      if (ctx.setLineDash) ctx.setLineDash([]);
    };

    paint(style.glowWeight, style.color, style.glowOpacity, null);
    paint(style.casingWeight, '#ffffff', 0.96, null);
    paint(style.weight, style.color, 1, style.dash ? [9, 6] : null);
    ctx.globalAlpha = 1;

    if (t0 && typeof Metrics !== 'undefined' && Metrics.add) Metrics.add('canvas', Metrics.now() - t0);
  },

  /** 线路画完：清掉 canvas，交给 SVG 的完整路径 */
  finish: function () {
    this.activeKey = null;
    this.clear();
  },

  reset: function () {
    this.activeKey = null;
    this.cache = {};
    this.clear();
  }
};
