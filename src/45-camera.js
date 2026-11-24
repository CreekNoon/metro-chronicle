/* ==========================================================================
   45 · 镜头（Camera）
   —— 让「正在延伸的线路」始终处于画面中央：
      目标视野由已绘制弧长反推（特写 → 全线），实际视野用 GSAP ticker 平滑逼近；
      缩放只在整数层级之间切换（瓦片始终原生清晰，避免逐帧换级造成的闪烁），
      事件之间用「先拉远、平移、再推近」的弧线飞行衔接，全部跑完再收束为全览。
   ========================================================================== */

var CAMERA = {
  minSpan: 2600,          // 最小视野跨度（米）：特写也能看清相邻两站
  maxSpan: 60000,         // 最大视野跨度（米）：足够容下最长线路（城际 32km）
  spanFactor: 1.75,       // 视野跨度 = 已延伸距离 × 该系数
  zoomStep: 0.75,         // 目标 zoom 与当前差超过该值才换级（滞回，避免边界抖动）
  lerpCenter: 0.12,       // 每帧向目标中心插值比例（越小越"稳"）
  lerpZoom: 0.12,         // 每帧向目标 zoom 插值比例
  panThresholdPx: 3,      // 中心变化超过该像素才重设视野
  flight: 1.35            // 事件之间飞行时长
};

var Camera = {
  suspended: false,
  flying: false,          // 是否正在事件之间的弧线飞行
  active: false,           // 只有在播放（镜头叙事）期间才驱动视野
  running: false,
  state: { lat: 27.865, lng: 113.135, zoom: 11 },
  target: { lat: 27.865, lng: 113.135, zoom: 11 },
  flightTween: null,

  /** 启动平滑跟拍循环（全局只启动一次） */
  init: function () {
    if (this.running || !window.gsap) return;
    this.running = true;
    var self = this;
    gsap.ticker.add(function () { self.tick(); });
    this.syncFromMap();
  },

  syncFromMap: function () {
    var map = App.map;
    if (!map) return;
    var center = map.getCenter();
    this.state.lat = center.lat;
    this.state.lng = center.lng;
    this.state.zoom = map.getZoom();
    this.target.lat = center.lat;
    this.target.lng = center.lng;
    this.target.zoom = map.getZoom();
  },

  /** 让「跨度约 span 米」的区域铺满画面可用区域，反推出 zoom */
  zoomForSpan: function (spanMeters) {
    var map = App.map;
    if (!map) return 11;
    var size = map.getSize();
    var usable = Math.max(200, Math.min(size.x * 0.82, size.y * 0.70));
    var lat = map.getCenter().lat;
    var metersPerPixelAtZero = 156543.033928 * Math.cos(lat * Math.PI / 180);
    var zoom = Math.log2(metersPerPixelAtZero * usable / Math.max(spanMeters, 120));
    return clamp(zoom, 4, 17);
  },

  /* ------------------------------------------------------------ 每帧推进 */

  tick: function () {
    var map = App.map;
    if (!map) return;
    // 非镜头叙事期间（编辑、手动缩放、播放结束）不驱动视野，只保持同步
    if (!this.active || this.suspended || Edit.active) {
      this.syncFromMap();
      return;
    }
    var s = this.state;
    var t = this.target;
    var kc = CAMERA.lerpCenter;
    var kz = (t.zoom < s.zoom) ? 0.3 : CAMERA.lerpZoom;
    s.lat += (t.lat - s.lat) * kc;
    s.lng += (t.lng - s.lng) * kc;
    s.zoom += (t.zoom - s.zoom) * kz;

    // 瓦片始终落在整数层级：既清晰，也避免逐帧重取瓦片造成闪烁
    var appliedZoom = Math.round(clamp(s.zoom, 4, 17));
    var center = map.getCenter();
    var scale = 360 / (256 * Math.pow(2, appliedZoom));         // 每像素经度跨度
    var latRad = center.lat * Math.PI / 180;
    var px = Math.max(
      Math.abs(s.lng - center.lng) / scale,
      Math.abs(s.lat - center.lat) / (scale * Math.max(0.2, Math.cos(latRad)))
    );
    var zoomChanged = appliedZoom !== Math.round(map.getZoom());
    if (!zoomChanged && px < CAMERA.panThresholdPx) return;

    map.setView(L.latLng(s.lat, s.lng), appliedZoom, { animate: false });
  },

  /* ------------------------------------------------------------ 目标设定 */

  /** 直接把当前视野吸附到目标（用于每个事件开画前对齐构图，避免残差） */
  snapTo: function (center, zoom) {
    this.flying = false;
    var map = App.map;
    var z = clamp(zoom, 4, 17);
    this.state.lat = center[0];
    this.state.lng = center[1];
    this.state.zoom = z;
    this.target.lat = center[0];
    this.target.lng = center[1];
    this.target.zoom = z;
    if (map) map.setView(L.latLng(center[0], center[1]), Math.round(z), { animate: false });
  },

  /** 直接把视图设为目标（带像素阈值），再让 state 吸附 */
  setView: function (center, zoom) {
    this.snapTo(center, zoom);
  },

  /**
   * 跟拍「起点 → 头部」这一段：
   * 中心取两者中点，zoom 由跨度反推；带滞回，只有差距够大才换级。
   */
  frameSpan: function (startPoint, headPoint, factor) {
    if (!App.map || Edit.active || this.suspended) return;
    if (!startPoint || !headPoint) return;
    var start = L.latLng(startPoint[0], startPoint[1]);
    var head = L.latLng(headPoint[0], headPoint[1]);
    var distance = start.distanceTo(head);
    var span = clamp(distance * (factor || CAMERA.spanFactor), CAMERA.minSpan, CAMERA.maxSpan);
    var zoom = this.zoomForSpan(span);

    this.target.lat = (start.lat + head.lat) / 2;
    this.target.lng = (start.lng + head.lng) / 2;
    // 需要拉远时必须立刻跟上（否则延伸路径会冲出画面）；
    // 需要推近时才用滞回，避免层级来回抖
    if (zoom < this.target.zoom - 0.05) this.target.zoom = zoom;
    else if (zoom > this.target.zoom + CAMERA.zoomStep) this.target.zoom = zoom;
  },

  /** 直接飞到某个视野（弧线：平移同时先拉远再推近） */
  flyTo: function (center, zoom, options) {
    var map = App.map;
    if (!map) return null;
    var opts = options || {};
    var duration = opts.duration === undefined ? CAMERA.flight : opts.duration;
    var from = { lat: this.target.lat, lng: this.target.lng, zoom: this.target.zoom };
    var to = { lat: center[0], lng: center[1], zoom: zoom };
    var distance = L.latLng(from.lat, from.lng).distanceTo(L.latLng(to.lat, to.lng));
    var dip = opts.dip === undefined ? clamp(distance / 16000, 0.3, 1.6) : opts.dip;
    var self = this;
    var proxy = { t: 0 };
    killTweens(proxy);
    if (this.flightTween) killTweens(this.flightTween);
    this.flightTween = proxy;
    this.flying = true;
    return gsap.to(proxy, {
      t: 1,
      duration: duration,
      ease: opts.ease || 'power2.inOut',
      onComplete: function () { self.flying = false; },
      onUpdate: function () {
        var k = proxy.t;
        self.target.lat = from.lat + (to.lat - from.lat) * k;
        self.target.lng = from.lng + (to.lng - from.lng) * k;
        self.target.zoom = from.zoom + (to.zoom - from.zoom) * k - dip * Math.sin(Math.PI * k);
      }
    });
  },

  /** 某一组经纬度点的适配视野（用于全览） */
  fitTarget: function (points) {
    var map = App.map;
    if (!map || !points.length) return null;
    var bounds = L.latLngBounds(points);
    var size = map.getSize();
    var zoom = Math.min(
      map.getBoundsZoom(bounds, false, L.point(120, 150)),
      this.zoomForSpan(L.latLng(bounds.getNorthWest()).distanceTo(L.latLng(bounds.getSouthEast())))
    );
    return { center: bounds.getCenter(), zoom: clamp(zoom, 4, 17) };
  },

  /** 用户手动缩放/复位：暂停自动跟拍，直到下一个事件 */
  suspend: function () {
    this.suspended = true;
  },

  resume: function () {
    this.suspended = false;
  }
};
