(async () => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, E = M.Edit;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const log = [];
  const step = async (name, fn) => {
    try { const v = await fn(); log.push({ step: name, ok: true, value: v }); return v; }
    catch (e) { log.push({ step: name, ok: false, error: String(e && e.message) }); throw e; }
  };
  const clickMapAt = (lat, lng) => {
    const map = A.map;
    const pt = map.latLngToContainerPoint(L.latLng(lat, lng));
    const box = map.getContainer().getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: box.left + pt.x, clientY: box.top + pt.y };
    const el = map.getContainer();
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };
  try {
    await step('planLines', () => A.plan.lines.length);
    await step('enterEdit', () => { document.getElementById('editBtn').click(); return E.active; });
    await sleep(150);
    await step('afterEnter', () => ({ active: E.active, markers: Object.keys(E.markers).length, counts: A.plan.lines.map(l => l.stations.length), barButtons: document.querySelectorAll('#editBar button').length, editingClass: document.body.className }));
    await step('clickEmpty', () => { clickMapAt(27.9250, 113.2000); return A.plan.lines[0].stations.length; });
    await sleep(120);
    await step('afterClick', () => ({ counts: A.plan.lines.map(l => l.stations.length), selected: E.selectedKey, cardOn: document.getElementById('editCard').classList.contains('is-on') }));
    await step('clickNearSameLine', () => {
      const anchor = A.plan.lines[0].stations[1];
      clickMapAt(anchor.lat + 0.0002, anchor.lng);
      return { counts: A.plan.lines.map(l => l.stations.length), selected: E.selectedKey, anchor: anchor.key };
    });
    await sleep(100);
    await step('switchLine', () => { document.querySelectorAll('#editBar [data-act="line"]')[1].click(); return E.lineIndex; });
    await sleep(100);
    await step('afterSwitchLine', () => ({ lineIndex: E.lineIndex, counts: A.plan.lines.map(l => l.stations.length), buttons: Array.from(document.querySelectorAll('#editBar [data-act="line"]')).map(b => b.textContent.trim()) }));
    await step('clickCrossLine', () => {
      const other = A.plan.lines[0].stations[3];
      clickMapAt(other.lat - 0.0005, other.lng);
      return { counts: A.plan.lines.map(l => l.stations.length), otherKey: other.key };
    });
    await sleep(120);
    await step('afterCrossClick', () => ({ counts: A.plan.lines.map(l => l.stations.length), selected: E.selectedKey, toast: document.getElementById('toast').textContent }));
  } catch (err) {
    return JSON.stringify({ failed: String(err && err.message), log: log });
  }
  return JSON.stringify({ failed: null, log: log });
})()
