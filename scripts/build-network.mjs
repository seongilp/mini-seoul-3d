import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LINE_META = {
  1: { id: "1", name: "1호선", nameEn: "Line 1", color: "#0052A4", headway: 5, cars: 10 },
  2: { id: "2", name: "2호선", nameEn: "Line 2", color: "#00A84D", headway: 4, cars: 10, loop: true },
  3: { id: "3", name: "3호선", nameEn: "Line 3", color: "#EF7C1C", headway: 5, cars: 10 },
  4: { id: "4", name: "4호선", nameEn: "Line 4", color: "#00A5DE", headway: 5, cars: 10 },
  5: { id: "5", name: "5호선", nameEn: "Line 5", color: "#996CAC", headway: 5, cars: 8 },
  6: { id: "6", name: "6호선", nameEn: "Line 6", color: "#CD7C2F", headway: 6, cars: 8 },
  7: { id: "7", name: "7호선", nameEn: "Line 7", color: "#747F00", headway: 5, cars: 8 },
  8: { id: "8", name: "8호선", nameEn: "Line 8", color: "#E6186C", headway: 7, cars: 6 },
  9: { id: "9", name: "9호선", nameEn: "Line 9", color: "#BDB092", headway: 5, cars: 6 },
  A: { id: "A", name: "공항철도", nameEn: "AREX", color: "#0090D2", headway: 8, cars: 6 },
  K: { id: "K", name: "경의중앙선", nameEn: "Gyeongui–Jungang", color: "#77C4A3", headway: 8, cars: 8 },
  G: { id: "G", name: "경춘선", nameEn: "Gyeongchun", color: "#0C8E72", headway: 12, cars: 8 },
  B: { id: "B", name: "수인분당선", nameEn: "Suin–Bundang", color: "#F5A200", headway: 6, cars: 6 },
  S: { id: "S", name: "신분당선", nameEn: "Shinbundang", color: "#D31145", headway: 6, cars: 6 },
  SU: { id: "SU", name: "수인선", nameEn: "Suin", color: "#F5A200", headway: 8, cars: 6 },
  KK: { id: "KK", name: "경강선", nameEn: "Gyeonggang", color: "#003DA5", headway: 15, cars: 4 },
  I: { id: "I", name: "인천1호선", nameEn: "Incheon 1", color: "#7CA8D5", headway: 6, cars: 8 },
  I2: { id: "I2", name: "인천2호선", nameEn: "Incheon 2", color: "#ED8B00", headway: 7, cars: 2 },
  U: { id: "U", name: "의정부경전철", nameEn: "Uijeongbu", color: "#FF9D1E", headway: 6, cars: 2 },
  E: { id: "E", name: "에버라인", nameEn: "EverLine", color: "#56AD2D", headway: 8, cars: 2 },
  UI: { id: "UI", name: "우이신설선", nameEn: "Ui-Sinseol", color: "#B7C450", headway: 6, cars: 2 },
  W: { id: "W", name: "서해선", nameEn: "Seohae", color: "#8FC31F", headway: 10, cars: 4 },
  GG: { id: "GG", name: "김포골드라인", nameEn: "Gimpo Goldline", color: "#A17800", headway: 6, cars: 2 },
  M: { id: "M", name: "자기부상철도", nameEn: "Maglev", color: "#FFCD4A", headway: 15, cars: 2 },
};

const LINE_ALIASES = {
  "01호선": "1",
  "02호선": "2",
  "03호선": "3",
  "04호선": "4",
  "05호선": "5",
  "06호선": "6",
  "07호선": "7",
  "08호선": "8",
  "09호선": "9",
  "1호선": "1",
  "2호선": "2",
  "3호선": "3",
  "4호선": "4",
  "5호선": "5",
  "6호선": "6",
  "7호선": "7",
  "8호선": "8",
  "9호선": "9",
  경의선: "K",
  경의중앙선: "K",
  공항철도: "A",
  경춘선: "G",
  분당선: "B",
  수인선: "SU",
  수인분당선: "B",
  신분당선: "S",
  경강선: "KK",
  인천1호선: "I",
  인천2호선: "I2",
  의정부경전철: "U",
  에버라인: "E",
  우이신설선: "UI",
  서해선: "W",
  김포골드라인: "GG",
};

function strip(name) {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/[·.]/g, "")
    .replace(/역$/, "");
}

function variants(name) {
  const raw = String(name || "").trim();
  const out = new Set();
  if (!raw) return out;
  out.add(raw);
  out.add(strip(raw));
  const base = raw.replace(/\(.*?\)/g, "").trim();
  if (base) {
    out.add(base);
    out.add(strip(base));
  }
  for (const inner of raw.matchAll(/\(([^)]+)\)/g)) {
    out.add(inner[1]);
    out.add(strip(inner[1]));
    for (const part of inner[1].split(/[,/]/)) {
      const p = part.trim();
      if (p) {
        out.add(p);
        out.add(strip(p));
      }
    }
  }
  return out;
}

function addAlias(index, name, station) {
  for (const key of variants(name)) {
    if (!index.has(key)) index.set(key, station);
  }
}

function lookup(index, name) {
  for (const key of variants(name)) {
    if (index.has(key)) return index.get(key);
  }
  return null;
}

function catmullRom(points, samples = 6) {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return [points[0], points[1]];
  const pts = [points[0], ...points, points[points.length - 1]];
  const out = [];
  for (let i = 1; i < pts.length - 2; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2];
    for (let t = 0; t < samples; t++) {
      const u = t / samples;
      const u2 = u * u;
      const u3 = u2 * u;
      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * u +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * u2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * u3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * u +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * u2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * u3),
      ]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function walkChains(adj) {
  const nodes = [...adj.keys()];
  const used = new Set();
  const undirectedKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const chains = [];

  const walk = (start, firstNeighbor = null) => {
    const path = [start];
    let prev = null;
    let cur = start;
    if (firstNeighbor) {
      used.add(undirectedKey(cur, firstNeighbor));
      path.push(firstNeighbor);
      prev = cur;
      cur = firstNeighbor;
    }
    while (true) {
      const nexts = [...(adj.get(cur) || [])].filter(
        (n) => n !== prev && !used.has(undirectedKey(cur, n)),
      );
      if (!nexts.length) break;
      const nxt = nexts[0];
      used.add(undirectedKey(cur, nxt));
      path.push(nxt);
      prev = cur;
      cur = nxt;
      if (cur === start) break;
    }
    return path;
  };

  const degree = (id) => adj.get(id)?.size || 0;
  const starts = nodes.filter((n) => degree(n) === 1).sort();
  for (const start of starts) {
    const neighbors = [...(adj.get(start) || [])];
    if (!neighbors.length || used.has(undirectedKey(start, neighbors[0]))) continue;
    chains.push(walk(start));
  }

  for (const node of nodes) {
    for (const nb of adj.get(node) || []) {
      if (used.has(undirectedKey(node, nb))) continue;
      chains.push(walk(node, nb));
    }
  }
  return chains.filter((c) => c.length >= 2);
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function cumulative(coords) {
  const dist = [0];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine(coords[i - 1], coords[i]);
    dist.push(total);
  }
  return dist;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

const vertices = readJson(resolve(root, "raw/vertices.min.json"));
const edges = readJson(resolve(root, "raw/edges.min.json"));
const capital = readJson(resolve(root, "raw/capitalStations.json"));
const ordered = readJson(resolve(root, "raw/seoul_stations.json"));

const stations = [];
const byId = new Map();
const nameIndex = new Map();

for (const row of vertices.DATA) {
  if (row.identifier !== "CURRENT") continue;
  if (!row.xpoint_wgs || !row.ypoint_wgs) continue;
  const lineId = String(row.line_num);
  const id = `${lineId}:${row.station_cd || row.fr_code || row.station_nm}`;
  const station = {
    id,
    name: row.station_nm,
    nameEn: row.station_nm_eng || row.station_nm,
    line: lineId,
    lng: row.ypoint_wgs,
    lat: row.xpoint_wgs,
    code: row.fr_code || row.station_cd,
  };
  stations.push(station);
  byId.set(id, station);
  addAlias(nameIndex, `${lineId}:${row.station_nm}`, station);
  addAlias(nameIndex, row.station_nm, station);
}

for (const row of capital) {
  const coord = { lng: row.longitude, lat: row.latitude };
  if (!coord.lng || !coord.lat) continue;
  for (const rawLine of row.lines || []) {
    const lineId = LINE_ALIASES[rawLine] || rawLine;
    const existing = lookup(nameIndex, `${lineId}:${row.name}`) || lookup(nameIndex, row.name);
    if (existing) {
      addAlias(nameIndex, `${lineId}:${row.name}`, existing);
      addAlias(nameIndex, row.name, existing);
      continue;
    }
    const id = `${lineId}:cap:${strip(row.name)}`;
    const station = {
      id,
      name: row.name,
      nameEn: row.name,
      line: lineId,
      lng: coord.lng,
      lat: coord.lat,
    };
    stations.push(station);
    byId.set(id, station);
    addAlias(nameIndex, `${lineId}:${row.name}`, station);
    addAlias(nameIndex, row.name, station);
  }
}

const graphs = new Map();
function ensureGraph(lineId) {
  if (!graphs.has(lineId)) graphs.set(lineId, new Map());
  return graphs.get(lineId);
}
function link(lineId, a, b) {
  if (!a || !b || a.id === b.id) return;
  const g = ensureGraph(lineId);
  if (!g.has(a.id)) g.set(a.id, new Set());
  if (!g.has(b.id)) g.set(b.id, new Set());
  g.get(a.id).add(b.id);
  g.get(b.id).add(a.id);
}

for (const [lineId, pairs] of Object.entries(edges)) {
  for (const pair of pairs) {
    const a =
      lookup(nameIndex, `${lineId}:${pair.from}`) || lookup(nameIndex, pair.from);
    const b = lookup(nameIndex, `${lineId}:${pair.to}`) || lookup(nameIndex, pair.to);
    if (a && b) link(lineId, a, b);
  }
}

const SUBWAY_TO_LINE = {
  1001: "1",
  1002: "2",
  1003: "3",
  1004: "4",
  1005: "5",
  1006: "6",
  1007: "7",
  1008: "8",
  1009: "9",
  1063: "K",
  1065: "A",
  1067: "G",
  1075: "B",
  1077: "S",
  1081: "KK",
  1092: "UI",
  1093: "W",
};

const bySubway = new Map();
for (const row of ordered.stationList) {
  const lineId = SUBWAY_TO_LINE[row.SUBWAY_ID];
  if (!lineId) continue;
  if (!bySubway.has(lineId)) bySubway.set(lineId, []);
  bySubway.get(lineId).push(row);
}

/**
 * 역번호가 크게 뛰어도 엣지 자료가 이웃이라고 하면 같은 갈래로 본다.
 *
 * 단계별로 개통한 노선은 연장 구간에 다른 번호대를 받는다. 신분당선
 * 양재시민의숲(…689) → 청계산입구(…6810)는 6121 뛰지만 2.9km 이웃이다.
 * 반대로 경의중앙선은 효창공원앞이 목록 끝에 혼자 떨어져 신촌 앞에 오는데,
 * 둘은 2.8km 로 가깝지만 실제로는 이어져 있지 않다. 거리만으로는 이 둘을
 * 가릴 수 없어서 엣지 자료를 기준으로 삼는다.
 */
function isLinkedByEdge(lineId, a, b) {
  const sa = lookup(nameIndex, `${lineId}:${a.STATN_NM}`) || lookup(nameIndex, a.STATN_NM);
  const sb = lookup(nameIndex, `${lineId}:${b.STATN_NM}`) || lookup(nameIndex, b.STATN_NM);
  if (!sa || !sb) return false;
  return Boolean(graphs.get(lineId)?.get(sa.id)?.has(sb.id));
}

function splitOrdered(lineId, rows) {
  const groups = [];
  let current = [];
  let prev = null;
  for (const row of rows) {
    if (prev !== null && row.STATN_ID - prev.STATN_ID > 80 && !isLinkedByEdge(lineId, prev, row)) {
      if (current.length) groups.push(current);
      current = [];
    }
    current.push(row);
    prev = row;
  }
  if (current.length) groups.push(current);
  return groups;
}

function stationsFromNames(lineId, names) {
  const found = [];
  for (const name of names) {
    const s = lookup(nameIndex, `${lineId}:${name}`) || lookup(nameIndex, name);
    if (s) found.push(s);
  }
  return found;
}

function makeRoute(lineId, idx, chainStations, loop) {
  const raw = chainStations.map((s) => [s.lng, s.lat]);
  if (loop && raw.length > 2) {
    raw.push(raw[0]);
    chainStations = [...chainStations, chainStations[0]];
  }
  const coords = catmullRom(raw, 7);
  const dist = cumulative(coords);
  return {
    id: `${lineId}-${idx}`,
    line: lineId,
    loop,
    coords,
    length: dist[dist.length - 1],
    stations: chainStations.map((s, i) => {
      let along = 0;
      let best = Infinity;
      for (let k = 0; k < coords.length; k++) {
        const d = haversine([s.lng, s.lat], coords[k]);
        if (d < best) {
          best = d;
          along = dist[k];
        }
      }
      return { id: s.id, name: s.name, along, index: i };
    }),
  };
}

/**
 * 목록의 연속쌍도 그래프에 넣는다. 다만 역번호가 크게 뛰는 지점은 목록 순서를
 * 믿을 수 없으므로 건너뛴다. 그 자리는 edges.min.json 이 채운다.
 */
for (const [lineId, names] of bySubway) {
  for (let i = 1; i < names.length; i++) {
    if (names[i].STATN_ID - names[i - 1].STATN_ID > 80) continue;
    const a = lookup(nameIndex, `${lineId}:${names[i - 1].STATN_NM}`) || lookup(nameIndex, names[i - 1].STATN_NM);
    const b = lookup(nameIndex, `${lineId}:${names[i].STATN_NM}`) || lookup(nameIndex, names[i].STATN_NM);
    if (a && b) {
      const dist = haversine([a.lng, a.lat], [b.lng, b.lat]);
      const suburban = ["1", "A", "K", "G", "B", "KK", "W"].includes(lineId);
      if (dist < (suburban ? 9000 : 4200)) link(lineId, a, b);
    }
  }
}

const routes = [];
const handledLines = new Set();

for (const [lineId, rows] of bySubway) {
  const meta = LINE_META[lineId];
  if (!meta) continue;

  const rawGroups = splitOrdered(lineId, rows).map((group) =>
    stationsFromNames(lineId, group.map((r) => r.STATN_NM)),
  );
  const listGroups = rawGroups.filter((group) => group.length >= 2);

  /*
   * 목록 순서가 노선 형태를 담지 못하면 역이 버려진다. 경의중앙선은 효창공원앞이
   * 목록 맨 뒤에 혼자 떨어져 있어 한 역짜리 조각이 되고, 그대로 사라져 용산 쪽과
   * 공덕 쪽 사이가 화면에서 비었다. 그럴 때만 그래프를 따라 걸어 다시 세운다.
   * 다만 그래프 순회가 조각을 더 잘게 쪼개면(1호선처럼 지선이 많은 경우)
   * 그대로 두는 편이 낫다. 조각이 줄어들 때만 바꾼다.
   */
  const orphaned = rawGroups.length !== listGroups.length;
  const graphChains = orphaned
    ? walkChains(graphs.get(lineId) || new Map())
        .map((chain) => chain.map((id) => byId.get(id)).filter(Boolean))
        .filter((chain) => chain.length >= 2)
    : [];

  const chosen =
    graphChains.length > 0 && graphChains.length <= listGroups.length
      ? graphChains
      : listGroups;

  chosen.forEach((found, idx) => {
    const loop = Boolean(meta.loop) && idx === 0 && found.length > 20;
    routes.push(makeRoute(lineId, idx, found, loop));
  });
  handledLines.add(lineId);
}

for (const [lineId, adj] of graphs) {
  if (handledLines.has(lineId)) continue;
  const meta = LINE_META[lineId];
  if (!meta) continue;
  walkChains(adj).forEach((chain, idx) => {
    const found = chain.map((id) => byId.get(id)).filter(Boolean);
    if (found.length < 2) return;
    routes.push(makeRoute(lineId, idx, found, false));
  });
}

const uniqueStations = [];
const seenPlace = new Map();
for (const s of stations) {
  const key = `${s.name}|${s.lng.toFixed(4)}|${s.lat.toFixed(4)}`;
  if (seenPlace.has(key)) {
    seenPlace.get(key).lines.add(s.line);
    continue;
  }
  const rec = { ...s, lines: new Set([s.line]) };
  seenPlace.set(key, rec);
  uniqueStations.push(rec);
}

const network = {
  generatedAt: new Date().toISOString(),
  lines: Object.values(LINE_META).filter((l) => routes.some((r) => r.line === l.id)),
  routes: routes.map((r) => ({
    ...r,
    coords: r.coords.map((c) => [Number(c[0].toFixed(6)), Number(c[1].toFixed(6))]),
  })),
  stations: uniqueStations.map((s) => ({
    id: s.id,
    name: s.name,
    nameEn: s.nameEn,
    lng: Number(s.lng.toFixed(6)),
    lat: Number(s.lat.toFixed(6)),
    lines: [...s.lines],
  })),
};

writeFileSync(resolve(root, "public/data/network.json"), JSON.stringify(network));
console.log(
  JSON.stringify(
    {
      stations: network.stations.length,
      routes: network.routes.length,
      lines: network.lines.map((l) => l.id),
      routeStats: network.routes.map((r) => ({
        id: r.id,
        n: r.stations.length,
        km: Number((r.length / 1000).toFixed(1)),
        loop: r.loop,
      })),
    },
    null,
    2,
  ),
);
