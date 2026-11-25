/* ==========================================================================
   80 · 启动与装配
   —— 地图创建、HUD 事件绑定、播放/编辑的交互锁定、resize、启动编排
   ========================================================================== */

var App = {
  map: null,
  plan: null,
  cityId: null,
  locked: true,
  ready: false,
  storageMode: 'local',

  /** 载入城市方案（读 localStorage，非法数据自动回退默认） */
  loadCity: function (cityId) {
    var loaded = loadPlan(cityId);
    if (!loaded) {
      var fallbackId = CITY_PRESETS[0].id;
      loaded = loadPlan(fallbackId);
      cityId = fallbackId;
    }
    if (!loaded) return null;
    this.cityId = cityId;
    this.plan = loaded.plan;
    storage.set(STORE.lastCity, cityId);
    return loaded;
  }
};

/** 播放期间锁地图手势；编辑期间解锁，但双击缩放始终关闭（缩放按钮始终可用） */
function setMapLocked(locked) {
  var map = App.map;
  if (!map) return;
  // 滚轮缩放与双击缩放一律禁用（播放/编辑态都不用滚轮改比例）
  var handlers = [map.dragging, map.touchZoom, map.boxZoom, map.keyboard];
  handlers.forEach(function (handler) {
    if (!handler) return;
    if (locked) handler.disable();
    else handler.enable();
  });
  if (map.scrollWheelZoom) map.scrollWheelZoom.disable();
  if (map.doubleClickZoom) map.doubleClickZoom.disable();
  var container = map.getContainer();
  if (container) container.classList.toggle('is-locked', !!locked);
  App.locked = !!locked;
}

/* --------------------------------------------------------------- 启动 */

function createMap() {
  App.map = L.map('map', {
    center: [27.865, 113.135],
    zoom: 11,
    zoomControl: false,
    attributionControl: false,
    zoomSnap: 0,              // 连续缩放：镜头叙事需要小数级别缩放
    zoomDelta: 0.75,
    minZoom: 3,
    maxZoom: 17,
    worldCopyJump: false,
    doubleClickZoom: false,
    scrollWheelZoom: false,   // 不允许用滚轮改比例
    keyboard: true,
    preferCanvas: false,
    // 关键：开启 Leaflet 的缩放动画 —— 换层级时它会先拉伸旧瓦片、再切换新瓦片，
    // 期间画面不会空白（关掉它反而会在每次跨层时闪一下）。瓦片淡入仍关闭。
    zoomAnimation: true,
    zoomAnimationThreshold: 6,
    fadeAnimation: false,
    markerZoomAnimation: true
  });
  App.map.on('click', function (event) { Edit.onMapClick(event); });
  setMapLocked(true);
  Camera.init();
  return App.map;
}

function resolveStartCity() {
  var last = storage.get(STORE.lastCity);
  if (last) {
    var exists = listCities().some(function (city) { return city.id === last; });
    if (exists) return last;
  }
  return CITY_PRESETS[0].id;
}

function bindHud() {
  var replayBtn = $('#replayBtn');
  if (replayBtn) replayBtn.addEventListener('click', function () {
    if (App.engine === 'schematic' && typeof Schematic !== 'undefined' && Schematic.root) { Schematic.replay(); return; }
    Story.replay();
  });

  var skipBtn = $('#skipBtn');
  if (skipBtn) skipBtn.addEventListener('click', function () {
    if (App.engine === 'schematic' && typeof Schematic !== 'undefined' && Schematic.root) { Schematic.skip(); return; }
    Story.skip();
  });

  var editBtn = $('#editBtn');
  if (editBtn) editBtn.addEventListener('click', function () { Edit.enter(); });

  var citySelect = $('#citySelect');
  if (citySelect) citySelect.addEventListener('change', function () { CityUI.onSelectChange(citySelect.value); });

  var settingsBtn = $('#settingsBtn');
  if (settingsBtn) settingsBtn.addEventListener('click', function () { CityUI.openSettings(); });

  // 「示意图」按钮：运行中在地理视图与示意图之间切换（不需要刷新）
  var schematicBtn = $('#schematicBtn');
  var syncSchematicBtn = function () {
    if (!schematicBtn) return;
    var on = App.engine === 'schematic' && typeof Schematic !== 'undefined' && !!Schematic.root;
    schematicBtn.textContent = on ? '返回地图' : '示意图';
    schematicBtn.classList.toggle('is-on', on);
  };
  if (schematicBtn) {
    schematicBtn.addEventListener('click', function () {
      var on = App.engine === 'schematic' && typeof Schematic !== 'undefined' && !!Schematic.root;
      if (on) {
        Schematic.stop();
      } else {
        if (typeof Story !== 'undefined') Story.stop();
        if (Schematic.start()) App.engine = 'schematic';
      }
      syncSchematicBtn();
    });
  }
  window.__syncSchematicBtn = syncSchematicBtn;

  // 导出视频（页内直出 MP4；不支持 MediaRecorder 的环境自动隐藏按钮）
  var videoBtn = $('#videoBtn');
  if (videoBtn) {
    if (typeof VideoExport === 'undefined' || !VideoExport.available()) {
      videoBtn.style.display = 'none';
    } else {
      videoBtn.addEventListener('click', function () { exportVideo(videoBtn); });
    }
  }

  // 编辑工具条：事件委托，重建 DOM 不会重复绑定
  var bar = $('#editBar');
  if (bar) bar.addEventListener('click', onEditBarClick);

  // 编辑卡片：点击 / 输入 / 勾选 / 开通方式 全部委托
  var card = $('#editCard');
  if (card) {
    card.addEventListener('click', onEditCardClick);
    card.addEventListener('input', function (event) {
      var target = event.target;
      if (target && target.dataset && target.dataset.act === 'name') Edit.rename(target.value);
    });
    card.addEventListener('change', function (event) {
      var target = event.target;
      if (!target || !target.dataset) return;
      if (target.dataset.act === 'ghost') Edit.toggleGhost(target.checked);
      else if (target.dataset.act === 'open-mode') Edit.setOpenMode(target.value);
      else if (target.dataset.act === 'open-date') Edit.setOpenDate(target.value);
    });
    card.addEventListener('keydown', function (event) {
      var target = event.target;
      if (target && target.dataset && target.dataset.act === 'open-date' && event.key === 'Enter') {
        Edit.setOpenDate(target.value);
      }
    });
  }

  // 线路设置面板
  var saveLineBtn = $('#saveLineBtn');
  if (saveLineBtn) saveLineBtn.addEventListener('click', function () { Edit.saveLineSheet(); });
  var deleteLineBtn = $('#deleteLineBtn');
  if (deleteLineBtn) deleteLineBtn.addEventListener('click', function () { Edit.deleteLineFromSheet(); });
  var colorRow = $('#lineColorRow');
  if (colorRow) {
    colorRow.addEventListener('click', function (event) {
      var dot = event.target && event.target.closest ? event.target.closest('.color-dot') : null;
      if (!dot) return;
      Array.prototype.forEach.call(colorRow.querySelectorAll('.color-dot'), function (el) { el.classList.remove('is-on'); });
      dot.classList.add('is-on');
    });
  }

  // 面板：关闭按钮 / 点击遮罩 / Esc
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (target && target.closest) {
      var closer = target.closest('[data-close]');
      if (closer) { closeSheet(closer.dataset.close); return; }
    }
    if (target && target.classList && target.classList.contains('sheet')) closeSheet(target.id);
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAllSheets();
  });

  var saveKeyBtn = $('#saveAmapKey');
  if (saveKeyBtn) saveKeyBtn.addEventListener('click', function () { CityUI.saveAmapKey(); });
  var clearKeyBtn = $('#clearAmapKey');
  if (clearKeyBtn) clearKeyBtn.addEventListener('click', function () { CityUI.clearAmapKey(); });
  var createCityBtn = $('#createCity');
  if (createCityBtn) createCityBtn.addEventListener('click', function () { CityUI.createCity(); });
  var useCenterBtn = $('#useMapCenter');
  if (useCenterBtn) useCenterBtn.addEventListener('click', function () { CityUI.useMapCenter(); });

  LineUI.bind();
  ZoomUI.bind();
  CitySearch.bind();

  window.addEventListener('resize', debounce(onViewportChange, 160));
  window.addEventListener('orientationchange', debounce(onViewportChange, 220));
}

function onEditBarClick(event) {
  var button = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
  if (!button) return;
  var act = button.dataset.act;
  if (act === 'line') Edit.selectLine(Number(button.dataset.index));
  else if (act === 'reset') Edit.restoreDefault();
  else if (act === 'clear') Edit.clearLine();
  else if (act === 'add-metro') Edit.addLine('metro');
  else if (act === 'add-intercity') Edit.addLine('intercity');
  else if (act === 'delete-line') Edit.deleteLine();
  else if (act === 'line-settings') Edit.openLineSheet();
  else if (act === 'done') Edit.done();
}

function onEditCardClick(event) {
  var button = event.target && event.target.closest ? event.target.closest('[data-act]') : null;
  if (!button || button.tagName === 'INPUT') return;
  var act = button.dataset.act;
  if (act === 'close') Edit.hideCard();
  else if (act === 'up') Edit.move(-1);
  else if (act === 'down') Edit.move(1);
  else if (act === 'delete') Edit.remove();
  else if (act === 'join') Edit.joinCurrentLine();
}

function onViewportChange() {
  if (!App.map) return;
  App.map.invalidateSize();
  ZoomUI.syncScale();
  if (Edit.active) {
    Edit.resolveLabelSides();
    return;
  }
  if (Scene.built && !Story.playing) Scene.fit(false);
}

function showFatal(message) {
  var veil = $('#veil');
  if (!veil) return;
  veil.style.opacity = '1';
  veil.innerHTML = '<div class="fatal">' + escapeHtml(message) + '</div>';
}

/* 开场：重建场景并从头播放；无可播放线路时进入编辑态 */
function startExperience() {
  LineUI.render();
  CityUI.updateBasemapIndicator();

  if (Story.playableLineIndexes().length) {
    Story.play();
    return;
  }
  Scene.build(App.plan);
  Scene.updateHeader(0);
  Scene.updateStats([0]);
  Scene.updateCredit();
  Story.reset();
  var veil = $('#veil');
  if (veil) veil.style.opacity = '0';
  Edit.enter();
}

/** 导出视频：录一段当前城市的开通纪事（页内直出 MP4，无需 FFmpeg） */
function exportVideo(button) {
  var status = $('#videoStatus');
  var showStatus = function (text) {
    if (!status) return;
    status.textContent = text;
    status.classList.add('is-on');
  };
  var hideStatus = function () {
    if (!status) return;
    status.classList.remove('is-on');
  };

  if (button) button.classList.add('is-busy');
  showStatus('准备录制…');
  VideoExport.onProgress = function (seconds) {
    showStatus('正在录制… ' + seconds.toFixed(0) + 's（整段约 2 分钟，随时可关闭页面中止）');
  };

  var maxSeconds = 0;
  try {
    var param = Number(new URLSearchParams(window.location.search).get('videoSeconds'));
    if (isFinite(param) && param > 0) maxSeconds = param;
  } catch (err) { /* noop */ }
  VideoExport.start({ width: 1280, fps: 30, maxSeconds: maxSeconds })
    .then(function (result) {
      hideStatus();
      var url = URL.createObjectURL(result.blob);
      var suffix = result.mimeType.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      var link = document.createElement('a');
      link.href = url;
      link.download = (App.plan && App.plan.cityName ? App.plan.cityName : '城市') + '地铁开通纪事.' + suffix;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      if (typeof toast === 'function') {
        toast('视频已生成：' + (result.blob.size / 1024 / 1024).toFixed(1) + 'MB · 约 ' + result.seconds.toFixed(0) + ' 秒');
      }
    })
    .catch(function (err) {
      hideStatus();
      if (typeof toast === 'function') toast('导出失败：' + (err && err.message ? err.message : err));
    })
    .then(function () {
      if (button) button.classList.remove('is-busy');
      VideoExport.onProgress = null;
    });
}

function boot() {
  if (!window.L || !window.gsap) {
    showFatal('内联依赖未就绪：请确认文件完整（Leaflet 1.9.4 / GSAP 3.12.5 已内联）。');
    return;
  }

  var startCity = resolveStartCity();

  try {
    createMap();
    Scene.init(App.map);
  RouteCanvas.init(App.map);
    bindHud();
  } catch (err) {
    showFatal('初始化失败：' + (err && err.message ? err.message : err));
    return;
  }

  // 任何一次场景重建（编辑保存 / 切换城市 / 恢复默认）之后，示意图自动重新派生
  var originalBuild = Scene.build.bind(Scene);
  Scene.build = function (targetPlan) {
    var result = originalBuild(targetPlan);
    if (typeof Schematic !== 'undefined' && Schematic.root) Schematic.rebuild();
    return result;
  };

  // 底图来源变化时只更新文案（重建场景由具体调用方负责）
  Basemap.onChange = function () {
    CityUI.updateBasemapIndicator();
    if (Scene.plan) Scene.updateCredit();
  };

  // 可选后端：先探测服务端（file:// 下立即跳过），再载入方案
  RemoteStore.boot().then(function (mode) {
    App.storageMode = mode;
    App.loadCity(startCity);
    LineSelection.sync(App.plan);
    CityUI.renderSelect();
    return Basemap.init(App.map);
  }).then(function () {
    App.map.invalidateSize();

    // ?engine=schematic：用示意图引擎（自动从地理数据派生）
    if (engineFromQuery() === 'schematic' && typeof Schematic !== 'undefined') {
      if (Schematic.start()) {
        App.engine = 'schematic';
        App.ready = true;
        if (window.__syncSchematicBtn) window.__syncSchematicBtn();
        return;
      }
    }

    // ?engine=ml：改用 MapLibre（WebGL）渲染同一份线网数据做对照
    if (engineFromQuery() === 'ml' && typeof MlPreview !== 'undefined' && typeof maplibregl !== 'undefined') {
      if (MlPreview.start()) {
        App.engine = 'maplibre';
        App.ready = true;
        return;
      }
    }

    startExperience();
    App.ready = true;
  }).catch(function (err) {
    showFatal('初始化失败：' + (err && err.message ? err.message : err));
  });
}

/** 渲染引擎选择：默认 leaflet；?engine=ml 用 MapLibre（WebGL） */
function engineFromQuery() {
  try {
    var value = new URLSearchParams(window.location.search).get('engine');
    var name = value ? String(value).toLowerCase() : 'leaflet';
    // 兼容 ?engine=ml / ?engine=maplibre
    if (name === 'ml' || name === 'maplibre' || name === 'gl') return 'ml';
    if (name === 'schematic' || name === 'rmp' || name === 'sc') return 'schematic';
    return name;
  } catch (err) {
    return 'leaflet';
  }
}

/* ---------------------------------------------------------------- 语义化入口 */

/* 与需求文档中的命名对齐：便于二次开发时按名字定位实现
   （plan / cityPresets / switchCity / buildScene / buildRoute / revealStation / enterEdit / exitEdit） */
var cityPresets = CITY_PRESETS;

function buildScene(targetPlan) { return Scene.build(targetPlan || App.plan); }
function buildRoute(line) { return Scene.createRouteLayers(line); }
function revealStation(stationKey, mode, numberText) {
  return Scene.revealStation(stationKey, mode, numberText);
}
function switchCity(cityId) { return CityUI.switchCity(cityId); }
function enterEdit() { return Edit.enter(); }
function exitEdit(silent) { return Edit.exit(silent); }

/* ---------------------------------------------------------------- 调试接口 */

/* 供自动化验收脚本读取状态（只读为主，不参与业务逻辑） */
window.__METRO__ = {
  App: App,
  Scene: Scene,
  Story: Story,
  Camera: Camera,
  Edit: Edit,
  Basemap: Basemap,
  CityUI: CityUI,
  LineUI: LineUI,
  LineSelection: LineSelection,
  CitySearch: CitySearch,
  Metrics: Metrics,
  TileCache: TileCache,
  MlPreview: MlPreview,
  VideoExport: VideoExport,
  Schematic: Schematic,
  SCHEMATIC: SCHEMATIC,
  engine: App.engine || 'leaflet',
  engineNow: function () { return App.engine || 'leaflet'; },
  ZoomUI: ZoomUI,
  RemoteStore: RemoteStore,
  api: {
    plan: function () { return App.plan; },
    cityPresets: cityPresets,
    buildScene: buildScene,
    buildRoute: buildRoute,
    revealStation: revealStation,
    switchCity: switchCity,
    enterEdit: enterEdit,
    exitEdit: exitEdit
  },
  snapshot: function () {
    var plan = App.plan;
    var geo = Scene.geometries || {};
    var lengths = {};
    Object.keys(geo).forEach(function (key) { lengths[key] = Math.round(geo[key].totalMeters); });
    return {
      cityId: App.cityId,
      cityName: plan ? plan.cityName : '',
      basemap: Basemap.mode,
      datum: Basemap.datum,
      keyStatus: Basemap.keyStatus,
      storage: App.storageMode,
      date: ($('#dateText') || {}).textContent,
      badge: ($('#lineBadge') || {}).textContent,
      badgeType: ($('#lineBadge') || { dataset: {} }).dataset.lineType || null,
      lineName: ($('#lineName') || {}).textContent,
      range: ($('#lineRange') || {}).textContent,
      status: ($('#lineStatus') || {}).textContent,
      stats: {
        lines: ($('#statLines') || {}).textContent,
        stations: ($('#statStations') || {}).textContent,
        km: ($('#statKm') || {}).textContent
      },
      lines: (plan ? plan.lines : []).map(function (line) {
        return {
          key: line.key,
          name: line.name,
          type: line.type,
          color: line.color,
          stations: line.stations.length,
          selected: LineSelection.isSelected(line.key)
        };
      }),
      lengthsMeters: lengths,
      story: (function () {
        // 示意图引擎用自己的时间轴（事件表仍来自 Story.buildEvents）
        if (App.engine === 'schematic' && typeof Schematic !== 'undefined' && Schematic.root) {
          var events = Schematic.events || [];
          return {
            engine: 'schematic',
            playing: !!Schematic.running,
            finished: !!Schematic.finished,
            phase: Schematic.phase,
            events: events.map(function (event) { return event.type + ':' + event.dateText; }),
            eventCount: events.length,
            lineEventCount: events.filter(function (event) { return event.type === 'line'; }).length,
            stationEventCount: events.filter(function (event) { return event.type === 'station'; }).length,
            startedAt: Schematic.startedAt || null
          };
        }
        return {
        playing: Story.playing,
        finished: Story.finished,
        phase: Story.phase,
        events: (Story.events || []).map(function (event) { return event.type + ':' + event.dateText; }),
        eventCount: (Story.events || []).length,
        lineEventCount: (Story.events || []).filter(function (event) { return event.type === 'line'; }).length,
        stationEventCount: (Story.events || []).filter(function (event) { return event.type === 'station'; }).length,
        startedAt: Story.startedAt || null
        };
      })(),
      editing: Edit.active,
      editLineIndex: Edit.lineIndex,
      locked: App.locked,
      zoom: App.map ? App.map.getZoom() : null,
      stationStates: (function () {
        var map = {};
        Object.keys(Scene.stations).forEach(function (key) { map[key] = Scene.stations[key].state; });
        return map;
      })()
    };
  },
  forceBasemap: function (mode) {
    Basemap.datumLocked = true;
    if (mode === 'amap') Basemap.showAmap();
    else if (mode === 'raster') { Basemap.destroyVector(); Basemap.showRaster(); Basemap.setMode('raster', 'wgs84'); }
    else if (mode === 'blank') {
      Basemap.destroyVector();
      Basemap.removeRaster();
      Basemap.setMode('blank', 'wgs84');
    }
    return Basemap.mode;
  },
  rebuildScene: function () {
    Scene.build(App.plan);
    Scene.updateHeader(0);
    Scene.updateStats([0]);
    Scene.updateCredit();
    return true;
  }
};

boot();
