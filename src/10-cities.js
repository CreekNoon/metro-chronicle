/* ==========================================================================
   10 · 数据层：线路类型 / 城市预设 / 方案（plan）规范化与持久化
   plan 结构：
   {
     cityId, cityName, view: { center:[lat,lng], zoom },
     lines: [{ key, badge, name, color, type, dateText, status, stations:[...] }]
   }
   line.type: 'metro'（地铁，实线 + 圆形站标）
            | 'intercity'（城际铁路，虚线 + 方形站标 + 「城际」胶囊）
   station 结构：{ key, name, lat, lng, side, ghost?, shared?, terminal? }
   —— 内部坐标一律 WGS84，高德底图只在渲染阶段投影到 GCJ-02。
   ========================================================================== */

/* 高德开发者 Key（Web 服务 Key，已在本项目验证可用：status=1 / infocode=10000）。
   页面内仍可在「地图设置」中覆盖或清除，交付后可随时换 Key，不写死为唯一数据源。
   若改用高德 JS API 2.0 的安全密钥（sk），请填入 AMAP_SECURITY 并在设置面板同步。 */
var AMAP_KEY = '54f4cc0397a9d44e9dd7690811f2b638';
var AMAP_SECURITY = '';

var STORE_PREFIX = 'metroChronicle.v2.';

var STORE = {
  prefix: STORE_PREFIX,
  plan: function (cityId) { return STORE_PREFIX + 'plan.' + cityId; },
  selection: function (cityId) { return STORE_PREFIX + 'selection.' + cityId; },
  cities: STORE_PREFIX + 'cities',
  amapKey: STORE_PREFIX + 'amapKey',
  amapSecurity: STORE_PREFIX + 'amapSecurity',
  lastCity: STORE_PREFIX + 'lastCity',
  basemap: STORE_PREFIX + 'basemap'
};

var LABEL_SIDES = ['top', 'bottom', 'left', 'right'];
var LINE_TYPES = ['metro', 'intercity'];

/** 线路类型视觉定义：描边样式、站标形状、徽章形状都由这里决定 */
var LINE_TYPE_STYLE = {
  metro: {
    key: 'metro',
    label: '地铁',
    badgeShape: 'circle',
    weight: 4.2,
    casingWeight: 8.5,
    glowWeight: 12,
    glowOpacity: 0.085,
    dashArray: null,
    stationShape: 'circle'
  },
  intercity: {
    key: 'intercity',
    label: '城际铁路',
    badgeShape: 'pill',
    weight: 3,
    casingWeight: 7,
    glowWeight: 10,
    glowOpacity: 0.07,
    dashArray: '9 6',
    stationShape: 'square'
  }
};

function lineTypeStyle(type) {
  return LINE_TYPE_STYLE[type] || LINE_TYPE_STYLE.metro;
}

/** 新建线路时的配色轮转 */
var LINE_COLOR_PALETTE = ['#e60012', '#0068b7', '#0f8a63', '#7b5ea7', '#c07a1e', '#3f6d8e', '#9a3b52', '#4a5568'];

function nextLineColor(usedColors) {
  for (var i = 0; i < LINE_COLOR_PALETTE.length; i += 1) {
    if (usedColors.indexOf(LINE_COLOR_PALETTE[i]) < 0) return LINE_COLOR_PALETTE[i];
  }
  return LINE_COLOR_PALETTE[usedColors.length % LINE_COLOR_PALETTE.length];
}

/** 内置城市预设：默认株洲（3 条地铁 + 1 条城际）+ 演示城市湘潭（2 条地铁 + 1 条城际） */
var CITY_PRESETS = [
  {
    id: 'zhuzhou',
    name: '株洲',
    view: { center: [27.8650, 113.1350], zoom: 11 },
    lines: [
      {
        key: 'zz-l1',
        badge: '1',
        name: '1 号线',
        color: '#e60012',
        type: 'metro',
        dateText: '2030.06.28',
        status: '试运行',
        stations: [
          { key: 'zz-yunlong', name: '云龙', lat: 27.9620, lng: 113.2330 },
          { key: 'zz-tianxin', name: '田心', lat: 27.8960, lng: 113.1490 },
          { key: 'zz-qingshuitang', name: '清水塘', lat: 27.8795, lng: 113.0930, ghost: true, shared: true },
          { key: 'zz-liyu', name: '栗雨', lat: 27.8300, lng: 113.0650, shared: true },
          { key: 'zz-tianyi', name: '天易', lat: 27.7950, lng: 113.0350 },
          { key: 'zz-zhuzhouxi', name: '株洲西站', lat: 27.7790, lng: 113.0455, shared: true }
        ]
      },
      {
        key: 'zz-l2',
        badge: '2',
        name: '2 号线',
        color: '#0068b7',
        type: 'metro',
        dateText: '2032.09.30',
        status: '开通运营',
        stations: [
          { key: 'zz-qingshuitang', name: '清水塘', lat: 27.8795, lng: 113.0930, shared: true },
          { key: 'zz-baishigang', name: '白石港', lat: 27.8560, lng: 113.1250 },
          { key: 'zz-zhuzhouzhan', name: '株洲站', lat: 27.8290, lng: 113.1420, shared: true },
          { key: 'zz-hongqi', name: '红旗广场', lat: 27.8420, lng: 113.1720 },
          { key: 'zz-jinshan', name: '金山新城', lat: 27.8830, lng: 113.2280, shared: true }
        ]
      },
      {
        key: 'zz-l3',
        badge: '3',
        name: '3 号线',
        color: '#0f8a63',
        type: 'metro',
        dateText: '2034.03.18',
        status: '开通运营',
        stations: [
          { key: 'zz-liyu', name: '栗雨', lat: 27.8300, lng: 113.0650, shared: true },
          { key: 'zz-shennong', name: '神农城', lat: 27.8180, lng: 113.1250 },
          { key: 'zz-zhuzhouzhan', name: '株洲站', lat: 27.8290, lng: 113.1420, shared: true },
          // 荷塘单独开通：比 3 号线晚一年多，用于演示「按时间顺序插播单个站点开通」
          { key: 'zz-hetang', name: '荷塘', lat: 27.8580, lng: 113.1850, openMode: 'alone', openDate: '2035.06.01' },
          { key: 'zz-jinshan', name: '金山新城', lat: 27.8830, lng: 113.2280, shared: true }
        ]
      },
      {
        key: 'zz-ic',
        badge: '城际',
        name: '长株潭城际',
        color: '#7b5ea7',
        type: 'intercity',
        dateText: '2035.09.28',
        status: '开通运营',
        stations: [
          { key: 'zz-zhuzhouxi', name: '株洲西站', lat: 27.7790, lng: 113.0455, shared: true },
          { key: 'zz-liyu', name: '栗雨', lat: 27.8300, lng: 113.0650, shared: true },
          { key: 'zz-zhuzhouzhan', name: '株洲站', lat: 27.8290, lng: 113.1420, shared: true },
          { key: 'zz-tianxin', name: '田心', lat: 27.8960, lng: 113.1490, shared: true },
          { key: 'zz-yunlong', name: '云龙', lat: 27.9620, lng: 113.2330, shared: true }
        ]
      }
    ]
  },
  {
    id: 'xiangtan',
    name: '湘潭',
    view: { center: [27.8900, 112.9400], zoom: 11 },
    lines: [
      {
        key: 'xt-l1',
        badge: '1',
        name: '1 号线',
        color: '#cf5a1b',
        type: 'metro',
        dateText: '2031.12.20',
        status: '试运行',
        stations: [
          { key: 'xt-beizhan', name: '湘潭北站', lat: 27.9430, lng: 112.9350, shared: true },
          { key: 'xt-jiuhua', name: '九华', lat: 27.9200, lng: 112.9600 },
          { key: 'xt-heping', name: '和平公园', lat: 27.8800, lng: 112.9300 },
          { key: 'xt-yuhu', name: '雨湖', lat: 27.8600, lng: 112.9100 },
          { key: 'xt-xiangtanzhan', name: '湘潭站', lat: 27.8489, lng: 112.9130, shared: true }
        ]
      },
      {
        key: 'xt-l2',
        badge: '2',
        name: '2 号线',
        color: '#1c7a6b',
        type: 'metro',
        dateText: '2033.05.01',
        status: '开通运营',
        stations: [
          { key: 'xt-xiangtanzhan', name: '湘潭站', lat: 27.8489, lng: 112.9130, shared: true },
          { key: 'xt-jianshelukou', name: '建设路口', lat: 27.8400, lng: 112.9450 },
          { key: 'xt-youyiguangchang', name: '友谊广场', lat: 27.8300, lng: 112.9600 },
          { key: 'xt-yuetang', name: '岳塘', lat: 27.8250, lng: 112.9800 }
        ]
      },
      {
        key: 'xt-ic',
        badge: '城际',
        name: '长株潭城际',
        color: '#7b5ea7',
        type: 'intercity',
        dateText: '2034.10.01',
        status: '开通运营',
        stations: [
          { key: 'xt-beizhan', name: '湘潭北站', lat: 27.9430, lng: 112.9350, shared: true },
          { key: 'xt-bantang', name: '板塘', lat: 27.8900, lng: 112.9500 },
          { key: 'xt-xiangtanzhan', name: '湘潭站', lat: 27.8489, lng: 112.9130, shared: true }
        ]
      }
    ]
  }
];

var DEFAULT_LINE_COLORS = LINE_COLOR_PALETTE.slice(0, 4);

/* ------------------------------------------------------------ 方案工具 */

function clonePlan(source) {
  return JSON.parse(JSON.stringify(source));
}

function findPreset(cityId) {
  for (var i = 0; i < CITY_PRESETS.length; i += 1) {
    if (CITY_PRESETS[i].id === cityId) return CITY_PRESETS[i];
  }
  return null;
}

/** 读取“自定义城市”列表（仅存 name / view / 空线网） */
function loadCustomCities() {
  var raw = storage.getJSON(STORE.cities);
  if (!Array.isArray(raw)) return [];
  var list = [];
  raw.forEach(function (item) {
    if (!item || typeof item !== 'object') return;
    if (typeof item.id !== 'string' || !item.id) return;
    if (typeof item.name !== 'string' || !item.name) return;
    var view = normalizeView(item.view, null);
    if (!view) return;
    list.push({ id: item.id, name: item.name.slice(0, 24), view: view });
  });
  return list;
}

function saveCustomCities(list) {
  storage.setJSON(STORE.cities, list);
  if (typeof RemoteStore !== 'undefined' && RemoteStore.enabled) RemoteStore.pushCities(list);
}

function normalizeView(view, fallback) {
  if (view && Array.isArray(view.center) && view.center.length === 2) {
    var lat = Number(view.center[0]);
    var lng = Number(view.center[1]);
    if (isValidLatLng(lat, lng)) {
      var zoom = Number(view.zoom);
      return { center: [lat, lng], zoom: isFiniteNumber(zoom) ? clamp(zoom, 3, 18) : 11 };
    }
  }
  return fallback ? { center: fallback.center.slice(), zoom: fallback.zoom } : null;
}

/**
 * 规范化一条线路：补全 key / 颜色 / 类型 / 日期 / 站序 / 标签方向，
 * 保证渲染层拿到的数据永远是“形状完整”的。
 */
function normalizeLine(line, lineIndex, fallback) {
  var source = line || {};
  var fallbackLine = fallback || {};
  var stations = Array.isArray(source.stations) ? source.stations : (fallbackLine.stations || []);
  var seen = {};
  var normalizedStations = [];

  stations.forEach(function (station, index) {
    if (!station || typeof station !== 'object') return;
    var lat = Number(station.lat);
    var lng = Number(station.lng);
    if (!isValidLatLng(lat, lng)) return;
    var key = typeof station.key === 'string' && station.key ? station.key : 'st-' + lineIndex + '-' + index;
    if (seen[key]) return;                       // 同一线路内去重
    seen[key] = true;
    var name = typeof station.name === 'string' ? station.name.slice(0, 24) : '新站点';
    normalizedStations.push({
      key: key,
      name: name || '新站点',
      lat: lat,
      lng: lng,
      side: LABEL_SIDES.indexOf(station.side) >= 0 ? station.side : '',
      ghost: !!station.ghost,
      shared: !!station.shared,
      terminal: !!station.terminal,
      // 开通方式：随线路一起开通（默认）/ 单独开通（有自己的开通日期）
      openMode: station.openMode === 'alone' ? 'alone' : 'line',
      openDate: typeof station.openDate === 'string' ? station.openDate.slice(0, 16) : ''
    });
  });

  var type = LINE_TYPES.indexOf(source.type) >= 0 ? source.type : 'metro';
  return {
    key: typeof source.key === 'string' && source.key ? source.key : 'line-' + lineIndex,
    badge: typeof source.badge === 'string' && source.badge ? source.badge.slice(0, 4) : String(lineIndex + 1),
    name: typeof source.name === 'string' && source.name ? source.name.slice(0, 24) : (lineIndex + 1) + ' 号线',
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(source.color)) ? source.color : DEFAULT_LINE_COLORS[lineIndex % DEFAULT_LINE_COLORS.length],
    type: type,
    dateText: typeof source.dateText === 'string' && source.dateText ? source.dateText.slice(0, 16) : '—',
    status: typeof source.status === 'string' && source.status ? source.status.slice(0, 8) : '开通运营',
    stations: normalizedStations
  };
}

/**
 * 方案规范化：
 * 1) 站序首尾标记 terminal；
 * 2) 跨线路同 key 视为换乘站，统一 shared 标记与坐标（以先出现的为准）；
 * 3) 依据走向自动推导标签方向，避免站名压线。
 */
function normalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== 'object') return null;
  if (typeof rawPlan.cityId !== 'string' || !rawPlan.cityId) return null;
  if (!Array.isArray(rawPlan.lines) || !rawPlan.lines.length) return null;

  var preset = findPreset(rawPlan.cityId);
  var fallbackView = preset ? preset.view : { center: [27.865, 113.135], zoom: 11 };
  var view = normalizeView(rawPlan.view, fallbackView);

  var lines = [];
  rawPlan.lines.slice(0, 8).forEach(function (line, index) {
    var normalized = normalizeLine(line, index, preset ? preset.lines[index] : null);
    if (normalized.stations.length || !preset) lines.push(normalized);
    else if (preset && preset.lines[index]) lines.push(normalizeLine(preset.lines[index], index, null));
  });
  if (!lines.length) return null;

  // 跨线同 key：位置、换乘标记与开通方式同步
  var byKey = {};
  lines.forEach(function (line) {
    line.stations.forEach(function (station) {
      if (!byKey[station.key]) {
        byKey[station.key] = {
          lat: station.lat,
          lng: station.lng,
          count: 0,
          ghost: station.ghost,
          openMode: station.openMode,
          openDate: station.openDate
        };
      }
      byKey[station.key].count += 1;
      if (station.ghost) byKey[station.key].ghost = true;
      if (station.openMode === 'alone' && byKey[station.key].openMode !== 'alone') {
        byKey[station.key].openMode = 'alone';
        byKey[station.key].openDate = station.openDate;
      }
      if (station.openMode === 'alone' && !byKey[station.key].openDate && station.openDate) {
        byKey[station.key].openDate = station.openDate;
      }
    });
  });
  lines.forEach(function (line) {
    line.stations.forEach(function (station) {
      var entry = byKey[station.key];
      station.lat = entry.lat;
      station.lng = entry.lng;
      station.shared = entry.count > 1 || station.shared;
      if (entry.count > 1 && entry.ghost) station.ghost = true;
      station.openMode = entry.openMode === 'alone' ? 'alone' : 'line';
      station.openDate = station.openMode === 'alone' ? (entry.openDate || station.openDate || '') : '';
    });
  });

  // 标签方向：按线路走向自动避让（同 key 取首次计算值）
  var sideByKey = {};
  lines.forEach(function (line) {
    var points = line.stations.map(function (station) { return [station.lat, station.lng]; });
    line.stations.forEach(function (station, index) {
      if (station.side) { if (!sideByKey[station.key]) sideByKey[station.key] = station.side; return; }
      var autoSide = autoLabelSide(points, index);
      if (!sideByKey[station.key]) sideByKey[station.key] = autoSide;
    });
  });
  lines.forEach(function (line) {
    line.stations.forEach(function (station, index) {
      station.side = sideByKey[station.key] || 'bottom';
      station.terminal = index === 0 || index === line.stations.length - 1;
    });
  });

  return {
    cityId: rawPlan.cityId,
    cityName: typeof rawPlan.cityName === 'string' && rawPlan.cityName ? rawPlan.cityName.slice(0, 24) : (preset ? preset.name : rawPlan.cityId),
    view: view,
    lines: lines
  };
}

/** 自定义城市的空白线网：默认两条地铁 + 一条城际，便于用户从零编排 */
function emptyLinesForCity(cityId) {
  return [
    { key: cityId + '-l1', badge: '1', name: '1 号线', color: LINE_COLOR_PALETTE[0], type: 'metro', dateText: '—', status: '试运行', stations: [] },
    { key: cityId + '-l2', badge: '2', name: '2 号线', color: LINE_COLOR_PALETTE[1], type: 'metro', dateText: '—', status: '开通运营', stations: [] },
    { key: cityId + '-ic', badge: '城际', name: '城际铁路', color: LINE_COLOR_PALETTE[3], type: 'intercity', dateText: '—', status: '开通运营', stations: [] }
  ];
}

/** 某个城市的默认方案（内置预设或自定义空线网） */
function createDefaultPlan(cityId) {
  var preset = findPreset(cityId);
  if (preset) {
    return normalizePlan(clonePlan({ cityId: preset.id, cityName: preset.name, view: preset.view, lines: preset.lines }));
  }
  var custom = loadCustomCities().filter(function (city) { return city.id === cityId; })[0];
  if (custom) {
    return normalizePlan({
      cityId: custom.id,
      cityName: custom.name,
      view: custom.view,
      lines: emptyLinesForCity(custom.id)
    });
  }
  return null;
}

/**
 * 存档严格校验：只接受形状完全合法的方案（站序、坐标、key 唯一性）。
 * 任何字段不合法都视为「校验失败」，由调用方回退该城市默认方案。
 */
function isValidStoredPlan(raw, cityId) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.cityId !== 'string' || raw.cityId !== cityId) return false;
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 8) return false;

  var ok = true;
  raw.lines.forEach(function (line) {
    if (!ok) return;
    if (!line || typeof line !== 'object') { ok = false; return; }
    if (typeof line.key !== 'string' || !line.key) { ok = false; return; }
    if (typeof line.name !== 'string' || !line.name) { ok = false; return; }
    if (typeof line.color !== 'string' || !/^#[0-9a-fA-F]{3,8}$/.test(line.color)) { ok = false; return; }
    if (line.type != null && LINE_TYPES.indexOf(line.type) < 0) { ok = false; return; }
    if (!Array.isArray(line.stations)) { ok = false; return; }

    var seen = {};
    line.stations.forEach(function (station) {
      if (!ok) return;
      if (!station || typeof station !== 'object') { ok = false; return; }
      if (typeof station.key !== 'string' || !station.key) { ok = false; return; }
      if (seen[station.key]) { ok = false; return; }     // 同线 key 必须唯一
      seen[station.key] = true;
      if (typeof station.name !== 'string') { ok = false; return; }
      if (station.openMode != null && station.openMode !== 'line' && station.openMode !== 'alone') { ok = false; return; }
      if (station.openDate != null && typeof station.openDate !== 'string') { ok = false; return; }
      if (!isValidLatLng(Number(station.lat), Number(station.lng))) { ok = false; }
    });
  });
  return ok;
}

/** 读取某城市方案：优先 localStorage，非法数据回退默认方案 */
function loadPlan(cityId) {
  var stored = storage.getJSON(STORE.plan(cityId));
  if (stored) {
    if (isValidStoredPlan(stored, cityId)) {
      var validated = normalizePlan(stored);
      if (validated && validated.cityId === cityId) return { plan: validated, fromStorage: true };
    }
    storage.remove(STORE.plan(cityId));      // 非法数据：清掉，回退默认
  }
  var fallbackPlan = createDefaultPlan(cityId);
  return fallbackPlan ? { plan: fallbackPlan, fromStorage: false } : null;
}

function savePlan(plan) {
  if (!plan || !plan.cityId) return false;
  var ok = storage.setJSON(STORE.plan(plan.cityId), plan);
  if (typeof RemoteStore !== 'undefined' && RemoteStore.enabled) RemoteStore.pushPlan(plan);
  return ok;
}

function clearSavedPlan(cityId) {
  storage.remove(STORE.plan(cityId));
  if (typeof RemoteStore !== 'undefined' && RemoteStore.enabled) RemoteStore.removePlan(cityId);
}

/** 城市清单：内置预设 + 自定义城市（用于选择器） */
function listCities() {
  var list = CITY_PRESETS.map(function (preset) { return { id: preset.id, name: preset.name, custom: false }; });
  loadCustomCities().forEach(function (city) {
    if (!findPreset(city.id)) list.push({ id: city.id, name: city.name, custom: true });
  });
  return list;
}

/** 新建自定义城市：空白线网，坐标使用 WGS84 */
function createCustomCity(name, center) {
  var trimmed = String(name || '').trim().slice(0, 24) || '自定义城市';
  var view = normalizeView({ center: center, zoom: 12 }, { center: [27.865, 113.135], zoom: 11 });
  var cities = loadCustomCities();
  var id = 'custom-' + Date.now().toString(36);
  cities.push({ id: id, name: trimmed, view: view });
  saveCustomCities(cities);
  return id;
}

/* ------------------------------------------------ 统计（绝不写死数字） */

/** 解析 '2030.06.28' / '2030-6-28' / '2030年6月28日' → 可比较数字（YYYYMMDD）；非法返回 Infinity */
function parseDateValue(text) {
  var match = /^(\d{4})\s*[.\-/年]?\s*(\d{1,2})\s*[.\-/月]?\s*(\d{1,2})/.exec(String(text == null ? '' : text).trim());
  if (!match) return Infinity;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return Infinity;
  return year * 10000 + month * 100 + day;
}

/** 统一成页面展示格式 YYYY.MM.DD；非法返回空串 */
function normalizeDateInput(text) {
  var match = /^(\d{4})\s*[.\-/年]?\s*(\d{1,2})\s*[.\-/月]?\s*(\d{1,2})/.exec(String(text == null ? '' : text).trim());
  if (!match) return '';
  var month = Number(match[2]);
  var day = Number(match[3]);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return '';
  return match[1] + '.' + ('0' + month).slice(-2) + '.' + ('0' + day).slice(-2);
}

/** 统计口径：站点按「去重站数」计数（换乘站只算一个）；里程只累加已开通线路 */
function computeStats(lines, geometryMap, extraStationKeys) {
  var keys = {};
  lines.forEach(function (line) {
    line.stations.forEach(function (station) { keys[station.key] = true; });
  });
  (extraStationKeys || []).forEach(function (key) { keys[key] = true; });
  var meters = 0;
  lines.forEach(function (line) {
    var geometry = geometryMap[line.key];
    if (geometry && isFiniteNumber(geometry.totalMeters)) meters += geometry.totalMeters;
  });
  return {
    lines: lines.length,
    stations: Object.keys(keys).length,
    km: Math.round(meters / 1000)
  };
}

/* ------------------------------------------------------ 线路显示选择 */

/** 读取某城市「哪些线路参与播放」：默认全选，非法值回退全选 */
function loadLineSelection(cityId, plan) {
  var selected = {};
  var raw = storage.getJSON(STORE.selection(cityId));
  var keys = plan ? plan.lines.map(function (line) { return line.key; }) : [];
  if (raw && typeof raw === 'object') {
    var any = false;
    keys.forEach(function (key) {
      if (raw[key] === true) { selected[key] = true; any = true; }
    });
    if (any) return selected;
  }
  keys.forEach(function (key) { selected[key] = true; });
  return selected;
}

function saveLineSelection(cityId, selected) {
  storage.setJSON(STORE.selection(cityId), selected);
}
