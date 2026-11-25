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
  overviewPadding: 150,   // 全景留白（像素）
  focusGain: 2.2,         // 特写比例 A = 全景缩放 + 该值（再夹到下面区间）
  focusMin: 12.5,
  focusMax: 16,
  flyBack: 2.6,           // 线路画完后拉回全景的时长
  panoramaHold: 2.0,      // 全景停留（展示整条线路）
  lerpCenter: 0.26,       // 每帧向目标中心插值比例（跟拍更贴手）
  zoomDuration: 0.9,      // Leaflet 缩放动画兜底时长
  regridAfterPx: 1400,    // 累计平移超过该像素才重算一次瓦片网格（避免频繁卡顿）
  flight: 4.8             // 事件之间飞行时长（整体 0.5× 速度）
};

var Camera = {
  suspended: false,
  flying: false,          // 是否正在事件之间的弧线飞行
  active: false,           // 只有在播放（镜头叙事）期间才驱动视野
  running: false,
  panoramaZoom: 11,        // 全景比例（整张线网的适配缩放）
  focusZoom: 14,           // 特写比例 A：所有线路共用的同一个缩放
  state: { lat: 27.865, lng: 113.135, zoom: 11 },
  target: { lat: 27.865, lng: 113.135, zoom: 11 },
  flightTween: null,
  flightTimer: 0,
  panAcc: { x: 0, y: 0 },   // 亚像素位移累积
  moveAcc: 0,             // 距上次瓦片网格重算的累计位移

  /** 设定全景比例，并据此推出统一的特写比例 A */
  setPanorama: function (zoom) {
    this.panoramaZoom = clamp(isFiniteNumber(zoom) ? zoom : 11, 4, 17);
    this.focusZoom = clamp(this.panoramaZoom + CAMERA.focusGain, CAMERA.focusMin, CAMERA.focusMax);
    return this.focusZoom;
  },

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
    if (!this.active || this.suspended || Edit.active || this.flying) {
      this.syncFromMap();
      return;
    }

    var t0 = (typeof Metrics !== 'undefined' && Metrics.now) ? Metrics.now() : 0;
    var zoom = map.getZoom();
    var center = map.getCenter();
    var fromPx = map.project(center, zoom);
    var toPx = map.project(L.latLng(this.target.lat, this.target.lng), zoom);
    var dx = toPx.x - fromPx.x;
    var dy = toPx.y - fromPx.y;
    if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
      if (t0) Metrics.add('camera', Metrics.now() - t0);
      return;
    }

    // 每帧只挪剩余距离的一部分；亚像素位移累积，避免取整后慢速平移"卡住"
    this.panAcc.x += dx * CAMERA.lerpCenter;
    this.panAcc.y += dy * CAMERA.lerpCenter;
    var size = map.getSize();
    var limit = Math.max(48, Math.min(size.x, size.y) * 0.5);
    var rx = clamp(Math.round(this.panAcc.x), -limit, limit);
    var ry = clamp(Math.round(this.panAcc.y), -limit, limit);
    if (!rx && !ry) {
      if (t0) Metrics.add('camera', Metrics.now() - t0);
      return;
    }
    this.panAcc.x -= rx;
    this.panAcc.y -= ry;

    /*
     * 关键：用 Leaflet 的"原始平移"搬动画布，只改一个 transform。
     * 瓦片、站点、线路路径都在 mapPane 里，跟随 transform 一起移动，
     * 不需要重投影、不重建 SVG、不触发瓦片重算 —— 这是高帧率的来源。
     */
    map._rawPanBy(L.point(rx, ry));

    /*
     * 不逐帧（也不频繁）触发 move/moveend：每次 moveend 都会让瓦片层重算网格，
     * 实测一次重算就是几百毫秒的卡顿。改成"攒够位移再补一次"，
     * 配合瓦片层较大的 keepBuffer，整段跟拍几乎不触发重算。
     */
    this.moveAcc += Math.abs(rx) + Math.abs(ry);
    if (this.moveAcc >= CAMERA.regridAfterPx) {
      this.moveAcc = 0;
      map.fire('moveend');
    }

    this.state.lat = map.getCenter().lat;
    this.state.lng = map.getCenter().lng;
    this.state.zoom = zoom;
    if (t0) Metrics.add('camera', Metrics.now() - t0);
  },

  /* ------------------------------------------------------------ 目标设定 */

  /**
   * 预热「目标层级下会看到的整屏范围」的瓦片（±1 层）：
   * 视野越小/越大都按目标层级的实际视口算，换层动画结束时就已命中缓存。
   */
  prefetchForZoom: function (lat, lng, zoom) {
    if (typeof Basemap === 'undefined' || !Basemap.prefetch || !App.map) return;
    var map = App.map;
    var level = this.levelOf(zoom);
    var size = map.getSize();
    var degPerTile = 360 / Math.pow(2, level);
    var lngHalf = (size.x / 256) * degPerTile / 2;
    var latHalf = (size.y / 256) * degPerTile / 2 / Math.max(0.2, Math.cos(lat * Math.PI / 180));
    var pad = 1.12;
    var bounds = L.latLngBounds([
      [lat - latHalf * pad, lng - lngHalf * pad],
      [lat + latHalf * pad, lng + lngHalf * pad]
    ]);
    Basemap.prefetch(bounds, [level - 1, level, level + 1]);
  },

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
    var current = map.getZoom();
    if (Math.abs(current - level) > 0.01) {
      // 极少数情况（比如首帧）层级还没对上：走一次动画，不做硬切
      map.setView(L.latLng(center[0], center[1]), level, { animate: true, duration: CAMERA.zoomDuration });
      return;
    }
    map.setView(L.latLng(center[0], center[1]), current, { animate: false });
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

  /**
   * 单条线路的特写缩放：**所有线路共用同一个比例 A**（不再按各线包围盒各算一个），
   * 这样"拉进镜头—沿线展示—拉回全景—下一条线再拉进"的节奏完全一致。
   */
  lineZoom: function () {
    return this.focusZoom;
  },

  /** 线路画完后要回到的「全景视野」：整线中心 + 全景比例 */
  linePanoramaTarget: function (lineIndex) {
    var map = App.map;
    var line = App.plan && App.plan.lines ? App.plan.lines[lineIndex] : null;
    var geometry = line && Scene.geometries ? Scene.geometries[line.key] : null;
    if (!map || !geometry || !geometry.render.length) return null;
    var bounds = L.latLngBounds(geometry.render);
    if (!bounds.isValid()) return null;
    return { center: bounds.getCenter(), zoom: this.panoramaZoom };
  },

  /** 全网全览视野（与全景比例一致） */
  overviewTarget: function () {
    var map = App.map;
    if (!map) return null;
    var points = [];
    Object.keys(Scene.geometries || {}).forEach(function (key) {
      points = points.concat(Scene.geometries[key].render);
    });
    if (!points.length) return null;
    var bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return null;
    return { center: bounds.getCenter(), zoom: this.panoramaZoom };
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
    var level = this.levelOf(zoom);
    var self = this;

    // 一次动画完成「平移 + 缩放」：Leaflet 内部会连续缩放并拉伸旧瓦片，
    // 既不会有逐级顿挫，也不会出现换层空白
    this.prefetchForZoom(center[0], center[1], level);
    this.flying = true;
    this.target.lat = center[0];
    this.target.lng = center[1];
    this.target.zoom = level;
    killTweens(this.flightTween);
    window.clearTimeout(this.flightTimer);
    map.setView(L.latLng(center[0], center[1]), level, {
      animate: true,
      duration: duration
    });
    this.flightTimer = window.setTimeout(function () {
      self.flying = false;
      self.state.lat = center[0];
      self.state.lng = center[1];
      self.state.zoom = level;
    }, Math.max(150, duration * 1000 + 80));
    return null;
  },

  /** 统一把「取景缩放」落到整数层级（瓦片原生清晰） */
  levelOf: function (zoom) {
    return Math.floor(clamp(zoom, 4, 17) + 0.03);
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
