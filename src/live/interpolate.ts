import { pointAlong } from "../geo";
import { stepFleet, type PreparedRoute, type Train } from "../sim/fleet";
import type { SimState } from "../types";

/**
 * 이 거리 이상 어긋나면 보정하지 않고 즉시 옮긴다.
 * 신규 등장, 회차, 오랜 정지 뒤 복귀 같은 경우다.
 */
const SNAP_DISTANCE = 2500;
/**
 * 보정이 절반쯤 녹는 데 걸리는 시간(초).
 * 짧으면 갱신 때마다 튀고, 길면 실제 위치를 오래 못 따라간다.
 */
const CORRECTION_HALF_LIFE = 2.5;
/**
 * 보고가 바뀌지 않는 동안 시뮬레이션이 앞서갈 수 있는 최대 거리(m).
 * 역 간격 정도로 잡아, 실제보다 한 정거장 넘게 앞서지 않게 한다.
 */
const FREE_RUN_MAX = 1300;

/** 순환선에서 되감기는 쪽이 아니라 짧은 쪽으로 이동하도록 델타를 고른다. */
function shortestDelta(route: PreparedRoute, from: number, to: number): number {
  const raw = to - from;
  if (!route.loop) return raw;
  const half = route.length / 2;
  if (raw > half) return raw - route.length;
  if (raw < -half) return raw + route.length;
  return raw;
}

/**
 * 실시간 위치를 받아 열차를 움직인다.
 *
 * 실시간 API 는 "어느 역에 진입·도착·출발" 이라는 이산 값만 준다. 역 사이를
 * 달리는 열차는 1분 넘게 같은 값을 보고하므로, 받은 값에 그대로 붙여 놓으면
 * 화면에서 열차가 얼어붙는다.
 *
 * 그래서 열차를 시뮬레이션으로 계속 굴리고(가속·정차 포함), 폴링으로 들어온
 * 값은 위치를 "정의" 하는 대신 "보정" 하는 데 쓴다. 항법에서 쓰는 추측항법과
 * 같은 방식이다.
 */
export class LiveFleet {
  private readonly routes = new Map<string, PreparedRoute>();
  private readonly trains = new Map<string, Train>();
  /** 아직 반영하지 못한 보정 거리(m). 매 프레임 조금씩 녹인다. */
  private readonly drift = new Map<string, number>();
  private seeded = false;

  constructor(routes: PreparedRoute[]) {
    for (const route of routes) this.routes.set(route.id, route);
  }

  /** 폴링 결과를 받아 기존 열차를 보정하고, 새 열차를 넣고, 사라진 열차를 뺀다. */
  update(reported: Train[]): void {
    for (const next of reported) {
      const current = this.trains.get(next.id);
      const route = this.routes.get(next.routeId);

      if (!current || !route || current.routeId !== next.routeId || current.dir !== next.dir) {
        // 처음 보거나 노선·방향이 달라졌으면 보고된 값을 그대로 쓴다.
        this.trains.set(next.id, { ...next });
        this.drift.delete(next.id);
        continue;
      }

      const delta = shortestDelta(route, current.along, next.along);
      if (Math.abs(delta) > SNAP_DISTANCE) {
        this.trains.set(next.id, { ...next });
        this.drift.delete(next.id);
        continue;
      }

      current.destination = next.destination;
      current.cars = next.cars;
      current.color = next.color;

      if (current.reportKey === next.reportKey) {
        // 같은 보고가 반복되는 중이다. 실제 열차는 계속 달리고 있으므로
        // 여기서 끌어당기면 화면에서 제자리걸음을 한다. 대신 너무 앞서가지만
        // 않게 한도만 지킨다.
        const ahead = -delta;
        if (ahead > FREE_RUN_MAX) this.drift.set(next.id, -(ahead - FREE_RUN_MAX));
        continue;
      }

      // 보고가 바뀌었다. 새 위치로 부드럽게 맞춰 간다.
      current.reportKey = next.reportKey;
      this.drift.set(next.id, delta);
    }

    const alive = new Set(reported.map((t) => t.id));
    for (const id of [...this.trains.keys()]) {
      if (alive.has(id)) continue;
      this.trains.delete(id);
      this.drift.delete(id);
    }

    this.seeded = true;
  }

  /** 한 프레임 굴린다. 시뮬레이션으로 움직인 뒤 보정을 조금 녹인다. */
  step(routes: PreparedRoute[], state: SimState, dtMs: number): Train[] {
    const list = [...this.trains.values()];
    if (list.length === 0) return list;

    stepFleet(list, routes, state, dtMs);

    if (this.drift.size > 0) {
      // 남은 보정의 일정 비율씩 줄여 부드럽게 수렴시킨다.
      const ratio = 1 - 2 ** (-dtMs / 1000 / CORRECTION_HALF_LIFE);
      for (const train of list) {
        const remaining = this.drift.get(train.id);
        if (remaining === undefined) continue;

        const applied = remaining * ratio;
        const left = remaining - applied;
        if (Math.abs(left) < 1) this.drift.delete(train.id);
        else this.drift.set(train.id, left);

        const route = this.routes.get(train.routeId);
        if (!route) continue;

        train.along += applied;
        if (route.loop) {
          train.along = ((train.along % route.length) + route.length) % route.length;
        } else {
          train.along = Math.max(0, Math.min(route.length, train.along));
        }

        const pose = pointAlong(route.coords, route.dist, route.length, train.along);
        train.coord = pose.coord;
        train.heading = train.dir === -1 ? (pose.heading + 180) % 360 : pose.heading;
      }
    }

    return list;
  }

  /** 첫 응답을 받았는지. 받기 전에는 기존 시뮬레이션 열차를 그대로 둔다. */
  hasData(): boolean {
    return this.seeded && this.trains.size > 0;
  }

  clear(): void {
    this.trains.clear();
    this.drift.clear();
    this.seeded = false;
  }
}
