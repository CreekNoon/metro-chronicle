/* ==========================================================================
   45 · 镜头（Camera）
   —— 让「正在延伸的线路」始终处于画面中央：视野跨度由已绘制的弧长反推，
      连续拉远 → 像镜头特写逐步收束到全线；事件之间用「先拉远、平移、再推近」
      的弧线飞行衔接，全部跑完后再收束为全览。
   ========================================================================== */

var CAMERA = {
  minSpan: 2500,         // 最小视野跨度（米）：特写也能看清相邻两站
  maxSpan: 16000,        // 最大视野跨度（米）
  spanFactor: 1.7,       // 视野跨度 = 已延伸距离 × 该系数
  drawIn: 0.85,          // 事件之间的飞行时长
  holdEnd: 0.22          // 到达终点后的停留
};

var Camera = {
  suspended: false,        // 用户手动缩放后暂停自动跟拍，直到下一个事件
  lastCenter: null,
  lastZoom: null,

  /** 让「跨度约 span 米」的区域铺满画面可用区域，反推出 zoom */
  zoomForSpan: function (spanMeters) {
    var map = App.map;
    if (!map) return 11;
    var size = map.getSize();
    var usable = Math.max(200, Math.min(size.x * 0.82, size.y * 0.70));
    var lat = map.getCenter().lat;
    var equatorMpp = 156543.033928;                       // zoom=0 时每像素米数（赤道）
    var metersPerPixelAtZero = equatorMpp * Math.cos(lat * Math.PI / 180);
    var zoom = Math.log2(metersPerPixelAtZero * usable / Math.max(spanMeters, 120));
    return clamp(zoom, 3, 17);
  },

  /** 直接设置视野（带像素级变化阈值：既保证平滑，又不至于把瓦片请求打爆） */
  setView: function (center, zoom) {
    var map = App.map;
    if (!map) return;
    var z = Math.round(clamp(zoom, 3, 17) * 10) / 10;      // 量化到 0.1，减少无意义的瓦片重取
    var cur = map.getCenter();
    var curZoom = map.getZoom();
    var scale = 360 / (256 * Math.pow(2, z));              // 每像素经度跨度
    var latRad = map.getCenter().lat * Math.PI / 180;
    var lerpX = scale;
    var lerpY = scale * Math.max(0.2, Math.cos(latRad));
    var pixels = Math.max(
      Math.abs(center.lng - cur.lng) / lerpX,
      Math.abs(center.lat - cur.lat) / lerpY
    );
    var zoomDelta = Math.abs(z - curZoom);
    if (pixels < 5 && zoomDelta < 0.12) return;
    map.setView(L.latLng(center.lat, center.lng), z, { animate: false });
    this.lastCenter = center;
    this.lastZoom = z;
  },

  /**
   * 跟拍「起点 → 头部」这一段：
   * 中心取两者中点，zoom 由跨度反推 —— 线路越长镜头越远，
   * 于是延伸中的线路始终横在画面中央。
   */
  frameSpan: function (startPoint, headPoint, factor) {
    if (!App.map || Edit.active || this.suspended) return;
    if (!startPoint || !headPoint) return;
    var start = L.latLng(startPoint[0], startPoint[1]);
    var head = L.latLng(headPoint[0], headPoint[1]);
    var mid = L.latLng((start.lat + head.lat) / 2, (start.lng + head.lng) / 2);
    var distance = start.distanceTo(head);
    var span = clamp(distance * (factor || CAMERA.spanFactor), CAMERA.minSpan, CAMERA.maxSpan);
    this.setView(mid, this.zoomForSpan(span));
  },

  /**
   * 弧线飞行：平移的同时先拉远再推近（dip 越大越明显）。
   * 用于「终点 → 下一条线路起点」的衔接。
   */
  flyTo: function (center, zoom, options) {
    var map = App.map;
    if (!map) return null;
    var opts = options || {};
    var duration = opts.duration === undefined ? CAMERA.drawIn : opts.duration;
    var from = { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() };
    var to = { lat: center[0], lng: center[1], zoom: zoom };
    var distance = L.latLng(from.lat, from.lng).distanceTo(L.latLng(to.lat, to.lng));
    var dip = opts.dip === undefined ? clamp(distance / 14000, 0.35, 1.9) : opts.dip;
    var self = this;
    var proxy = { t: 0 };
    killTweens(proxy);
    this.suspended = false;
    return gsap.to(proxy, {
      t: 1,
      duration: duration,
      ease: opts.ease || 'power2.inOut',
      onUpdate: function () {
        var t = proxy.t;
        var zoomNow = from.zoom + (to.zoom - from.zoom) * t - dip * Math.sin(Math.PI * t);
        self.setView(
          L.latLng(from.lat + (to.lat - from.lat) * t, from.lng + (to.lng - from.lng) * t),
          clamp(zoomNow, 3, 17)
        );
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
    return { center: bounds.getCenter(), zoom: clamp(zoom, 3, 17) };
  },

  /** 用户手动缩放：暂停自动跟拍，避免「越权」抢镜头 */
  suspend: function () {
    this.suspended = true;
  },

  resume: function () {
    this.suspended = false;
  }
};
