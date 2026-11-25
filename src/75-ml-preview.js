/* ==========================================================================
   90 · MapLibre 渲染引擎（预览版，`?engine=ml` 启用）
   —— 与 Leaflet 版并存：绘图交给 WebGL（GPU），镜头用 jumpTo 逐帧推进，
      线路揭示用 line-gradient（只改一个绘制属性），站点标签交给 MapLibre 的
      collision detection。用来验证"换渲染引擎能带来的顺滑度与观感"。
   ========================================================================== */

var MlPreview = {
  map: null,
  plan: null,
  geometries: {},
  events: [],
  running: false,
  phase: 'idle',
  lineColor: '#e60012',

  /* 镜头：全景 ↔ 特写 A，与 Leaflet 版同一套节奏 */
  panorama: 11,
  focus: 14,
  cam: { lng: 113.135, lat: 27.865, zoom: 11 },
  camTarget: { lng: 113.135, lat: 27.865, zoom: 11 },
  rafId: 0,
  timeline: null,

  /* ------------------------------------------------------------- 入口 */

  start: function () {
    if (this.map || !window.maplibregl) return false;
    var plan = App.plan;
    if (!plan || !plan.lines || !plan.lines.length) return false;
    this.plan = plan;

    var mapEl = document.getElementById('map');
    var mlEl = document.getElementById('mlMap');
    if (!mapEl || !mlEl) return false;
    mapEl.style.display = 'none';
    mlEl.style.display = 'block';   // CSS 里默认 display:none，这里必须显式覆盖
    mlEl.setAttribute('aria-hidden', 'false');

    var self = this;
    var center = plan.view && plan.view.center ? plan.view.center : [27.865, 113.135];
    this.map = new maplibregl.Map({
      container: 'mlMap',
      style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
          base: {
            type: 'raster',
            tiles: [
              'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
              'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}'
            ],
            tileSize: 256,
            maxzoom: 16,
            attribution: 'Esri'
          }
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#eef0f2' } },
          { id: 'base', type: 'raster', source: 'base' }
        ]
      },
      center: [center[1], center[0]],
      zoom: 11,
      minZoom: 4,
      maxZoom: 17,
      attributionControl: false,
      interactive: false,
      dragRotate: false,
      pitchWithRotate: false
    });

    this.cam.lng = center[1];
    this.cam.lat = center[0];
    this.cam.zoom = 11;
    this.camTarget.lng = center[1];
    this.camTarget.lat = center[0];
    this.camTarget.zoom = 11;

    this.map.on('load', function () {
      self.buildSources();
      self.computeEvents();
      self.fitPanorama();
      self.bindCameraLoop();
      var veil = document.getElementById('veil');
      if (veil) veil.style.opacity = '0';
      window.setTimeout(function () { self.play(); }, 500);
    });
    return true;
  },

  /* --------------------------------------------------------- 数据 → 图层 */

  buildSources: function () {
    var self = this;
    var map = this.map;
    var plan = this.plan;

    // 线路几何（平滑后）
    var lineFeatures = plan.lines.map(function (line) {
      self.geometries[line.key] = buildLineGeometry(line.stations, function (lat, lng) { return [lat, lng]; });
      var coords = self.geometries[line.key].render.map(function (pt) { return [pt[1], pt[0]]; });
      return {
        type: 'Feature',
        properties: { key: line.key, color: line.color, type: line.type, active: false },
        geometry: { type: 'LineString', coordinates: coords }
      };
    });

    // 站点
    var seen = {};
    var stationFeatures = [];
    plan.lines.forEach(function (line) {
      line.stations.forEach(function (station) {
        if (seen[station.key]) {
          var existing = seen[station.key];
          if (existing.properties.colors.indexOf(line.color) < 0) existing.properties.colors.push(line.color);
          return;
        }
        var feature = {
          type: 'Feature',
          properties: {
            key: station.key,
            name: station.name,
            color: line.color,
            colors: [line.color],
            revealed: false,
            ghost: !!station.ghost
          },
          geometry: { type: 'Point', coordinates: [station.lng, station.lat] }
        };
        seen[station.key] = feature;
        stationFeatures.push(feature);
      });
    });
    this.stationIndex = seen;

    map.addSource('lines', {
      type: 'geojson',
      lineMetrics: true,
      data: { type: 'FeatureCollection', features: lineFeatures }
    });
    map.addSource('stations', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: stationFeatures }
    });

    map.addLayer({
      id: 'line-glow', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': ['case', ['==', ['get', 'type'], 'intercity'], 10, 12],
        'line-opacity': 0.1
      }
    });
    map.addLayer({
      id: 'line-casing', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['case', ['==', ['get', 'type'], 'intercity'], 7, 8.5],
        'line-opacity': 0.96
      }
    });
    map.addLayer({
      id: 'line-main', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: ['all', ['==', ['get', 'active'], false], ['!=', ['get', 'type'], 'intercity']],
      paint: { 'line-color': ['get', 'color'], 'line-width': 4.2 }
    });
    map.addLayer({
      id: 'line-main-ic', type: 'line', source: 'lines',
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      filter: ['all', ['==', ['get', 'active'], false], ['==', ['get', 'type'], 'intercity']],
      paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-dasharray': [3, 2] }
    });
    // 正在绘制的线：用 line-gradient 表示进度（每帧只改这个绘制属性）
    map.addLayer({
      id: 'line-active', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      filter: ['==', ['get', 'active'], true],
      paint: {
        'line-width': 4.2,
        'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#000', 1, '#000']
      }
    });

    // 站点：光晕 → 圆点 → 标签
    map.addLayer({
      id: 'st-halo', type: 'circle', source: 'stations',
      paint: {
        'circle-radius': 13,
        'circle-color': ['get', 'color'],
        'circle-opacity': ['case', ['==', ['get', 'revealed'], true], 0.1, 0],
        'circle-blur': 0.6
      }
    });
    map.addLayer({
      id: 'st-dot', type: 'circle', source: 'stations',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'revealed'], true], 4.6, 3.4],
        'circle-color': ['case', ['==', ['get', 'revealed'], true], '#ffffff', '#ffffff'],
        'circle-stroke-width': ['case', ['==', ['get', 'revealed'], true], 3, 2],
        'circle-stroke-color': ['get', 'color'],
        'circle-opacity': ['case', ['==', ['get', 'revealed'], true], 1, 0.45]
      }
    });
    map.addLayer({
      id: 'st-label', type: 'symbol', source: 'stations',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11.5,
        'text-font': ['Noto Sans Regular'],
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-padding': 6,
        'symbol-sort-key': ['case', ['==', ['get', 'revealed'], true], 0, 1]
      },
      paint: {
        'text-color': '#2b3138',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.6,
        'text-opacity': ['case', ['==', ['get', 'revealed'], true], 1, 0.55]
      }
    });
  },

  /** 取景：让整张线网落在画面内 */
  fitPanorama: function () {
    if (this.map) this.map.resize();
    var points = [];
    var self = this;
    Object.keys(this.geometries).forEach(function (key) {
      points = points.concat(self.geometries[key].render);
    });
    if (!points.length) return;
    var bounds = new maplibregl.LngLatBounds();
    points.forEach(function (pt) { bounds.extend([pt[1], pt[0]]); });
    this.panoramaCenter = [bounds.getCenter().lat, bounds.getCenter().lng];
    this.panorama = this.fitZoom(bounds, 70);
    this.focus = Math.max(12.5, Math.min(16, this.panorama + 2.2));
    this.jumpCamera(this.panorama);
  },

  /** 用 Web Mercator 归一化坐标手算"装得下"的缩放（MapLibre 4.x 没有 getBoundsZoom） */
  fitZoom: function (bounds, padding) {
    var ne = bounds.getNorthEast();
    var sw = bounds.getSouthWest();
    var list = this.map.getContainer();
    var width = Math.max(120, list.clientWidth - padding * 2);
    var height = Math.max(120, list.clientHeight - padding * 2);
    var mercX = function (lng) { return (180 + lng) / 360; };
    var mercY = function (lat) {
      var s = Math.sin(lat * Math.PI / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    var dx = Math.abs(mercX(ne.lng) - mercX(sw.lng));
    var dy = Math.abs(mercY(sw.lat) - mercY(ne.lat));
    if (dx < 1e-9 && dy < 1e-9) return 14;
    var zx = dx > 1e-9 ? Math.log2(width / (dx * 512)) : Infinity;
    var zy = dy > 1e-9 ? Math.log2(height / (dy * 512)) : Infinity;
    return Math.max(4, Math.min(17, Math.min(zx, zy)));
  },

  jumpCamera: function (zoom) {
    var center = this.panoramaCenter || this.map.getCenter();
    this.camTarget.zoom = zoom;
    this.cam.zoom = zoom;
    this.map.jumpTo({ center: [this.camTarget.lng, this.camTarget.lat], zoom: zoom });
  },

  /* ------------------------------------------------------------ 镜头 */

  bindCameraLoop: function () {
    var self = this;
    var loop = function () {
      var cam = self.cam;
      var target = self.camTarget;
      cam.lng += (target.lng - cam.lng) * 0.18;
      cam.lat += (target.lat - cam.lat) * 0.18;
      cam.zoom += (target.zoom - cam.zoom) * 0.12;
      self.map.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom });
      self.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  },

  /* ------------------------------------------------------- 事件与播放 */

  computeEvents: function () {
    var plan = this.plan;
    var events = [];
    plan.lines.forEach(function (line, index) {
      events.push({
        type: 'line',
        index: index,
        key: line.key,
        color: line.color,
        name: line.name,
        value: parseDateValue(line.dateText),
        dateText: line.dateText,
        line: line
      });
    });
    events.sort(function (a, b) { return (a.value || 0) - (b.value || 0); });
    this.events = events;
  },

  play: function () {
    if (this.running) return;
    this.running = true;
    var self = this;
    var tl = gsap.timeline({ onComplete: function () { self.running = false; self.phase = 'done'; } });
    this.timeline = tl;

    var cursor = 0.4;
    this.events.forEach(function (event) {
      var geometry = self.geometries[event.key];
      if (!geometry) return;
      var start = geometry.render[0];
      var duration = Math.min(14, Math.max(6, 2.2 + event.line.stations.length * 0.9));

      // 1) 镜头飞到起点（特写 A）
      tl.call(function () {
        self.phase = 'travel';
        self.updateHud(event);
        self.camTarget.lat = start[0];
        self.camTarget.lng = start[1];
        self.camTarget.zoom = self.focus;
      }, null, cursor);
      cursor += 2.4;

      // 2) 沿线绘制：进度驱动 line-gradient + 镜头跟头部
      var progress = { p: 0 };
      tl.call(function () {
        self.phase = 'draw';
        self.setMainLayersVisible(false, event.key);
        self.map.setPaintProperty('line-active', 'line-gradient', self.gradient(event.color, 0));
        self.revealStation(geometry, event, 0);
      }, null, cursor);
      tl.to(progress, {
        p: 1,
        duration: duration,
        ease: 'none',
        onUpdate: function () {
          self.map.setPaintProperty('line-active', 'line-gradient', self.gradient(event.color, progress.p));
          var head = headPointAt(geometry, progress.p);
          if (head) {
            self.camTarget.lat = head[0];
            self.camTarget.lng = head[1];
          }
          self.revealStation(geometry, event, progress.p);
        }
      }, cursor);
      cursor += duration;

      // 3) 拉回全景、线路交还给主图层
      tl.call(function () {
        self.phase = 'panorama';
        self.setMainLayersVisible(true, null);
        self.map.setFilter('line-active', ['==', ['get', 'active'], true]);
        self.camTarget.zoom = self.panorama;
        self.camTarget.lat = self.panoramaCenter[0];
        self.camTarget.lng = self.panoramaCenter[1];
        self.updateStats();
      }, null, cursor);
      cursor += 2.6;
    });

    tl.call(function () {
      self.phase = 'overview';
      self.camTarget.zoom = self.panorama;
      self.camTarget.lat = self.panoramaCenter[0];
      self.camTarget.lng = self.panoramaCenter[1];
      self.updateStats(true);
    }, null, cursor);
  },

  /** 进度渐变：stop 必须严格递增，否则 MapLibre 会整层丢弃 */
  gradient: function (color, p) {
    var hidden = 'rgba(0,0,0,0)';
    var value = Math.max(0, Math.min(1, p));
    if (value <= 0.002) {
      return ['interpolate', ['linear'], ['line-progress'], 0, hidden, 1, hidden];
    }
    var mid = Math.min(0.997, Math.max(0.002, value));
    return [
      'interpolate', ['linear'], ['line-progress'],
      0, color,
      mid, color,
      Math.min(1, mid + 0.002), hidden,
      1, hidden
    ];
  },

  /** 主图层（地铁 + 城际）一起开关；drawing 期间隐藏正在画的那条 */
  setMainLayersVisible: function (visible, excludeKey) {
    var ids = ['line-main', 'line-main-ic'];
    var self = this;
    ids.forEach(function (id) {
      if (!self.map.getLayer(id)) return;
      var filter = visible
        ? ['==', ['get', 'active'], false]
        : ['all', ['==', ['get', 'active'], false], ['!=', ['get', 'key'], excludeKey]];
      self.map.setFilter(id, filter);
    });
  },

  revealStation: function (geometry, event, ratio) {
    var self = this;
    var line = event.line;
    var changed = false;
    line.stations.forEach(function (station, i) {
      var stationRatio = geometry.stationRatio[i];
      if (ratio + 1e-6 < stationRatio) return;
      var feature = self.stationIndex[station.key];
      if (!feature || feature.properties.revealed) return;
      feature.properties.revealed = true;
      changed = true;
    });
    if (!changed) return;
    var features = Object.keys(this.stationIndex).map(function (key) { return self.stationIndex[key]; });
    this.map.getSource('stations').setData({ type: 'FeatureCollection', features: features });
  },

  /* ------------------------------------------------------------- HUD */

  updateHud: function (event) {
    var date = document.getElementById('dateText');
    if (date) date.textContent = event.dateText;
    var name = document.getElementById('lineName');
    if (name) name.textContent = event.name;
    var range = document.getElementById('lineRange');
    if (range) range.textContent = event.line.stations[0].name + ' → ' + event.line.stations[event.line.stations.length - 1].name;
    var status = document.getElementById('lineStatus');
    if (status) status.textContent = '全线开通';
  },

  updateStats: function (final) {
    var revealed = 0;
    var self = this;
    Object.keys(this.stationIndex).forEach(function (key) {
      if (self.stationIndex[key].properties.revealed) revealed += 1;
    });
    var lines = final ? Object.keys(this.geometries).length : 1;
    var km = 0;
    Object.keys(this.geometries).forEach(function (key) {
      if (final) km += self.geometries[key].totalMeters;
    });
    var setText = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text; };
    setText('statLines', String(lines));
    setText('statStations', String(revealed));
    setText('statKm', km ? String(Math.round(km / 1000)) : '—');
  },

  /* ---------------------------------------------------------- 调试接口 */

  snapshot: function () {
    return {
      ready: !!this.map,
      phase: this.phase,
      panorama: Number((this.panorama || 0).toFixed(2)),
      focus: Number((this.focus || 0).toFixed(2)),
      zoom: this.map ? Number(this.map.getZoom().toFixed(2)) : null,
      layers: this.map ? this.map.getStyle().layers.map(function (layer) { return layer.id; }) : [],
      stations: this.stationIndex ? Object.keys(this.stationIndex).length : 0,
      revealed: this.stationIndex
        ? Object.keys(this.stationIndex).filter(function (key) { return this.stationIndex[key].properties.revealed; }, this).length
        : 0
    };
  }
};
