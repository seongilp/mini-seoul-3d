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
export function seedTrains(
  routes: PreparedRoute[],
  state: SimState,
  timetable?: Timetable | null,
): Train[] {
  const trains: Train[] = [];
  const clock = new Date(state.clockMs);
  const factor = hourFactor(state.clockMs);
  for (const route of routes) {
    if (state.hiddenLines.has(route.line)) continue;
    if (timetable && !timetable.isInService(route.line, clock)) continue;
    const spacing = route.headway * 60 * CRUISE;
    let count = Math.max(2, Math.round((route.length / spacing) * factor));
    if (state.eco) count = Math.max(1, Math.round(count * 0.45));
    const dirs: Array<1 | -1> = route.loop ? [1, -1] : [1, -1];
    for (const dir of dirs) {
      const n = Math.max(1, Math.round(count / dirs.length));
      for (let i = 0; i < n; i++) {
        const along = ((i + 0.12) / n) * route.length;
        const pose = pointAlong(route.coords, route.dist, route.length, along);
        trains.push({
          id: `${route.id}:${dir}:${i}`,
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
        });
      }
    }
  }
  return trains;
}

let routeIndex: Map<string, PreparedRoute> | null = null;
let indexedRoutes: PreparedRoute[] | null = null;

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
