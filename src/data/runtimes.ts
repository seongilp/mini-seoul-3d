/**
 * 역 사이 운행 시간과 역별 정차 시간. scripts/build-runtimes.mjs 가
 * 평일 시간표의 열차별 도착·출발 시각을 이어 붙여 만든다.
 *
 * 서울교통공사가 시간표를 주는 2~9호선만 있다. 없는 구간은 null 이라
 * 호출하는 쪽이 가감속 모형으로 어림해야 한다.
 */

type RunTimesFile = {
  generatedAt: string;
  runs: Record<string, number>;
  dwells: Record<string, number>;
};

export class RunTimes {
  constructor(private readonly file: RunTimesFile) {}

  /** from 역을 떠나 to 역에 닿을 때까지의 시간(초). 방향마다 다를 수 있다. */
  run(line: string, from: string, to: string): number | null {
    return this.file.runs[`${line}|${from}|${to}`] ?? null;
  }

  /** 그 역에 서 있는 시간(초). */
  dwell(line: string, station: string): number | null {
    return this.file.dwells[`${line}|${station}`] ?? null;
  }
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** 운행 시간을 불러온다. 없어도 열차는 가감속 모형으로 달리므로 실패하면 null. */
export async function loadRunTimes(): Promise<RunTimes | null> {
  try {
    const res = await fetch("/data/runtimes.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Partial<RunTimesFile>;
    if (!isNumberRecord(body.runs) || !isNumberRecord(body.dwells)) {
      throw new Error("runtimes.json 형식이 맞지 않습니다");
    }
    return new RunTimes(body as RunTimesFile);
  } catch (error) {
    console.warn("runtimes load failed", error);
    return null;
  }
}
