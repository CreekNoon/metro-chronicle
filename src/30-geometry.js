/* ==========================================================================
   30 · 几何与坐标系
   - 里程：WGS84 经纬度上的 Haversine 累加（平滑曲线的实际长度）
   - 平滑：向心 Catmull-Rom 样条（避免尖锐折角，也不会像均匀样条那样打圈）
   - 坐标系：内部一律 WGS84；仅在渲染高德底图时投影到 GCJ-02
   ========================================================================== */

var EARTH_RADIUS_M = 6371008.8;         // 地球平均半径（米）
var DEG_TO_RAD = Math.PI / 180;
var SPLINE_SEGMENT_SAMPLES = 20;        // 每两点之间的采样数（平滑度 / 性能折中）

/** 两点球面距离（米）。入参 [lat, lng] */
function haversineMeters(a, b) {
  var lat1 = a[0] * DEG_TO_RAD;
  var lat2 = b[0] * DEG_TO_RAD;
  var dLat = lat2 - lat1;
  var dLng = (b[1] - a[1]) * DEG_TO_RAD;
  var sinLat = Math.sin(dLat / 2);
  var sinLng = Math.sin(dLng / 2);
  var h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(Math.max(0, h))));
}

/** 折线总长（米）；坐标重合时安全返回 0，不会产生 NaN */
function polylineLengthMeters(points) {
  var total = 0;
  for (var i = 1; i < points.length; i += 1) {
    var step = haversineMeters(points[i - 1], points[i]);
    if (isFinite(step)) total += step;
  }
  return total;
}

/* ------------------------------------------------------- 向心 Catmull-Rom */

function crDistance(p, q) {
  var dx = q[1] - p[1];
  var dy = q[0] - p[0];
  var d = Math.sqrt(dx * dx + dy * dy);
  return d > 1e-12 ? d : 1e-12;   // 重叠点保护：避免除以 0 产生 NaN
}

function crLerp(p, q, t) {
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Barry–Goldman 金字塔形式求 P1→P2 之间 t∈[0,1] 的样条点（alpha = 0.5） */
function catmullRomPoint(p0, p1, p2, p3, t) {
  var t0 = 0;
  var t1 = t0 + Math.sqrt(crDistance(p0, p1));
  var t2 = t1 + Math.sqrt(crDistance(p1, p2));
  var t3 = t2 + Math.sqrt(crDistance(p2, p3));
  var tt = t1 + (t2 - t1) * t;

  var a1 = crLerp(p0, p1, (tt - t0) / (t1 - t0));
  var a2 = crLerp(p1, p2, (tt - t1) / (t2 - t1));
  var a3 = crLerp(p2, p3, (tt - t2) / (t3 - t2));
  var b1 = crLerp(a1, a2, (tt - t0) / (t2 - t0));
  var b2 = crLerp(a2, a3, (tt - t1) / (t3 - t1));
  return crLerp(b1, b2, (tt - t1) / (t2 - t1));
}

/**
 * 把站点序列平滑成折线，并记录每个站点在折线上的下标。
 * 少于 2 点或全部重合时返回退化结果（不抛错）。
 */
function buildSmoothPath(points) {
  var count = points.length;
  if (count < 2) {
    return { points: points.slice(), stationIndex: points.map(function (_, i) { return i; }) };
  }

  var out = [];
  var stationIndex = [];

  for (var i = 0; i < count - 1; i += 1) {
    var p0 = points[Math.max(0, i - 1)];
    var p1 = points[i];
    var p2 = points[i + 1];
    var p3 = points[Math.min(count - 1, i + 2)];
    stationIndex.push(out.length);
    for (var s = 0; s < SPLINE_SEGMENT_SAMPLES; s += 1) {
      out.push(catmullRomPoint(p0, p1, p2, p3, s / SPLINE_SEGMENT_SAMPLES));
    }
  }
  out.push([points[count - 1][0], points[count - 1][1]]);
  stationIndex.push(out.length - 1);

  return { points: out, stationIndex: stationIndex };
}

/**
 * 线路几何：把站点纬经度合成为可渲染折线 + 累计里程 + 各站弧长占比。
 * 所有长度均基于 WGS84，切换底图不会改变里程。
 */
function buildLineGeometry(stations, projectPoint) {
  var wgsPoints = stations.map(function (station) { return [station.lat, station.lng]; });
  var smooth = buildSmoothPath(wgsPoints);
  var samples = smooth.points;

  var cumulative = new Array(samples.length);
  var total = 0;
  cumulative[0] = 0;
  for (var i = 1; i < samples.length; i += 1) {
    var step = haversineMeters(samples[i - 1], samples[i]);
    if (!isFinite(step) || step < 0) step = 0;
    total += step;
    cumulative[i] = total;
  }

  // 分母下限保护：所有站点重合时也不会出现 NaN（1e-6 米 ≈ 视觉上的同一个点）
  var safeTotal = Math.max(total, 1e-6);

  var stationRatio = smooth.stationIndex.map(function (index) {
    var value = cumulative[index] / safeTotal;
    return isFinite(value) ? clamp(value, 0, 1) : 0;
  });
  // 端点强制归零 / 归一，避免浮点误差导致末站永远不被点亮
  if (stationRatio.length) {
    stationRatio[0] = 0;
    stationRatio[stationRatio.length - 1] = 1;
  }

  var render = projectPoint
    ? samples.map(function (point) { return projectPoint(point[0], point[1]); })
    : samples.map(function (point) { return [point[0], point[1]]; });

  return {
    stations: stations,
    wgsPoints: wgsPoints,
    samples: samples,
    render: render,
    cumulative: cumulative,
    totalMeters: total,
    stationRatio: stationRatio
  };
}

/** 在折线上按弧长比例取点，返回 { head, latlngs }（latlngs 为已绘制部分） */
function sliceGeometryAt(geometry, ratio) {
  var p = clamp(isFinite(ratio) ? ratio : 0, 0, 1);
  var render = geometry.render;
  if (!render.length) return { head: null, latlngs: [] };

  if (p >= 1) {
    return { head: render[render.length - 1], latlngs: render.slice() };
  }

  var target = geometry.totalMeters * p;
  var cumulative = geometry.cumulative;
  var i = 0;
  while (i < cumulative.length - 2 && cumulative[i + 1] < target) i += 1;

  var segStart = cumulative[i];
  var segEnd = cumulative[i + 1];
  var denom = segEnd - segStart;
  var t = denom > 1e-9 ? (target - segStart) / denom : 1;
  t = clamp(t, 0, 1);

  var a = render[i];
  var b = render[i + 1] || a;
  var head = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  var latlngs = render.slice(0, i + 1);
  latlngs.push(head);
  return { head: head, latlngs: latlngs };
}

/** 统计一组站点的中心点（用于自定义城市的初始视野） */
function averageCenter(stations) {
  if (!stations.length) return null;
  var lat = 0;
  var lng = 0;
  stations.forEach(function (station) { lat += station.lat; lng += station.lng; });
  return [lat / stations.length, lng / stations.length];
}

/* ------------------------------------------------- 坐标轴对齐：标签避让 */

/**
 * 依据线路走向推导标签方向（top / bottom / left / right）：
 * 取该站局部切线的法线方向，标签放在线路“外侧”，避免压线。
 */
function autoLabelSide(points, index) {
  var total = points.length;
  if (total < 2) return 'bottom';

  var prev = points[Math.max(0, index - 1)];
  var next = points[Math.min(total - 1, index + 1)];
  var latMid = (prev[0] + next[0]) / 2;
  var dLat = next[0] - prev[0];
  var dLng = (next[1] - prev[1]) * Math.cos(latMid * DEG_TO_RAD);

  if (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) return 'bottom';

  // 法线：屏幕坐标系（x 向东、y 向北）
  var nx = -dLat;
  var ny = dLng;

  if (Math.abs(nx) >= Math.abs(ny)) return nx > 0 ? 'right' : 'left';
  return ny > 0 ? 'top' : 'bottom';
}

/* ------------------------------------------------ WGS84 ↔ GCJ-02 转换 */

var GCJ_A = 6378245.0;
var GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function gcjTransformLat(x, y) {
  var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function gcjTransformLng(x, y) {
  var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

/** WGS84 → GCJ-02（仅用于高德底图渲染） */
function wgs84ToGcj02(lat, lng) {
  if (!isValidLatLng(lat, lng) || outOfChina(lat, lng)) return [lat, lng];
  var dLat = gcjTransformLat(lng - 105.0, lat - 35.0);
  var dLng = gcjTransformLng(lng - 105.0, lat - 35.0);
  var radLat = lat / 180.0 * Math.PI;
  var magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  var sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

/** GCJ-02 → WGS84：迭代反解，误差 < 0.1m；用于把高德底图上的点还原成存储用的 WGS84 */
function gcj02ToWgs84(lat, lng) {
  if (!isValidLatLng(lat, lng) || outOfChina(lat, lng)) return [lat, lng];
  var guessLat = lat;
  var guessLng = lng;
  for (var i = 0; i < 4; i += 1) {
    var forward = wgs84ToGcj02(guessLat, guessLng);
    guessLat += lat - forward[0];
    guessLng += lng - forward[1];
  }
  return [guessLat, guessLng];
}
