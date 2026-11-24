/* ==========================================================================
   72 · 城市搜索（支持到区县/街道）
   —— 优先调用高德行政区查询（v3/config/district，可搜到县级市 / 区 / 街道），
      断网或没有 Key 时退化为本地城市名过滤；选中后按级别生成/切换城市。
   ========================================================================== */

var CITY_LEVEL_LABEL = {
  country: '国家',
  province: '省级',
  city: '地级市',
  district: '区县',
  street: '街道',
  custom: '自定义',
  preset: '内置'
};

var CITY_LEVEL_ZOOM = {
  country: 4,
  province: 7,
  city: 11,
  district: 13,
  street: 15
};

var CitySearch = {
  timer: 0,
  requestId: 0,
  results: [],
  keyword: '',
  status: 'idle',      // idle | loading | done | offline
  lastSource: 'none',

  open: function () {
    var input = $('#citySearchInput');
    if (input) input.value = '';
    this.keyword = '';
    this.results = [];
    this.status = 'idle';
    this.renderResults([]);
    openSheet('searchSheet');
    if (input) window.setTimeout(function () { input.focus(); }, 60);
  },

  /** 输入防抖 320ms：先给本地结果，再补高德结果 */
  onInput: function (value) {
    var self = this;
    this.keyword = String(value || '').trim();
    window.clearTimeout(this.timer);
    if (!this.keyword) {
      this.results = [];
      this.status = 'idle';
      this.renderResults([]);
      return;
    }
    // 本地结果立刻可见
    this.results = this.localMatches(this.keyword);
    this.status = 'loading';
    this.renderResults(this.results);
    this.timer = window.setTimeout(function () { self.searchRemote(self.keyword); }, 320);
  },

  localMatches: function (keyword) {
    var kw = String(keyword || '').trim();
    if (!kw) return [];
    var customs = loadCustomCities();
    return listCities().filter(function (city) {
      return city.name.indexOf(kw) >= 0;
    }).map(function (city) {
      var preset = findPreset(city.id);
      var custom = customs.filter(function (item) { return item.id === city.id; })[0];
      var view = preset ? preset.view : (custom ? custom.view : null);
      return {
        id: city.id,
        name: city.name,
        level: city.custom ? 'custom' : 'preset',
        lat: view ? view.center[0] : null,
        lng: view ? view.center[1] : null,
        source: 'local',
        existing: true
      };
    });
  },

  /** 高德行政区查询：可搜到地级市 / 县级市 / 区 / 街道 */
  searchRemote: function (keyword) {
    var self = this;
    var key = getStoredAmapKey();
    if (!key || !/^[0-9a-fA-F]{32}$/.test(key)) {
      this.status = 'offline';
      this.renderResults(this.results);
      return Promise.resolve([]);
    }
    var requestId = (this.requestId += 1);
    var url = BASEMAP_SOURCES.amapDistrict +
      '?keywords=' + encodeURIComponent(keyword) +
      '&subdistrict=0&extensions=base&key=' + encodeURIComponent(key);

    return fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(3500) : undefined })
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        if (requestId !== self.requestId) return [];           // 过期响应丢弃
        if (!payload || String(payload.status) !== '1') {
          self.status = 'done';
          self.renderResults(self.results);
          return [];
        }
        var remote = (payload.districts || []).slice(0, 8).map(function (district) {
          var center = String(district.center || '').split(',');
          var gcjLng = Number(center[0]);
          var gcjLat = Number(center[1]);
          var wgs = isFiniteNumber(gcjLat) && isFiniteNumber(gcjLng) && gcjLat !== 0
            ? gcj02ToWgs84(gcjLat, gcjLng)
            : null;
          return {
            id: 'amap-' + (district.adcode || district.name),
            name: district.name,
            level: district.level || 'district',
            lat: wgs ? wgs[0] : null,
            lng: wgs ? wgs[1] : null,
            adcode: district.adcode || '',
            source: 'amap'
          };
        }).filter(function (item) { return item.lat !== null && item.lng !== null; });

        var seen = {};
        self.results.forEach(function (item) { seen[item.name] = true; });
        remote.forEach(function (item) { if (!seen[item.name]) self.results.push(item); });

        self.lastSource = remote.length ? 'amap' : self.lastSource;
        self.status = 'done';
        self.renderResults(self.results);
        return remote;
      })
      .catch(function () {
        if (requestId !== self.requestId) return [];
        self.status = 'offline';
        self.renderResults(self.results);
        return [];
      });
  },

  renderResults: function (results) {
    var list = $('#citySearchResults');
    var hint = $('#citySearchHint');
    if (hint) {
      if (this.status === 'loading') hint.textContent = '正在搜索（本地 + 高德行政区）…';
      else if (this.status === 'offline') hint.textContent = '高德不可用，仅显示本地城市。';
      else if (this.keyword && !results.length && this.status === 'done') hint.textContent = '没有找到匹配的城市或区县。';
      else if (!this.keyword) hint.textContent = '输入城市、区县或街道名，例如「株洲」「雨湖区」「韶山」。';
      else hint.textContent = '共 ' + results.length + ' 个结果，点击即可创建/切换城市。';
    }
    if (!list) return;
    if (!results.length) { list.innerHTML = ''; return; }

    list.innerHTML = results.map(function (item, index) {
      var level = CITY_LEVEL_LABEL[item.level] || item.level;
      var meta = item.existing ? '已存在' : (item.source === 'amap' ? '高德' : '本地');
      return '' +
        '<button type="button" class="search-row" data-index="' + index + '">' +
          '<span class="search-name">' + escapeHtml(item.name) + '</span>' +
          '<span class="search-tag">' + escapeHtml(level) + '</span>' +
          '<span class="search-meta">' + escapeHtml(meta) + '</span>' +
        '</button>';
    }).join('');
  },

  /** 选中一条结果：已存在就切过去，否则按中心点新建城市并进入编辑 */
  choose: function (index) {
    var item = this.results[index];
    if (!item) return;
    closeSheet('searchSheet');

    if (item.existing && item.id) {
      CityUI.switchCity(item.id);
      return;
    }
    if (!isValidLatLng(item.lat, item.lng)) {
      toast('该结果没有可用的中心坐标');
      return;
    }
    var zoom = CITY_LEVEL_ZOOM[item.level] || 12;
    var cityId = createCustomCity(item.name, [item.lat, item.lng], zoom);
    CityUI.renderSelect();
    CityUI.switchCity(cityId);
    toast('已创建「' + item.name + '」，可在地图上点选站点');
  },

  bind: function () {
    var self = this;
    var input = $('#citySearchInput');
    if (input) {
      input.addEventListener('input', function () { self.onInput(input.value); });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && self.results.length) {
          event.preventDefault();
          self.choose(0);
        }
      });
    }
    var list = $('#citySearchResults');
    if (list) {
      list.addEventListener('click', function (event) {
        var row = event.target && event.target.closest ? event.target.closest('.search-row') : null;
        if (!row) return;
        self.choose(Number(row.dataset.index));
      });
    }
    var button = $('#citySearchBtn');
    if (button) button.addEventListener('click', function () { self.open(); });
  }
};
