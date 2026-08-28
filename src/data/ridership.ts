/**
 * 역별·시간대별 승하차 인원. scripts/build-ridership.mjs 가 만든다.
 *
 * 값은 월 합계를 일수로 나눈 일평균이라 "보통 하루의 이 시간대" 를 뜻한다.
 * 특정 날짜의 실제 인원이 아니다.
 */

export type StationFlow = {
  /** 0~23시 승차 인원. */
  on: number[];
  /** 0~23시 하차 인원. */
  off: number[];
};

type RidershipFile = {
  month: string;
  /** 한 역·한 시간대의 최대 승하차 합. 높이 정규화 기준. */
  peak: number;
  stations: Record<string, StationFlow>;
};

/** 어느 한 시점의 역 이용 상태. */
export type FlowSample = {
  on: number;
  off: number;
  total: number;
  /**
   * 순유입. (하차 - 승차) / (하차 + 승차) 로 -1~1.
   * +1 에 가까우면 사람이 모이는 곳, -1 에 가까우면 빠져나가는 곳이다.
   */
  net: number;
};

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Ridership {
  readonly month: string;
  readonly peak: number;
  private readonly stations: Record<string, StationFlow>;

  constructor(file: RidershipFile) {
    this.month = file.month;
    this.peak = file.peak || 1;
    this.stations = file.stations;
  }

  has(stationId: string): boolean {
    return stationId in this.stations;
  }

  /** 24시간 원본 배열. 그래프용. */
  rawFlow(stationId: string): StationFlow | null {
    return this.stations[stationId] ?? null;
  }

  /**
   * 소수 시각(예: 8.5 = 8시 30분)의 승하차를 앞뒤 시간대에서 보간한다.
   * 시계가 흐를 때 기둥이 뚝뚝 끊기지 않고 자라내리게 하려는 것이다.
   */
  sampleAt(stationId: string, hour: number): FlowSample | null {
    const flow = this.stations[stationId];
    if (!flow) return null;

    const base = Math.floor(hour) % 24;
    const next = (base + 1) % 24;
    const t = hour - Math.floor(hour);

    const on = lerp(flow.on[base] ?? 0, flow.on[next] ?? 0, t);
    const off = lerp(flow.off[base] ?? 0, flow.off[next] ?? 0, t);
    const total = on + off;
    return { on, off, total, net: total > 0 ? (off - on) / total : 0 };
  }

  /** 그 시각 전체 역의 승하차 합계. 상태 표시에 쓴다. */
  cityTotalAt(hour: number): { on: number; off: number } {
    let on = 0;
    let off = 0;
    for (const id of Object.keys(this.stations)) {
      const s = this.sampleAt(id, hour);
      if (s) {
        on += s.on;
        off += s.off;
      }
    }
    return { on, off };
  }

  stationIds(): string[] {
    return Object.keys(this.stations);
  }
}

/** 실패해도 앱은 이 레이어 없이 동작해야 하므로 null 을 돌려준다. */
export async function loadRidership(): Promise<Ridership | null> {
  try {
    const res = await fetch("/data/ridership.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Ridership((await res.json()) as RidershipFile);
  } catch (error) {
    console.warn("ridership load failed", error);
    return null;
  }
}
