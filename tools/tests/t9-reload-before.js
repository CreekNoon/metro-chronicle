(async () => {
  const M = window.__METRO__;
  const A = M.App, E = M.Edit;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const t0 = performance.now();
  while (!M.Story.finished && performance.now() - t0 < 40000) await sleep(120);

  /* 第一段：编辑并保存，随后由探针指令 __RELOAD__ 重新加载页面 */
  E.enter();
  await sleep(300);
  const station = A.plan.lines[0].stations[0];
  E.select(station.key);
  await sleep(120);
  const input = document.querySelector('#editCard [data-act="name"]');
  input.value = '持久化云龙';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);

  E.select(A.plan.lines[0].stations[3].key);
  await sleep(150);
  const ghostBox = document.querySelector('#editCard [data-act="ghost"]');
  ghostBox.checked = true;
  ghostBox.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);

  const linesBefore = A.plan.lines.length;
  const entriesBefore = A.plan.lines.reduce((sum, l) => sum + l.stations.length, 0);
  const ghostKey = A.plan.lines[0].stations[3].key;
  E.exit();
  await sleep(600);

  const raw = window.localStorage.getItem('metroChronicle.v2.plan.zhuzhou');
  add('编辑后站名已保存', A.plan.lines[0].stations[0].name === '持久化云龙', A.plan.lines[0].stations[0].name);
  add('ghost 标记已保存', A.plan.lines[0].stations[3].ghost === true, A.plan.lines[0].stations[3].ghost);
  add('localStorage 已落盘', !!raw && raw.indexOf('持久化云龙') > 0, raw ? raw.length + ' 字节' : 'missing');

  return JSON.stringify({
    pass: checks.filter(c => c.ok).length,
    total: checks.length,
    checks: checks,
    expect: { linesBefore: linesBefore, entriesBefore: entriesBefore, ghostKey: ghostKey }
  });
})()
