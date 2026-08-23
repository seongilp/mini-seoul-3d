import { pointAlong } from "../geo";
import type { PreparedRoute, Train } from "../sim/fleet";
import type { Station } from "../types";
import { TRAIN_STATUS, type LiveTrain } from "./client";
import { nameCandidates, normalizeName, stripOperationSuffix } from "./names";

/** 역 출발 직후 열차를 역에서 떼어 놓는 최대 거리(m). */
const DEPART_OFFSET = 200;

/** 전역 출발 상태의 구간 진행률. 0 = 이전 역, 1 = 기준 역. */
const PREV_DEPARTED_PROGRESS = 0.6;

type IndexedRoute = {
  route: PreparedRoute;
  /** 정규화한 역명 → route.stations 인덱스 */
  byName: Map<string, number>;
};

/** 노선별 역명 색인. 폴링마다 다시 만들지 않도록 한 번만 생성해서 재사용한다. */
export class RouteIndex {
  private readonly byLine = new Map<string, IndexedRoute[]>();
  private readonly stationCoords = new Map<string, [number, number]>();

  constructor(routes: PreparedRoute[], stations: Station[]) {
    for (const route of routes) {
      const byName = new Map<string, number>();
      route.stations.forEach((s, i) => byName.set(normalizeName(s.name), i));
      const list = this.byLine.get(route.line);
      if (list) list.push({ route, byName });
      else this.byLine.set(route.line, [{ route, byName }]);
    }
    for (const s of stations) {
      this.stationCoords.set(normalizeName(s.name), [s.lng, s.lat]);
    }
  }

  routesFor(line: string): IndexedRoute[] {
    return this.byLine.get(line) ?? [];
  }

  coordOf(name: string): [number, number] | null {
    return this.stationCoords.get(normalizeName(name)) ?? null;
  }
}

/** 원본 이름 → 접미 제거 → 개명 별칭 순으로 route 안에서 찾는다. */
function lookup(entry: IndexedRoute, raw: string): number | undefined {
  for (const candidate of nameCandidates(raw)) {
    const hit = entry.byName.get(candidate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export type PlaceStats = {
  placed: number;
  /** 기준 역을 network.json 에서 못 찾음 (미개통 연장 구간, 개명 등) */
  unknownStation: number;
  /** 역은 찾았지만 진행 방향을 정하지 못함 */
  unknownDirection: number;
};

/** 역명 매칭에 성공한 열차 1대. */
type Anchor = {
  live: LiveTrain;
  entry: IndexedRoute;
  stationIndex: number;
};

function squaredDistance(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * Math.cos((a[1] * Math.PI) / 180);
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

/**
 * route 상에서 statnId 가 증가하는 쪽이 배열 순방향인지(+1) 역방향인지(-1) 판정한다.
 * 이번 응답에 실제로 잡힌 열차들의 (인덱스, statnId) 쌍으로 투표한다.
 * 순환선은 되감김 지점이 한 곳 생기지만 다수결로 흡수된다.
 */
function orientationOf(anchors: Anchor[]): 1 | -1 | 0 {
  const pairs = anchors
    .filter((a) => a.live.statnId > 0)
    .map((a) => ({ index: a.stationIndex, id: a.live.statnId }))
    .sort((a, b) => a.index - b.index);
  if (pairs.length < 2) return 0;

  let up = 0;
  let down = 0;
  for (let i = 1; i < pairs.length; i++) {
    const d = pairs[i].id - pairs[i - 1].id;
    if (d > 0) up += 1;
    else if (d < 0) down += 1;
  }
  if (up === down) return 0;
  return up > down ? 1 : -1;
}

/**
 * 종착역이 route 안에 없을 때(연장 구간, 개명, 직결 등) 지리적으로 가장 가까운
 * route 상의 역으로 대신한다.
 */
function resolveByName(entry: IndexedRoute, index: RouteIndex, name: string): number {
  const direct = lookup(entry, name);
  if (direct !== undefined) return direct;

  const target = index.coordOf(name);
  if (!target) return -1;

  let best = -1;
  let bestDist = Infinity;
  entry.route.stations.forEach((s, i) => {
    const coord = index.coordOf(s.name);
    if (!coord) return;
    const d = squaredDistance(coord, target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/**
 * 진행 방향을 정한다.
 * 1순위는 statnId 순번(개명·연장에 영향받지 않음), 2순위는 종착역 이름이다.
 */
function directionOf(
  anchor: Anchor,
  index: RouteIndex,
  orientation: 1 | -1 | 0,
): 1 | -1 | null {
  const { live, entry, stationIndex } = anchor;

  if (entry.route.loop) {
    // 순환선은 종착역이 되감김 너머에 있을 수 있어(홍대입구 → 성수 종착) statnId
    // 차이로는 방향을 알 수 없다. 내선/외선 표기를 쓴다.
    // updnLine "0" = 내선 = statnId 증가 방향.
    if (orientation === 0 || live.updown === "") return null;
    return ((live.updown === "0" ? 1 : -1) * orientation) as 1 | -1;
  }

  if (orientation !== 0 && live.statnId > 0 && live.terminalId > 0) {
    const delta = live.terminalId - live.statnId;
    if (delta !== 0) return ((delta > 0 ? 1 : -1) * orientation) as 1 | -1;
  }

  const destIndex = resolveByName(entry, index, live.destination);
  if (destIndex >= 0 && destIndex !== stationIndex) return destIndex > stationIndex ? 1 : -1;

  return null;
}

function alongFor(route: PreparedRoute, stationIndex: number, dir: 1 | -1, status: string): number {
  const station = route.stations[stationIndex];

  if (status === TRAIN_STATUS.DEPARTED) {
    const next = route.stations[stationIndex + dir];
    const gap = next ? Math.abs(next.along - station.along) : DEPART_OFFSET * 2;
    return station.along + dir * Math.min(DEPART_OFFSET, gap * 0.4);
  }

  if (status === TRAIN_STATUS.PREV_DEPARTED) {
    const prev = route.stations[stationIndex - dir];
    if (!prev) return station.along;
    const span = Math.abs(station.along - prev.along);
    return prev.along + dir * span * PREV_DEPARTED_PROGRESS;
  }

  // 진입(0), 도착(1) 은 사실상 역 위치다.
  return station.along;
}

export function placeLiveTrains(
  live: LiveTrain[],
  index: RouteIndex,
): { trains: Train[]; stats: PlaceStats } {
  const stats: PlaceStats = { placed: 0, unknownStation: 0, unknownDirection: 0 };

  // 1차: 역명으로 노선과 위치를 잡는다.
  const anchorsByRoute = new Map<PreparedRoute, Anchor[]>();
  for (const t of live) {
    const candidates = index
      .routesFor(t.line)
      .filter((e) => lookup(e, t.stationName) !== undefined);
    if (candidates.length === 0) {
      stats.unknownStation += 1;
      continue;
    }
    const entry = candidates.find((e) => lookup(e, t.destination) !== undefined) ?? candidates[0];
    const anchor: Anchor = { live: t, entry, stationIndex: lookup(entry, t.stationName)! };
    const list = anchorsByRoute.get(entry.route);
    if (list) list.push(anchor);
    else anchorsByRoute.set(entry.route, [anchor]);
  }

  // 2차: 노선마다 statnId 방향성을 구한 뒤 각 열차를 배치한다.
  const trains: Train[] = [];
  for (const [route, anchors] of anchorsByRoute) {
    const orientation = orientationOf(anchors);

    for (const anchor of anchors) {
      const dir = directionOf(anchor, index, orientation);
      if (dir === null) {
        stats.unknownDirection += 1;
        continue;
      }

      let along = alongFor(route, anchor.stationIndex, dir, anchor.live.status);
      if (route.loop) along = ((along % route.length) + route.length) % route.length;

      const pose = pointAlong(route.coords, route.dist, route.length, along);
      trains.push({
        id: `live:${anchor.live.line}:${anchor.live.trainNo}`,
        routeId: route.id,
        line: route.line,
        color: route.color,
        cars: route.cars,
        destination: stripOperationSuffix(anchor.live.destination),
        dir,
        along,
        dwell: 0,
        lastStop: -1,
        coord: pose.coord,
        heading: pose.heading,
      });
      stats.placed += 1;
    }
  }

  return { trains, stats };
}
