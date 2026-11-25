#!/usr/bin/env node
/**
 * 把城市范围内的底图瓦片打包成一个 PMTiles v3 单文件（离线底图）。
 *
 * 用法：
 *   node tools/build-pmtiles.mjs [--min=9] [--max=13] [--pad=0.02] [--out=assets/hunan-light.pmtiles]
 *
 * 说明：
 * - 瓦片源：Esri Canvas World Light Gray（JPEG，WGS84，无 GCJ-02 偏移，允许跨域）
 * - 瓦片类型 JPEG / 无压缩 / 无内部压缩 / 无叶子目录（单层 root 索引）
 * - 脚本自带一个最小 PMTiles 读取器做自校验（写入后回读逐字节比对）
 * - 仓库保持零运行时依赖：本脚本只用 Node 内置能力
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const MIN_Z = Number(argOf('min', '9'));
const MAX_Z = Number(argOf('max', '13'));
const PAD = Number(argOf('pad', '0.02'));
const OUT = path.resolve(repo, argOf('out', 'assets/hunan-light.pmtiles'));
const CONCURRENCY = Number(argOf('concurrency', '6'));

const TILE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;

/* ------------------------------------------------------- Hilbert / tileId */

const TZ_VALUES = [
  0, 1, 5, 21, 85, 341, 1365, 5461, 21845, 87381, 349525, 1398101, 5592405,
  22369621, 89478485, 357913941, 1431655765, 5726623061, 22906492245,
  91625968981, 366503875925, 1466015503701, 5864062014805, 23456248059221,
  93824992236885, 375299968947541, 1501199875790165
];

function rotate(n, xy, rx, ry) {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0];
      xy[1] = n - 1 - xy[1];
    }
    const t = xy[0];
    xy[0] = xy[1];
    xy[1] = t;
  }
}

/** 与 protomaps/PMTiles 完全一致的 z/x/y → tileId（Hilbert） */
function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error('zoom too big');
  const acc = TZ_VALUES[z];
  const n = Math.pow(2, z);
  let d = 0;
  const xy = [x, y];
  let s = n / 2;
  while (s > 0) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
    s = s / 2;
  }
  return acc + d;
}

/* --------------------------------------------------------------- varint */

function writeVarint(out, value) {
  let v = Math.floor(value);
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
}

function readVarint(buf, state) {
  let result = 0;
  let shift = 1;
  let byte;
  do {
    byte = buf[state.pos++];
    result += (byte & 0x7f) * shift;
    shift *= 128;
  } while (byte & 0x80);
  return result;
}

/* --------------------------------------------------------- 经纬度 → 瓦片 */

function lngToTileX(lng, z) {
  return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  const n = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return Math.floor(((1 - n / Math.PI) / 2) * Math.pow(2, z));
}

/* ------------------------------------------------- 从城市预设里取包围盒 */

async function boundsFromPresets() {
  const source = await readFile(path.join(repo, 'src', '10-cities.js'), 'utf8');
  const lats = [];
  const lngs = [];
  const pattern = /lat:\s*(-?\d+(?:\.\d+)?)\s*,\s*lng:\s*(-?\d+(?:\.\d+)?)/g;
  let match;
  while ((match = pattern.exec(source))) {
    lats.push(Number(match[1]));
    lngs.push(Number(match[2]));
  }
  if (!lats.length) throw new Error('没能从 src/10-cities.js 解析出站点坐标');
  return {
    minLat: Math.min(...lats) - PAD,
    maxLat: Math.max(...lats) + PAD,
    minLng: Math.min(...lngs) - PAD,
    maxLng: Math.max(...lngs) + PAD,
    count: lats.length
  };
}

/* ------------------------------------------------------------- 抓瓦片 */

async function fetchTile(z, x, y, attempt = 0) {
  try {
    const res = await fetch(TILE_URL(z, x, y), {
      headers: { 'User-Agent': 'metro-chronicle-pmtiles-builder/1.0' }
    });
    if (!res.ok) throw new Error('status ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) throw new Error('tile too small');
    const magic = buf.subarray(0, 3).toString('hex');
    if (magic !== 'ffd8ff') throw new Error('not jpeg: ' + magic);
    return buf;
  } catch (err) {
    if (attempt >= 2) {
      console.warn(`  ! tile ${z}/${x}/${y} 失败：${err.message}`);
      return null;
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    return fetchTile(z, x, y, attempt + 1);
  }
}

async function collectTiles(bounds) {
  const jobs = [];
  for (let z = MIN_Z; z <= MAX_Z; z += 1) {
    const x0 = lngToTileX(bounds.minLng, z);
    const x1 = lngToTileX(bounds.maxLng, z);
    const y0 = latToTileY(bounds.maxLat, z);
    const y1 = latToTileY(bounds.minLat, z);
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) jobs.push({ z, x, y });
    }
  }

  const tiles = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const data = await fetchTile(job.z, job.x, job.y);
      if (data) tiles.push({ ...job, data });
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  tiles.sort((a, b) => zxyToTileId(a.z, a.x, a.y) - zxyToTileId(b.z, b.x, b.y));
  return tiles;
}

/* ------------------------------------------------------- 写 PMTiles v3 */

function buildArchive(tiles, bounds, meta) {
  const entries = tiles.map((tile) => ({
    tileId: zxyToTileId(tile.z, tile.x, tile.y),
    runLength: 1,
    length: tile.data.length,
    offset: 0
  }));

  let offset = 0;
  entries.forEach((entry) => {
    entry.offset = offset;
    offset += entry.length;
  });
  const tileDataLength = offset;

  const dir = [];
  writeVarint(dir, entries.length);
  let lastId = 0;
  entries.forEach((entry) => {
    writeVarint(dir, entry.tileId - lastId);
    lastId = entry.tileId;
  });
  entries.forEach((entry) => writeVarint(dir, entry.runLength));
  entries.forEach((entry) => writeVarint(dir, entry.length));
  let lastOffset = 0;
  entries.forEach((entry, index) => {
    const contiguous = index > 0 && entry.offset === lastOffset;
    writeVarint(dir, contiguous ? 0 : entry.offset + 1);
    lastOffset = entry.offset + entry.length;
  });

  const rootDir = Buffer.from(dir);
  const metadata = Buffer.from(JSON.stringify(meta), 'utf8');

  const rootOffset = 127;
  const metaOffset = rootOffset + rootDir.length;
  const leafOffset = metaOffset + metadata.length;
  const tileOffset = leafOffset;

  const header = Buffer.alloc(127);
  header.write('PMTiles', 0, 'ascii');
  header.writeUInt8(3, 7);
  header.writeBigUInt64LE(BigInt(rootOffset), 8);
  header.writeBigUInt64LE(BigInt(rootDir.length), 16);
  header.writeBigUInt64LE(BigInt(metaOffset), 24);
  header.writeBigUInt64LE(BigInt(metadata.length), 32);
  header.writeBigUInt64LE(0n, 40);                       // leaves offset
  header.writeBigUInt64LE(0n, 48);                       // leaves length
  header.writeBigUInt64LE(BigInt(tileOffset), 56);
  header.writeBigUInt64LE(BigInt(tileDataLength), 64);
  header.writeBigUInt64LE(BigInt(entries.length), 72);    // addressed tiles
  header.writeBigUInt64LE(BigInt(entries.length), 80);    // tile entries
  header.writeBigUInt64LE(BigInt(entries.length), 88);    // tile contents
  header.writeUInt8(1, 96);                               // clustered
  header.writeUInt8(1, 97);                               // internal compression: none
  header.writeUInt8(1, 98);                               // tile compression: none
  header.writeUInt8(3, 99);                               // tile type: JPEG
  header.writeUInt8(MIN_Z, 100);
  header.writeUInt8(MAX_Z, 101);
  header.writeInt32LE(Math.round(bounds.minLng * 1e7), 102);
  header.writeInt32LE(Math.round(bounds.minLat * 1e7), 106);
  header.writeInt32LE(Math.round(bounds.maxLng * 1e7), 110);
  header.writeInt32LE(Math.round(bounds.maxLat * 1e7), 114);
  header.writeUInt8(Math.min(MAX_Z, Math.round((MIN_Z + MAX_Z) / 2)), 118);
  header.writeInt32LE(Math.round(((bounds.minLng + bounds.maxLng) / 2) * 1e7), 119);
  header.writeInt32LE(Math.round(((bounds.minLat + bounds.maxLat) / 2) * 1e7), 123);

  return Buffer.concat([
    header,
    rootDir,
    metadata,
    ...tiles.map((tile) => tile.data)
  ]);
}

/* --------------------------------------------------- 最小读取器（自校验） */

function makeReader(buffer) {
  const header = {
    rootOffset: Number(buffer.readBigUInt64LE(8)),
    rootLength: Number(buffer.readBigUInt64LE(16)),
    metaOffset: Number(buffer.readBigUInt64LE(24)),
    metaLength: Number(buffer.readBigUInt64LE(32)),
    leafOffset: Number(buffer.readBigUInt64LE(40)),
    leafLength: Number(buffer.readBigUInt64LE(48)),
    tileOffset: Number(buffer.readBigUInt64LE(56)),
    tileLength: Number(buffer.readBigUInt64LE(64)),
    tileType: buffer.readUInt8(99),
    minZoom: buffer.readUInt8(100),
    maxZoom: buffer.readUInt8(101)
  };

  const state = { pos: header.rootOffset };
  const slice = buffer.subarray(header.rootOffset, header.rootOffset + header.rootLength);
  const local = { pos: 0 };
  const numEntries = readVarint(slice, local);
  const ids = [];
  let lastId = 0;
  for (let i = 0; i < numEntries; i += 1) {
    lastId += readVarint(slice, local);
    ids.push(lastId);
  }
  const runs = [];
  const lengths = [];
  const offsets = [];
  for (let i = 0; i < numEntries; i += 1) runs.push(readVarint(slice, local));
  for (let i = 0; i < numEntries; i += 1) lengths.push(readVarint(slice, local));
  let prevOffset = 0;
  for (let i = 0; i < numEntries; i += 1) {
    const v = readVarint(slice, local);
    const value = v === 0 && i > 0 ? prevOffset + lengths[i - 1] : v - 1;
    offsets.push(value);
    prevOffset = value;
  }

  const find = (z, x, y) => {
    const id = zxyToTileId(z, x, y);
    let lo = 0;
    let hi = ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] === id) return { length: lengths[mid], offset: offsets[mid] };
      if (ids[mid] < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  };

  return {
    header,
    count: ids.length,
    entryCount: numEntries,
    read(z, x, y) {
      const entry = find(z, x, y);
      if (!entry) return null;
      return buffer.subarray(header.tileOffset + entry.offset, header.tileOffset + entry.offset + entry.length);
    }
  };
}

/* ------------------------------------------------------------------ 主流程 */

const bounds = await boundsFromPresets();
console.log(`范围：lat ${bounds.minLat.toFixed(4)}~${bounds.maxLat.toFixed(4)}  lng ${bounds.minLng.toFixed(4)}~${bounds.maxLng.toFixed(4)}（来自 ${bounds.count} 个站点坐标）`);
console.log(`层级：z${MIN_Z}~z${MAX_Z}；瓦片源：Esri Canvas Light Gray（JPEG）`);

const started = Date.now();
const tiles = await collectTiles(bounds);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`已抓取 ${tiles.length} 张瓦片（${elapsed}s）`);

const meta = {
  name: '城市地铁线网开通纪事 · 离线底图（湖南）',
  format: 'jpeg',
  type: 'baselayer',
  description: 'Esri Canvas World Light Gray 底图切片，WGS84，无 GCJ-02 偏移',
  minzoom: String(MIN_Z),
  maxzoom: String(MAX_Z),
  bounds: [bounds.minLng, bounds.minLat, bounds.maxLng, bounds.maxLat].map((v) => v.toFixed(5)).join(',')
};

const archive = buildArchive(tiles, bounds, meta);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, archive);

/* 自校验：回读并与原始字节比对 */
const reader = makeReader(archive);
let checked = 0;
let mismatch = 0;
for (const tile of tiles.slice(0, Math.min(12, tiles.length))) {
  const back = reader.read(tile.z, tile.x, tile.y);
  checked += 1;
  if (!back || Buffer.compare(back, tile.data) !== 0) mismatch += 1;
}
console.log(`写入 ${path.relative(repo, OUT)}：${(archive.length / 1024 / 1024).toFixed(2)} MB，${reader.entryCount} 个瓦片条目`);
console.log(`自校验：回读 ${checked} 张，不一致 ${mismatch} 张；header tileType=${reader.header.tileType} zoom=${reader.header.minZoom}~${reader.header.maxZoom}`);
if (mismatch > 0) {
  console.error('自校验失败：PMTiles 与原始瓦片不一致');
  process.exit(1);
}
