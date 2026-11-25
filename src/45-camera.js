/* ==========================================================================
   45 · 镜头（Camera）
   —— 让「正在延伸的线路」始终处于画面中央：
      目标视野由已绘制弧长反推（特写 → 全线），实际视野用 GSAP ticker 平滑逼近；
      缩放只在整数层级之间切换（瓦片始终原生清晰，避免逐帧换级造成的闪烁），
      事件之间用「先拉远、平移、再推近」的弧线飞行衔接，全部跑完再收束为全览。
   ========================================================================== */

var CAMERA = {
  minSpan: 2600,          // 最小视野跨度（米）
  maxSpan: 60000,         // 最大视野跨度（米）
  stationSpan: 1800,      // 单站开通的取景跨度（特写）
  linePadding: 96,        // 单线取景留白（像素）
  overviewPadding: 150,   // 全览留白（像素，比单线更大 → 全览一定比单线更远）
  zoomStep: 0.75,         // 换级滞回：只在事件之间换级，线路运行途中不改缩放
  lerpCenter: 0.18,       // 每帧向目标中心插值比例
  zoomDuration: 0.45,     // Leaflet 缩放动画时长（换层级时拉伸旧瓦片，不空白）
  panThresholdPx: 6,      // 中心变化超过该像素才重设视野（减少逐帧重排）
  flight: 2.7             // 事件之间飞行时长（整体 0.5× 速度）
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

  /**
   * 每帧推进：
   * 1) 中心用插值平滑逼近目标（纯平移，不换层级）；
   * 2) 缩放只按「整数层级」切换，并且交给 Leaflet 的缩放动画（动画期间它拉伸旧瓦片，
   *    换层时画面不空白 —— 这是避免闪烁的关键；逐帧小数缩放反而每次跨层都会闪）。
   */
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
    s.lat += (t.lat - s.lat) * kc;
    s.lng += (t.lng - s.lng) * kc;

    // 向下取整：四舍五入会把「刚好装下整条线」的取景放大一级，长线两端会被裁到画面外
    var targetLevel = Math.floor(clamp(t.zoom, 4, 17) + 0.03);
    var currentLevel = Math.round(map.getZoom());

    // 需要换层级：走 Leaflet 的缩放动画（动画中不叠加新的缩放，避免打架）
    if (targetLevel !== currentLevel) {
      if (map._animatingZoom) return;
      s.zoom = targetLevel;
      map.setView(L.latLng(s.lat, s.lng), targetLevel, {
        animate: true,
        duration: CAMERA.zoomDuration
      });
      return;
    }

    // 同层级：只平移（保留当前缩放，避免无谓重排）
    s.zoom = map.getZoom();
    var center = map.getCenter();
    var scale = 360 / (256 * Math.pow(2, map.getZoom()));
    var latRad = center.lat * Math.PI / 180;
    var px = Math.max(
      Math.abs(s.lng - center.lng) / scale,
      Math.abs(s.lat - center.lat) / (scale * Math.max(0.2, Math.cos(latRad)))
    );
    if (px < CAMERA.panThresholdPx) return;
    map.setView(L.latLng(s.lat, s.lng), map.getZoom(), { animate: false });
  },

  /* ------------------------------------------------------------ 目标设定 */

  /** 直接把当前视野吸附到目标（每个事件开画前对齐构图） */
  snapTo: function (center, zoom) {
    this.flying = false;
    var map = App.map;
    var z = clamp(zoom, 4, 17);
    var level = Math.floor(z + 0.03);      // 与 tick 一致：向下取整，保证整条线装得下
    this.state.lat = center[0];
    this.state.lng = center[1];
    this.state.zoom = level;
    this.target.lat = center[0];
    this.target.lng = center[1];
    this.target.zoom = z;
    if (!map) return;
    if (Math.round(map.getZoom()) === level) {
      // 层级没变：只对齐中心，不触发任何缩放重排
      map.setView(L.latLng(center[0], center[1]), map.getZoom(), { animate: false });
      return;
    }
    // 层级要变：同样走 Leaflet 缩放动画，避免换层瞬间空白
    map.setView(L.latLng(center[0], center[1]), level, {
      animate: true,
      duration: CAMERA.zoomDuration
    });
  },

  /** 直接把视图设为目标（带像素阈值），再让 state 吸附 */
  setView: function (center, zoom) {
    this.snapTo(center, zoom);
  },

  /** 用「包围盒 + 留白」求适配缩放（与全览同一套算法，只是留白更小） */
  fitZoom: function (points, padding) {
    var map = App.map;
    if (!map || !points || !points.length) return 11;
    var bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return 11;
    var zoom = map.getBoundsZoom(bounds, false, L.point(padding, padding));
    return clamp(zoom, 4, 17);
  },

  /** 单条线路的固定缩放：按该线包围盒取景，整条线路落在画面内 */
  lineZoom: function (lineIndex) {
    var line = App.plan && App.plan.lines ? App.plan.lines[lineIndex] : null;
    var geometry = line && Scene.geometries ? Scene.geometries[line.key] : null;
    if (!geometry || geometry.render.length < 2) return this.stationZoom();
    return this.fitZoom(geometry.render, CAMERA.linePadding);
  },

  /** 单站开通的固定缩放（特写） */
  stationZoom: function () {
    return this.zoomForSpan(CAMERA.stationSpan);
  },

  /**
   * 只平移、不改缩放：一条线路运行途中始终保持同一个缩放比例。
   * center 取「起点 → 头部」的中点，于是延伸中的线路始终横在画面中央。
   */
  panTo: function (centerPoint) {
    if (!App.map || Edit.active || this.suspended || !centerPoint) return;
    this.target.lat = centerPoint[0];
    this.target.lng = centerPoint[1];
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
    var dip = opts.dip === undefined ? clamp(distance / 34000, 0.15, 0.55) : opts.dip;
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

  /** 某一组经纬度点的适配视野（用于全览；留白比单线更大，因此一定比单线更远） */
  fitTarget: function (points) {
    var map = App.map;
    if (!map || !points.length) return null;
    var bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return null;
    return { center: bounds.getCenter(), zoom: this.fitZoom(points, CAMERA.overviewPadding) };
  },

  /** 用户手动缩放/复位：暂停自动跟拍，直到下一个事件 */
  suspend: function () {
    this.suspended = true;
  },

  resume: function () {
    this.suspended = false;
  }
};
