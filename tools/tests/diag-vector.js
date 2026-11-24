(async () => {
  const M = window.__METRO__;
  const B = M.Basemap;
  const out = { start: performance.now() };
  out.maplibreGlobal = typeof window.maplibregl;
  try {
    const t0 = performance.now();
    const res = await fetch('https://tiles.openfreemap.org/styles/positron', { mode: 'cors' });
    out.styleFetch = { status: res.status, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    out.styleFetch = { error: String(err && err.message) };
  }
  const t1 = performance.now();
  const loaded = await B.loadMaplibre();
  out.scriptLoad = { loaded: loaded, ms: Math.round(performance.now() - t1) };

  B.decisionClosed = false;
  const t2 = performance.now();
  let ok = false;
  let err = '';
  try {
    ok = await B.tryVector();
  } catch (e) {
    err = String(e && e.message);
  }
  out.vector = {
    ok: ok,
    ms: Math.round(performance.now() - t2),
    mode: B.mode,
    hasInstance: !!B.vectorMap,
    el: !!B.vectorEl
  };
  if (err) out.vector.error = err;
  out.total = Math.round(performance.now() - out.start);
  return JSON.stringify(out);
})()
