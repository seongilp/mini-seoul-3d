import type { Timetable } from "../data/timetable";
import { cumulative, pointAlong } from "../geo";
import type { LineInfo, Network, Route, RouteStation, SimState } from "../types";

export type Train = {
  id: string;
  routeId: string;
  line: string;
  color: string;
  cars: number;
  /** 행선지(종착역). 지도 라벨에 쓴다. */
  destination: string;
  dir: 1 | -1;
  along: number;
  dwell: number;
  lastStop: number;
  coord: [number, number];
  heading: number;
  /** 현재 속도(m/s). 역에 다가가면 줄고 떠나면 는다. */
  speed: number;
  /** 혼잡도(1 = 정원). 사람 보기 모드에서만 채워진다. */
  congestion?: number;
};

export type PreparedRoute = Route & {
  dist: number[];
  line: string;
  color: string;
  cars: number;
  headway: number;
};

/** 최고 주행 속도(m/s). 약 56km/h. */
const CRUISE = 15.5;
/** 가속·감속도(m/s^2). 실제 전동차와 비슷한 값이라 역 진입·출발이 자연스럽다. */
const ACCEL = 0.9;
const DECEL = 1.0;
/** 정차 시간(ms). */
const DWELL = 22000;
/** 종착역 회차 정차 시간(ms). */
const TURNAROUND = 30000;
/** 이 거리(m) 안에 들어오면 도착으로 본다. */
const ARRIVE_EPS = 0.6;

/**
 * 시간대별 운행 밀도. 실제 시간표가 아니라 러시아워를 흉내 낸 값이다.
 * 운행 여부 자체는 시간표(Timetable)가 있으면 그쪽이 정한다.
 */
function hourFactor(clockMs: number): number {
  const hour = new Date(clockMs).getHours();
  if (hour >= 1 && hour < 5) return 0.08;
  if (hour < 6) return 0.2;
  if (hour < 7) return 0.45;
  if ((hour >= 7 && hour < 9) || (hour >= 18 && hour < 20)) return 1.15;
  if (hour >= 23) return 0.35;
  return 1;
}

export function prepareRoutes(network: Network): PreparedRoute[] {
  const lines = new Map(network.lines.map((l) => [l.id, l]));
  return network.routes
    .filter((r) => r.stations.length >= 3 && r.length > 1500)
    .map((r) => {
      const line = lines.get(r.line) as LineInfo;
      return {
        ...r,
        dist: cumulative(r.coords),
        color: line.color,
        cars: line.cars,
        headway: line.headway,
      };
    });
}

/** 행선지 표기. "성수" → "성수행", "내선순환" 처럼 이미 완성된 말은 그대로 둔다. */
export function headsign(destination: string): string {
  if (!destination) return "";
  return /순환$/.test(destination) ? destination : `${destination}행`;
}

/** 진행 방향 끝의 역 이름. 순환선은 종착 개념이 없어 내선/외선으로 표기한다. */
function terminalName(route: PreparedRoute, dir: 1 | -1): string {
  if (route.loop) return dir === 1 ? "내선순환" : "외선순환";
  const end = dir === 1 ? route.stations[route.stations.length - 1] : route.stations[0];
  return end ? end.name : "";
}

/**
 * 시뮬레이션 열차를 배치한다.
 *
 * timetable 을 넘기면 첫차 전·막차 후에는 그 노선 열차를 만들지 않는다.
 * 시간표가 없는 노선(1~9호선 외)은 판단할 수 없어 종일 운행한다.
 */
/** 그 시각 한 방향에 몇 대가 다녀야 하는지. 배차 간격과 시간대 밀도로 정한다. */
function perDirectionCount(route: PreparedRoute, state: SimState, factor: number): number {
  const spacing = route.headway * 60 * CRUISE;
  let count = Math.max(2, Math.round((route.length / spacing) * factor));
  if (state.eco) count = Math.max(1, Math.round(count * 0.45));
  return Math.max(1, Math.round(count / 2));
}

/** 그 노선이 지금 열차를 굴려야 하는지. */
function routeActive(
  route: PreparedRoute,
  state: SimState,
  clock: Date,
  timetable?: Timetable | null,
): boolean {
  if (state.hiddenLines.has(route.line)) return false;
  if (timetable && !timetable.isInService(route.line, clock)) return false;
  return true;
}

let serial = 0;

function makeTrain(route: PreparedRoute, dir: 1 | -1, along: number): Train {
  const pose = pointAlong(route.coords, route.dist, route.length, along);
  return {
    id: `${route.id}:${dir}:${serial++}`,
    routeId: route.id,
    line: route.line,
    color: route.color,
    cars: route.cars,
    destination: terminalName(route, dir),
    dir,
    along,
    dwell: 0,
    lastStop: -1,
    speed: 0,
    coord: pose.coord,
    heading: pose.heading,
  };
}

export function seedTrains(
  routes: PreparedRoute[],
  state: SimState,
  timetable?: Timetable | null,
): Train[] {
  const trains: Train[] = [];
  const clock = new Date(state.clockMs);
  const factor = hourFactor(state.clockMs);

  for (const route of routes) {
    if (!routeActive(route, state, clock, timetable)) continue;
    for (const dir of [1, -1] as const) {
      const n = perDirectionCount(route, state, factor);
      for (let i = 0; i < n; i++) {
        trains.push(makeTrain(route, dir, ((i + 0.12) / n) * route.length));
      }
    }
  }
  return trains;
}

/**
 * 지금 시각에 맞게 열차 수를 맞춘다.
 *
 * 통째로 다시 뿌리면 화면의 모든 열차가 순간이동한다. 그래서 이미 달리던
 * 열차는 그대로 두고, 모자라면 가장 넓은 간격에 끼워 넣고 남으면 덜어낸다.
 * 시각을 크게 건너뛰어도 자연스럽고, 출퇴근 시간대에 열차가 서서히 늘어난다.
 */
export function retimeFleet(
  trains: Train[],
  routes: PreparedRoute[],
  state: SimState,
  timetable?: Timetable | null,
): Train[] {
  const clock = new Date(state.clockMs);
  const factor = hourFactor(state.clockMs);

  const existing = new Map<string, Train[]>();
  for (const train of trains) {
    const key = `${train.routeId}|${train.dir}`;
    const list = existing.get(key);
    if (list) list.push(train);
    else existing.set(key, [train]);
  }

  const out: Train[] = [];
  for (const route of routes) {
    if (!routeActive(route, state, clock, timetable)) continue;

    for (const dir of [1, -1] as const) {
      const want = perDirectionCount(route, state, factor);
      const have = (existing.get(`${route.id}|${dir}`) ?? []).slice(0, want);

      if (have.length === 0) {
        // 처음부터 채울 때는 노선 전체에 고르게 벌려 놓는다.
        for (let i = 0; i < want; i++) {
          out.push(makeTrain(route, dir, ((i + 0.12) / want) * route.length));
        }
        continue;
      }

      out.push(...have);

      // 넣을 때마다 방금 넣은 것까지 셈에 넣어야 한 자리에 쌓이지 않는다.
      const placed = [...have];
      for (let i = have.length; i < want; i++) {
        const train = makeTrain(route, dir, widestGap(route, placed));
        placed.push(train);
        out.push(train);
      }
    }
  }
  return out;
}

/**
 * 이미 있는 열차들 사이에서 가장 넓은 간격의 한가운데.
 * 새 열차를 여기에 넣어야 기존 열차와 겹치지 않는다.
 */
function widestGap(route: PreparedRoute, trains: Train[]): number {
  if (trains.length === 0) return route.length * 0.12;

  const spots = trains.map((t) => t.along).sort((a, b) => a - b);
  let best = spots[0] / 2;
  let bestSize = spots[0];

  for (let i = 1; i < spots.length; i++) {
    const size = spots[i] - spots[i - 1];
    if (size > bestSize) {
      bestSize = size;
      best = spots[i - 1] + size / 2;
    }
  }

  // 순환선은 끝과 처음 사이도 간격이다.
  const wrap = route.loop
    ? route.length - spots[spots.length - 1] + spots[0]
    : route.length - spots[spots.length - 1];
  if (wrap > bestSize) {
    best = (spots[spots.length - 1] + wrap / 2) % route.length;
  }

  return best;
}

let routeIndex: Map<string, PreparedRoute> | null = null;
let indexedRoutes: PreparedRoute[] | null = null;

export type UpcomingStop = {
  name: string;
  /** 열차 현재 위치에서의 거리(m). */
  distance: number;
  /** 도착까지 걸릴 것으로 보는 시간(초). */
  etaSec: number;
};

/**
 * 한 구간을 달리는 데 걸리는 시간(초).
 * 가속 → 순항 → 감속으로 나눠 계산한다. 짧은 구간은 최고 속도에 닿기 전에
 * 감속에 들어가므로 도달 가능한 최고 속도를 따로 구한다.
 */
function segmentSeconds(distance: number): number {
  if (distance <= 0) return 0;
  const accelDist = (CRUISE * CRUISE) / (2 * ACCEL);
  const decelDist = (CRUISE * CRUISE) / (2 * DECEL);

  if (distance >= accelDist + decelDist) {
    const cruise = distance - accelDist - decelDist;
    return CRUISE / ACCEL + cruise / CRUISE + CRUISE / DECEL;
  }

  const peak = Math.sqrt((2 * distance * ACCEL * DECEL) / (ACCEL + DECEL));
  return peak / ACCEL + peak / DECEL;
}

/**
 * 앞으로 설 역들과 도착 예정 시간.
 * 정차 시간과 가감속을 반영한 어림이라 실제 시각표와는 다르다.
 */
export function upcomingStops(
  routes: PreparedRoute[],
  train: Train,
  limit = 8,
): UpcomingStop[] {
  const route = routes.find((r) => r.id === train.routeId);
  if (!route) return [];

  const out: UpcomingStop[] = [];
  let along = train.along;
  let seconds = train.dwell > 0 ? train.dwell / 1000 : 0;
  let dir = train.dir;

  for (let i = 0; i < limit; i++) {
    const target = nextTarget(route, along, dir);

    if (!target.stop) {
      // 종착이면 방향을 바꿔 계속 센다. 회차 후 첫 역까지 이어서 보여 준다.
      if (route.loop) break;
      seconds += segmentSeconds(target.distance) + TURNAROUND / 1000;
      along = dir === 1 ? route.length : 0;
      dir = dir === 1 ? -1 : 1;
      continue;
    }

    seconds += segmentSeconds(target.distance);
    out.push({
      name: target.stop.name,
      distance: Math.abs(target.stop.along - train.along),
      etaSec: Math.round(seconds),
    });

    along = target.stop.along;
    seconds += DWELL / 1000;
  }

  return out;
}

/** 열차가 다음에 설 역 이름. 종착으로 향하는 중이면 빈 문자열. */
export function nextStationName(
  routes: PreparedRoute[],
  train: Train,
): { name: string; distance: number } | null {
  const route = routes.find((r) => r.id === train.routeId);
  if (!route) return null;
  const target = nextTarget(route, train.along, train.dir);
  if (!target.stop) return null;
  return { name: target.stop.name, distance: target.distance };
}

/** 진행 방향으로 가장 가까운 다음 정차 지점. 종착역이면 stop 이 null 이다. */
type Target = { stop: RouteStation | null; distance: number };

function nextTarget(route: PreparedRoute, along: number, dir: 1 | -1): Target {
  let best: RouteStation | null = null;
  let bestD = Infinity;

  for (const stop of route.stations) {
    let d = (stop.along - along) * dir;
    if (route.loop) d = ((d % route.length) + route.length) % route.length;
    // 정차 직후 같은 역을 다시 잡지 않도록 바로 위(거리 0)는 건너뛴다.
    if (d > 0.05 && d < bestD) {
      best = stop;
      bestD = d;
    }
  }

  if (best) return { stop: best, distance: bestD };

  // 남은 역이 없으면 노선 끝에서 회차한다.
  const end = dir === 1 ? route.length : 0;
  return { stop: null, distance: Math.max(0, (end - along) * dir) };
}

function nearestStop(route: PreparedRoute, along: number): RouteStation | null {
  let best: RouteStation | null = null;
  let bd = Infinity;
  for (const s of route.stations) {
    const d = Math.abs(s.along - along);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return bd < 60 ? best : null;
}

export function stepFleet(
  trains: Train[],
  routes: PreparedRoute[],
  state: SimState,
  dtMs: number,
): void {
  if (indexedRoutes !== routes || !routeIndex) {
    routeIndex = new Map(routes.map((r) => [r.id, r]));
    indexedRoutes = routes;
  }

  const dt = (dtMs / 1000) * state.speed;
  for (const train of trains) {
    const route = routeIndex.get(train.routeId);
    if (!route) continue;

    if (train.dwell > 0) {
      train.dwell -= dtMs * state.speed;
      train.speed = 0;
      continue;
    }

    const target = nextTarget(route, train.along, train.dir);

    // 남은 거리 안에 멈추려면 지금부터 줄여야 하는지 본다.
    const brakingDistance = (train.speed * train.speed) / (2 * DECEL);
    if (target.distance <= brakingDistance) {
      // 고정 감속도로 줄이면 남은 거리가 짧아질수록 제동거리도 함께 짧아져
      // 영영 도착하지 못한다. 남은 거리에 맞춰 필요한 만큼 더 줄인다.
      const needed = (train.speed * train.speed) / (2 * Math.max(0.5, target.distance));
      train.speed = Math.max(0, train.speed - Math.max(DECEL, needed) * dt);
    } else {
      train.speed = Math.min(CRUISE, train.speed + ACCEL * dt);
    }

    const moved = train.speed * dt;
    if (moved >= target.distance || target.distance <= ARRIVE_EPS) {
      arrive(train, route, target);
    } else {
      train.along += moved * train.dir;
      if (route.loop) {
        train.along = ((train.along % route.length) + route.length) % route.length;
      }
    }

    const pose = pointAlong(route.coords, route.dist, route.length, train.along);
    train.coord = pose.coord;
    train.heading = pose.heading;
    if (train.dir === -1) train.heading = (train.heading + 180) % 360;
  }
}

/** 목표 지점에 도착시키고 정차 또는 회차시킨다. */
function arrive(train: Train, route: PreparedRoute, target: Target): void {
  train.speed = 0;

  if (target.stop) {
    train.along = target.stop.along;
    train.lastStop = target.stop.along;

    // 이 역이 진행 방향 마지막이면 여기서 바로 회차한다. 그러지 않으면
    // 정차를 마치고 출발하자마자 노선 끝에 닿아 두 번 쉬는 꼴이 된다.
    if (!route.loop && nextTarget(route, target.stop.along, train.dir).stop === null) {
      turnAround(train, route);
      return;
    }

    train.dwell = DWELL;
    return;
  }

  train.along = train.dir === 1 ? route.length : 0;
  turnAround(train, route);
}

/** 종착에서 방향을 바꾸고 조금 더 오래 쉰다. */
function turnAround(train: Train, route: PreparedRoute): void {
  train.dir = train.dir === 1 ? -1 : 1;
  train.destination = terminalName(route, train.dir);
  train.dwell = TURNAROUND;
  const term = nearestStop(route, train.along);
  if (term) train.lastStop = term.along;
}
