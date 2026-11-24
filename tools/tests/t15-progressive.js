(() => {
  const M = window.__METRO__;
  const A = M.App, S = M.Scene, St = M.Story;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const gradientOf = (key) => {
    const node = S.stations[key];
    return node && node.refs && node.refs.ring ? String(getComputedStyle(node.refs.ring).backgroundImage) : '';
  };
  // conic-gradient 的每个色段会输出起止两个色标，这里按「唯一颜色」统计
  const colorsIn = (text) => Array.from(new Set((text.match(/rgb\([^)]+\)/g) || []).filter(c => c !== 'rgb(255, 255, 255)')));
  const stateOf = (key) => (S.stations[key] ? S.stations[key].state : 'missing');

  /* 从头构建场景，按「线路陆续开通」推进，检查换乘配色的渐进过程 */
  St.stop();
  S.build(A.plan);
  S.openedLineKeys = {};

  /* --- 1) 一条线开通：株洲站（2/3/城际三条线共站）仍为单色 --- */
  S.openedLineKeys['zz-l2'] = true;
  S.drawProgress(1, 1);
  add('单线开通时共站仍为普通站点', stateOf('zz-zhuzhouzhan') === 'opened', stateOf('zz-zhuzhouzhan'));
  add('单线开通时不加换乘渐变', colorsIn(gradientOf('zz-zhuzhouzhan')).length === 0 ||
    /none/.test(gradientOf('zz-zhuzhouzhan')), gradientOf('zz-zhuzhouzhan').slice(0, 60));

  /* --- 2) 第二条线（3 号线）开通：变两色 --- */
  S.openedLineKeys['zz-l3'] = true;
  S.drawProgress(2, 1);
  const twoColors = colorsIn(gradientOf('zz-zhuzhouzhan'));
  add('两条线开通后升级为换乘站', stateOf('zz-zhuzhouzhan') === 'transfer', stateOf('zz-zhuzhouzhan'));
  add('两线换乘为两色圆环', /conic-gradient/.test(gradientOf('zz-zhuzhouzhan')) && twoColors.length === 2,
    JSON.stringify(twoColors));
  add('两色分别来自 2 号线蓝与 3 号线绿',
    twoColors.indexOf('rgb(0, 104, 183)') >= 0 && twoColors.indexOf('rgb(15, 138, 99)') >= 0, JSON.stringify(twoColors));

  /* --- 3) 第三条线（城际）开通：才变三色 --- */
  S.openedLineKeys['zz-ic'] = true;
  S.drawProgress(3, 1);
  const threeColors = colorsIn(gradientOf('zz-zhuzhouzhan'));
  add('第三条线接入后变成三色圆环', /conic-gradient/.test(gradientOf('zz-zhuzhouzhan')) && threeColors.length === 3,
    JSON.stringify(threeColors));
  add('三色含城际紫', threeColors.indexOf('rgb(123, 94, 167)') >= 0, JSON.stringify(threeColors));

  /* --- 4) 其它共站同理：清水塘（1 号线 + 2 号线）→ 两色 --- */
  S.build(A.plan);
  S.openedLineKeys = { 'zz-l1': true };
  S.drawProgress(0, 1);
  add('1 号线刚开通时清水塘是单色的暂未开通', stateOf('zz-qingshuitang') === 'ghost', stateOf('zz-qingshuitang'));
  add('此时清水塘没有换乘渐变', !/conic-gradient/.test(gradientOf('zz-qingshuitang')), gradientOf('zz-qingshuitang').slice(0, 60));
  S.openedLineKeys['zz-l2'] = true;
  S.drawProgress(1, 1);
  const qColors = colorsIn(gradientOf('zz-qingshuitang'));
  add('清水塘在 2 号线接入后变两色换乘', stateOf('zz-qingshuitang') === 'transfer' && qColors.length === 2,
    stateOf('zz-qingshuitang') + ' / ' + JSON.stringify(qColors));

  /* --- 5) 只有一条线的站点永远不加渐变 --- */
  add('单线站点无换乘渐变', !/conic-gradient/.test(gradientOf('zz-tianyi')), gradientOf('zz-tianyi').slice(0, 60));
  add('单线站点状态为 opened', stateOf('zz-tianyi') === 'opened', stateOf('zz-tianyi'));

  return JSON.stringify({ pass: checks.filter(c => c.ok).length, total: checks.length, checks: checks });
})()
