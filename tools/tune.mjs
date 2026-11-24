// 里程标定工具：复用 src 里的真实几何实现，验证预设坐标是否落在 30km / 48km 目标上
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '..', 'src');

const [util, geometry] = await Promise.all([
  readFile(path.join(srcDir, '00-util.js'), 'utf8'),
  readFile(path.join(srcDir, '30-geometry.js'), 'utf8')
]);

const candidates = {
  zhuzhou: {
    l1: [
      ['云龙', 27.9620, 113.2330],
      ['田心', 27.8960, 113.1490],
      ['清水塘', 27.8795, 113.0930],
      ['栗雨', 27.8300, 113.0650],
      ['天易', 27.7950, 113.0350],
      ['株洲西站', 27.7790, 113.0455]
    ],
    l2: [
      ['清水塘', 27.8795, 113.0930],
      ['白石港', 27.8560, 113.1250],
      ['株洲站', 27.8290, 113.1420],
      ['红旗广场', 27.8420, 113.1720],
      ['金山新城', 27.8830, 113.2280]
    ]
  },
  xiangtan: {
    l1: [
      ['湘潭北站', 27.9430, 112.9350],
      ['九华', 27.9200, 112.9600],
      ['和平公园', 27.8800, 112.9300],
      ['雨湖', 27.8600, 112.9100],
      ['湘潭站', 27.8489, 112.9130]
    ],
    l2: [
      ['湘潭站', 27.8489, 112.9130],
      ['建设路口', 27.8400, 112.9450],
      ['友谊广场', 27.8300, 112.9600],
      ['岳塘', 27.8250, 112.9800]
    ]
  }
};

const body = `
  const candidates = ${JSON.stringify(candidates)};
  const report = [];
  for (const [city, lines] of Object.entries(candidates)) {
    let sum = 0; let entries = 0; const keys = new Set();
    for (const [name, arr] of Object.entries(lines)) {
      const sts = arr.map((s) => ({ key: s[0], name: s[0], lat: s[1], lng: s[2] }));
      sts.forEach(s => keys.add(s.key));
      entries += sts.length;
      const geo = buildLineGeometry(sts, null);
      const km = geo.totalMeters / 1000;
      sum += km;
      report.push({ city, line: name, stations: sts.length, km: Math.round(km * 100) / 100, drawnKm: Math.round(km) });
      const segs = [];
      for (let i = 1; i < sts.length; i++) segs.push(Math.round(haversineMeters([sts[i-1].lat, sts[i-1].lng], [sts[i].lat, sts[i].lng]) / 100) / 10);
      report.push({ city, line: name, segmentsKm: segs, samples: geo.samples.length, ratios: geo.stationRatio.map(r => Math.round(r * 1000) / 1000) });
    }
    report.push({ city, totalKm: Math.round(sum * 100) / 100, totalRounded: Math.round(sum), stationEntries: entries, uniqueKeys: keys.size });
  }
  return report;
`;

const run = new Function(`${util}\n${geometry}\n${body}`);
console.log(JSON.stringify(run(), null, 2));
