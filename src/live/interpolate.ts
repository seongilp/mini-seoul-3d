import { pointAlong } from "../geo";
import { MAX_SPEED, nextTarget, stepFleet, type PreparedRoute, type Train } from "../sim/fleet";
import type { SimState } from "../types";

/**
 * 이 거리 이상 어긋나면 보정하지 않고 즉시 옮긴다.
 * 신규 등장, 회차, 오랜 정지 뒤 복귀 같은 경우다. 이보다 가까우면 속도를
 * 조절해 따라잡는데, 더 멀면 따라잡는 동안 두 정거장 넘게 틀린 곳을 보여 준다.
 */
const SNAP_DISTANCE = 1500;
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
/**
 * 따라잡을 때 낼 수 있는 속도 배수. 지금 속도의 이만큼까지만 빨라진다.
 * 역을 막 떠난 느린 열차가 갑자기 튀어 나가지 않게 한다.
 */
const CATCH_UP_GAIN = 1.4;
/** 따라잡을 때 넘지 않는 속도(m/s). 약 80km/h, 서울 지하철 영업 최고 속도쯤. */
const CATCH_UP_MAX = Math.min(MAX_SPEED, 22.2);
/** 앞서 있을 때 한 프레임 이동을 이 비율까지 덜어 낸다. 뒤로 가지는 않는다. */
const SLOW_DOWN_SHARE = 0.35;
/**
 * 역에 붙잡아 둔 동안 실제 열차가 따라오는 속도(m/s).
 * 정차를 포함한 평균 운행 속도(약 33km/h)쯤이다.
 */
const HOLD_CLOSE_RATE = 9;
/** 이만큼 뒤처져 있으면 정차를 줄여 일찍 떠난다(m). */
const LEAVE_EARLY_LAG = 150;
/** 일찍 떠나더라도 남기는 정차 시간(ms). 문 닫히는 시간쯤은 둔다. */
const LEAVE_EARLY_MS = 6000;
/** 순항 속도를 모를 때 정차 단축량을 어림하는 속도(m/s). */
const FALLBACK_CRUISE = 15.5;

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
  /**
   * 아직 반영하지 못한 보정 거리(m, 노선 좌표 기준). 위치를 직접 옮기지 않고
   * 열차를 조금 더 빨리 또는 느리게 달리게 해서 녹인다.
   */
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

  /**
   * 한 프레임 굴린다. 시뮬레이션으로 움직인 뒤 보정을 조금 녹인다.
   *
   * 예전에는 어긋난 거리를 위치에 바로 더해서, 1km 어긋난 열차가 몇 초 만에
   * 수백 km/h 로 미끄러지고 앞선 열차는 뒤로 밀려났다. 지금은 보정을 속도로만
   * 준다. 뒤처지면 최고 80km/h 안에서 조금 더 빨리 달리고 정차를 줄이며,
   * 앞서면 덜 가거나 역에서 더 기다린다.
   */
  step(routes: PreparedRoute[], state: SimState, dtMs: number): Train[] {
    const list = [...this.trains.values()];
    if (list.length === 0) return list;

    const before = list.map((t) => t.along);
    stepFleet(list, routes, state, dtMs);
    if (this.drift.size === 0) return list;

    const dt = dtMs / 1000;
    const ratio = 1 - 2 ** (-dt / CORRECTION_HALF_LIFE);
    list.forEach((train, i) => {
      const remaining = this.drift.get(train.id);
      if (remaining === undefined) return;
      const route = this.routes.get(train.routeId);
      if (!route) return;

      // 진행 방향 기준으로 바꿔 생각한다. 양수면 뒤처진 것, 음수면 앞선 것.
      const lag = remaining * train.dir;
      const moved = Math.max(0, (train.along - before[i]) * train.dir);
      const loopMoved = route.loop && moved > route.length / 2 ? 0 : moved;
      const { shift, left } =
        lag > 0
          ? catchUp(train, route, lag, loopMoved, dt, ratio)
          : holdBack(train, lag, loopMoved, dt, ratio);

      if (Math.abs(left) < 1) this.drift.delete(train.id);
      else this.drift.set(train.id, left * train.dir);
      if (shift !== 0) moveBy(train, route, shift);
    });

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

type Correction = {
  /** 이번 프레임에 더 가거나(+) 덜 가는(-) 거리(m, 진행 방향 기준). */
  shift: number;
  /** 남은 보정(m, 진행 방향 기준). */
  left: number;
};

/** 뒤처진 열차. 지금 속도보다 조금 더 빨리, 최고 80km/h 까지만 달린다. */
function catchUp(
  train: Train,
  route: PreparedRoute,
  lag: number,
  moved: number,
  dt: number,
  ratio: number,
): Correction {
  if (train.dwell > 0) {
    if (lag <= LEAVE_EARLY_LAG) return { shift: 0, left: lag };
    // 뒤처진 거리를 순항으로 메우는 데 드는 시간만큼만 정차를 줄인다.
    // 한꺼번에 잘라 버리면 모든 열차가 역을 스치듯 지나가 정차가 사라진다.
    // 줄인 시간만큼 앞서 나가게 되므로 그 거리는 보정에서 뺀다.
    const cruise = train.cruise ?? FALLBACK_CRUISE;
    const spare = Math.max(0, train.dwell - LEAVE_EARLY_MS);
    const cutMs = Math.min(spare, (lag / cruise) * 1000);
    train.dwell -= cutMs;
    return { shift: 0, left: lag - (cutMs / 1000) * cruise };
  }

  const limit = Math.min(CATCH_UP_MAX, train.speed * CATCH_UP_GAIN) * dt;
  const room = Math.max(0, limit - moved);
  // 다음 역을 건너뛰면 정차를 빼먹는다. 역 바로 앞까지만 당긴다.
  const toStop = Math.max(0, nextTarget(route, train.along, train.dir).distance - 1);
  const shift = Math.min(lag * ratio, room, toStop);
  return { shift, left: lag - shift };
}

/** 앞서 나간 열차. 뒤로 돌리지 않고 덜 가거나 역에서 더 기다린다. */
function holdBack(train: Train, lag: number, moved: number, dt: number, ratio: number): Correction {
  if (train.dwell > 0) {
    // 역에 세워 두는 동안 실제 열차가 따라온다.
    train.dwell = Math.max(train.dwell, 250);
    return { shift: 0, left: Math.min(0, lag + HOLD_CLOSE_RATE * dt) };
  }

  const shift = -Math.min(-lag * ratio, moved * SLOW_DOWN_SHARE);
  return { shift, left: lag - shift };
}

/** 진행 방향으로 distance 만큼 옮기고 위치·방향을 다시 계산한다. */
function moveBy(train: Train, route: PreparedRoute, distance: number): void {
  train.along += distance * train.dir;
  if (route.loop) {
    train.along = ((train.along % route.length) + route.length) % route.length;
  } else {
    train.along = Math.max(0, Math.min(route.length, train.along));
  }
  const pose = pointAlong(route.coords, route.dist, route.length, train.along);
  train.coord = pose.coord;
  train.heading = train.dir === -1 ? (pose.heading + 180) % 360 : pose.heading;
}
