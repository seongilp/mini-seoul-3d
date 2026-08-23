import { isQuotaCode } from "./client";
import { SUBWAY_ID_TO_LINE } from "./subwayIds";

/** arvlCd: 열차의 조회 역 기준 상태. */
const ARRIVAL_CODE = {
  APPROACHING: "0",
  ARRIVED: "1",
  DEPARTED: "2",
  PREV_DEPARTED: "3",
} as const;

export type StationArrival = {
  /** network.json 의 노선 id. 매핑에 없으면 null. */
  line: string | null;
  /** "상행" | "하행" | "내선" | "외선" */
  updown: string;
  /** "성수행 - 역삼방면" */
  headsign: string;
  /** "일반" | "급행" | "ITX" 등 */
  kind: string;
  /** 도착까지 남은 초. 0 이면 미제공. */
  etaSec: number;
  /** "4분 30초 후", "전역 출발" 처럼 그대로 보여줄 수 있는 문구. */
  message: string;
  arrivalCode: string;
  isLastTrain: boolean;
};

type RawRow = Record<string, unknown>;

function str(row: RawRow, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v.trim() : "";
}

export class ArrivalsError extends Error {}

function normalize(row: RawRow): StationArrival | null {
  const headsign = str(row, "trainLineNm");
  if (!headsign) return null;

  const eta = Number.parseInt(str(row, "barvlDt"), 10);
  return {
    line: SUBWAY_ID_TO_LINE[str(row, "subwayId")] ?? null,
    updown: str(row, "updnLine"),
    headsign,
    kind: str(row, "btrainSttus") || "일반",
    etaSec: Number.isFinite(eta) ? eta : 0,
    message: str(row, "arvlMsg2"),
    arrivalCode: str(row, "arvlCd"),
    isLastTrain: str(row, "lstcarAt") === "1",
  };
}

/** 도착이 임박한 순으로. 시간 정보가 없는 건 뒤로 보낸다. */
function byImminence(a: StationArrival, b: StationArrival): number {
  const rank = (x: StationArrival) => {
    if (x.arrivalCode === ARRIVAL_CODE.ARRIVED) return 0;
    if (x.arrivalCode === ARRIVAL_CODE.APPROACHING) return 1;
    if (x.arrivalCode === ARRIVAL_CODE.DEPARTED) return 2;
    return 3;
  };
  const r = rank(a) - rank(b);
  if (r !== 0) return r;
  const ea = a.etaSec > 0 ? a.etaSec : Number.MAX_SAFE_INTEGER;
  const eb = b.etaSec > 0 ? b.etaSec : Number.MAX_SAFE_INTEGER;
  return ea - eb;
}

/**
 * 한 역의 실시간 도착정보를 가져온다.
 * 환승역이면 여러 노선이 섞여 오므로 호출한 쪽에서 노선별로 묶는다.
 */
export async function fetchStationArrivals(
  stationName: string,
  signal?: AbortSignal,
): Promise<StationArrival[]> {
  let res: Response;
  try {
    res = await fetch(`/api/subway/arrivals?station=${encodeURIComponent(stationName)}`, {
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ArrivalsError("도착정보를 불러오지 못했습니다.");
  }
  if (!res.ok) throw new ArrivalsError(`도착정보 요청이 실패했습니다 (HTTP ${res.status}).`);

  const body = (await res.json()) as {
    errorMessage?: { code?: string; message?: string };
    realtimeArrivalList?: RawRow[];
    code?: string;
  };

  const code = body.errorMessage?.code ?? body.code;
  if (code === "INFO-200") return [];
  if (isQuotaCode(code)) {
    throw new ArrivalsError("오늘 실시간 조회 한도를 모두 사용했습니다.");
  }
  if (code && code !== "INFO-000") {
    throw new ArrivalsError(body.errorMessage?.message ?? "도착정보를 제공하지 않는 역입니다.");
  }

  const rows = body.realtimeArrivalList;
  if (!Array.isArray(rows)) return [];

  const out: StationArrival[] = [];
  for (const row of rows) {
    const parsed = normalize(row);
    if (parsed) out.push(parsed);
  }
  return out.sort(byImminence);
}

/** "4분 30초 후" 같은 API 문구가 없을 때 쓸 대체 표기. */
export function formatEta(arrival: StationArrival): string {
  if (arrival.message) return arrival.message;
  if (arrival.etaSec <= 0) return "정보 없음";
  const m = Math.floor(arrival.etaSec / 60);
  const s = arrival.etaSec % 60;
  return m > 0 ? `${m}분 ${s}초 후` : `${s}초 후`;
}
