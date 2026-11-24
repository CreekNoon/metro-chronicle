(() => {
  const out = { checks: [] };
  const add = (name, ok, detail) => out.checks.push({ name: name, ok: !!ok, detail: String(detail === undefined ? '' : detail) });
  let storageOk = false;
  let storageError = '';
  try {
    window.localStorage.setItem('__probe__', '1');
    storageOk = window.localStorage.getItem('__probe__') === '1';
    window.localStorage.removeItem('__probe__');
  } catch (e) {
    storageError = String(e && e.message);
  }
  add('file:// 下 localStorage 可用（双击打开即可持久化）', storageOk, storageError || 'ok');

  const M = window.__METRO__;
  add('应用已启动（内核可访问）', !!M && !!M.App && !!M.App.map);
  add('内联 Leaflet 版本 1.9.4', !!(window.L && window.L.version === '1.9.4'), window.L ? window.L.version : 'missing');
  add('内联 GSAP 版本 3.12.5', !!(window.gsap && window.gsap.version === '3.12.5'), window.gsap ? window.gsap.version : 'missing');
  add('无外部样式表依赖', document.querySelectorAll('link[rel="stylesheet"]').length === 0,
    document.querySelectorAll('link[rel="stylesheet"]').length);

  // 图片素材：只允许底图瓦片（<img class="leaflet-tile">），不允许装饰性外部图片
  const imgs = Array.from(document.querySelectorAll('img'));
  const decorative = imgs.filter((img) => !img.classList.contains('leaflet-tile') && !img.closest('.leaflet-tile-pane'));
  add('无装饰性外部图片素材', decorative.length === 0, decorative.length + '/' + imgs.length);

  add('无第三方 UI 框架全局变量', !window.jQuery && !window.React && !window.Vue && !window.bootstrap,
    [!!window.jQuery, !!window.React, !!window.Vue].join(','));

  // 外部脚本：只允许 MapLibre（矢量底图运行时异步加载，带超时与降级）
  const scripts = Array.from(document.querySelectorAll('script[src]')).map((s) => ({
    src: s.getAttribute('src'),
    async: s.async
  }));
  const nonMapLibre = scripts.filter((s) => !/maplibre-gl/.test(s.src));
  add('外部脚本仅限 MapLibre 矢量运行时', nonMapLibre.length === 0, scripts.map((s) => s.src).join('|') || 'none');
  add('外部脚本为异步加载（不阻塞出图）', scripts.every((s) => s.async === true),
    scripts.map((s) => s.async).join(','));

  return JSON.stringify({ pass: out.checks.filter(c => c.ok).length, total: out.checks.length, checks: out.checks });
})()
