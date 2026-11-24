/* ==========================================================================
   50 · 时间轴：开场 → 逐条线路开通 → 结束（线路数量、顺序由所选线路决定）
   —— 每次播放都以 Scene.build() 重建场景，天然满足“重播完整复位”
   ========================================================================== */

var STORY_TIMING = {
  intro: 0.9,            // 遮罩淡出 + HUD 依次上浮
  lineBase: 1.0,         // 每条线路绘制的基础时长
  linePerStation: 0.36,  // 每多一站增加的绘制时长
  lineMin: 2.4,
  lineMax: 6.2,
  gap: 0.1,              // 一条线画完到下一次过渡之间的呼吸
  transition: 0.95,      // 日期翻转 + 线路头切换 + 数据面板切换
  outro: 0.6
};

/** 单条线路的绘制时长：站越多、画得越久，但控制在可接受区间 */
function lineDrawDuration(line) {
  var duration = STORY_TIMING.lineBase + STORY_TIMING.linePerStation * line.stations.length;
  return clamp(duration, STORY_TIMING.lineMin, STORY_TIMING.lineMax);
}

var Story = {
  tl: null,
  playing: false,
  finished: false,
  phase: -1,
  startedAt: 0,
  phases: [],
  slots: [],

  /** 参与播放的线路下标：勾选 + 至少 2 站 */
  playableLineIndexes: function () {
    var plan = App.plan;
    if (!plan) return [];
    var indexes = [];
    plan.lines.forEach(function (line, index) {
      if (typeof LineSelection !== 'undefined' && !LineSelection.isSelected(line.key)) return;
      if (line.stations.length < 2) return;
      indexes.push(index);
    });
    return indexes;
  },

  /** 当前阶段应统计的线路（渐进式累加） */
  phaseLineIndexes: function () {
    return this.phases.slice(0, Math.max(1, this.phase + 1));
  },

  slotFor: function (index) {
    if (!this.slots[index]) this.slots[index] = { value: 0 };
    return this.slots[index];
  },

  /* --------------------------------------------------------------- 播放 */

  play: function () {
    if (!App.plan) return null;
    this.reset();

    // 记录“多快开场”：performance.now() 即页面导航以来的毫秒数
    this.startedAt = Math.round(performance.now());

    Scene.build(App.plan);
    setMapLocked(true);

    var self = this;
    var timing = STORY_TIMING;
    var phases = this.playableLineIndexes();
    this.phases = phases;

    var firstIndex = phases.length ? phases[0] : 0;
    this.phase = 0;
    Scene.updateHeader(firstIndex);
    Scene.updateStats([firstIndex]);
    Scene.updateCredit();
    this.playing = true;

    var tl = gsap.timeline({
      defaults: { overwrite: 'auto' },
      onComplete: function () {
        self.playing = false;
        self.finished = true;
        (App.plan ? App.plan.lines : []).forEach(function (_, index) {
          Scene.setHeadVisible(index, false);
        });
      }
    });
    this.tl = tl;

    var veil = $('#veil');
    if (veil) {
      gsap.set(veil, { opacity: 1 });
      tl.to(veil, { opacity: 0, duration: 0.8, ease: 'power2.out' }, 0);
    }

    var hudItems = [$('#timeCapsule'), $('#lineHead'), $('#stats'), $('#replayBtn'), $('#skipBtn'), $('#credit'), $('#controls'), $('#zoomCtl')].filter(Boolean);
    if (hudItems.length) {
      tl.from(hudItems, { y: 16, opacity: 0, duration: 0.85, stagger: 0.07, ease: 'power3.out' }, 0.05);
    }

    if (!phases.length) {
      // 没有可播放线路（全空或未勾选）：只做开场，停在进行态
      tl.call(function () { self.finished = true; self.playing = false; }, null, 0.6);
      return tl;
    }

    var cursor = timing.intro + 0.1;

    phases.forEach(function (lineIndex, k) {
      var line = App.plan.lines[lineIndex];
      if (!line) return;

      if (k > 0) {
        // ---- 过渡：日期翻页 + 线路头淡出淡入 + 数据面板切换 ----
        var at = cursor;
        var dateText = $('#dateText');
        var lineHead = $('#lineHead');
        var statsPanel = $('#stats');

        if (lineHead) tl.to(lineHead, { opacity: 0, y: -7, duration: 0.26, ease: 'power2.in' }, at);
        if (dateText) tl.to(dateText, {
          rotationX: -88,
          opacity: 0,
          transformOrigin: '50% 100%',
          duration: 0.3,
          ease: 'power2.in'
        }, at);
        if (statsPanel) tl.to(statsPanel, { opacity: 0.45, duration: 0.3, ease: 'power2.in' }, at);

        tl.call(function () {
          self.phase = k;
          Scene.updateHeader(lineIndex);
          Scene.updateStats(self.phaseLineIndexes());
          Scene.updateCredit();
        }, null, at + 0.3);

        if (dateText) {
          tl.fromTo(dateText, { rotationX: 88, opacity: 0 }, {
            rotationX: 0,
            opacity: 1,
            duration: 0.42,
            ease: 'power2.out',
            clearProps: 'transform'
          }, at + 0.3);
        }
        if (lineHead) tl.to(lineHead, { opacity: 1, y: 0, duration: 0.44, ease: 'power2.out' }, at + 0.32);
        if (statsPanel) tl.to(statsPanel, { opacity: 1, duration: 0.44, ease: 'power2.out' }, at + 0.32);

        cursor = at + timing.transition;
      }

      // ---- 绘制本条线路 ----
      var slot = self.slotFor(k);
      slot.value = 0;
      var duration = lineDrawDuration(line);

      tl.call(function () { self.startPhase(lineIndex, k); }, null, cursor);
      tl.to(slot, {
        value: 1,
        duration: duration,
        ease: 'none',
        onUpdate: function () { Scene.drawProgress(lineIndex, slot.value); }
      }, cursor);
      tl.call(function () { Scene.setHeadVisible(lineIndex, false); }, null, cursor + duration + 0.05);

      cursor += duration + timing.gap;
    });

    tl.call(function () { self.finish(); }, null, cursor + timing.outro);
    return tl;
  },

  /** 进入某条线的绘制阶段：HEAD 标记出现 + 视图保持不变 */
  startPhase: function (lineIndex, phase) {
    var line = App.plan && App.plan.lines[lineIndex];
    if (!line) return;
    this.phase = phase;
    if (line.stations.length < 2) return;
    Scene.setHeadVisible(lineIndex, true);
    var route = Scene.routes[line.key];
    var geometry = Scene.geometries[line.key];
    if (route && geometry && geometry.render.length) {
      var head = geometry.render[0];
      route.head.setLatLng(L.latLng(head[0], head[1]));
      route.head.setOpacity(1);
    }
  },

  /** 结束态：保持完成态，头部标记淡出 */
  finish: function () {
    var plan = App.plan;
    if (!plan) return;
    plan.lines.forEach(function (_, index) { Scene.setHeadVisible(index, false); });
    var phases = this.phases.length ? this.phases : plan.lines.map(function (_, index) { return index; });
    var last = phases[phases.length - 1];
    this.phase = phases.length - 1;
    Scene.updateHeader(last);
    Scene.updateStats(phases);
    Scene.updateCredit();
    // 站点状态变化（换乘/城际胶囊出现）会让标签变宽，收尾时再避让一次
    Scene.resolveLabelSides();
    this.finished = true;
  },

  /** 跳过动画：直接渲染到终态（长线路网络时很好用） */
  skip: function () {
    if (!this.tl || this.finished) return;
    this.tl.progress(1, false);
  },

  /* --------------------------------------------------------------- 复位 */

  reset: function () {
    killTimeline(this.tl);
    this.tl = null;
    this.playing = false;
    this.finished = false;
    this.phase = -1;
    this.phases = [];
    this.slots = [];

    var hud = [$('#dateText'), $('#lineHead'), $('#stats'), $('#timeCapsule'), $('#credit'), $('#replayBtn'), $('#skipBtn'), $('#controls'), $('#zoomCtl')];
    hud.forEach(function (el) {
      if (!el) return;
      killTweens(el);
      if (window.gsap) gsap.set(el, { clearProps: 'transform,opacity,visibility,transform-origin' });
      else el.removeAttribute('style');
    });

    var veil = $('#veil');
    if (veil) {
      killTweens(veil);
      veil.style.opacity = '1';
    }
  },

  /** 退出播放（进入编辑 / 切换城市时调用），不保留任何动画状态 */
  stop: function () {
    killTimeline(this.tl);
    this.tl = null;
    this.playing = false;
    var veil = $('#veil');
    if (veil) {
      killTweens(veil);
      veil.style.opacity = '0';
    }
  },

  replay: function () {
    if (!App.plan) return;
    this.play();
  }
};
