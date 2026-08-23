import { LIVE_LINES } from "./lines";

/**
 * subwayId → network.json 노선 id.
 *
 * 실시간 위치(realtimePosition)가 제공하는 노선은 LIVE_LINES 에서 그대로 가져오고,
 * 도착정보(realtimeStationArrival)에만 섞여 오는 노선을 추가로 얹는다.
 * 환승역을 조회하면 위치 서비스가 없는 노선의 열차도 함께 오기 때문이다.
 */
const EXTRA: Record<string, string> = {
  "1032": "GTX", // network.json 에 없음. 노선 칩만 회색으로 표시된다.
  "1061": "K", // 중앙선 (경의중앙선으로 통합)
  "1094": "I", // 인천1호선
  "1095": "I2", // 인천2호선
};

export const SUBWAY_ID_TO_LINE: Record<string, string> = {
  ...EXTRA,
  ...Object.fromEntries(LIVE_LINES.map((l) => [l.subwayId, l.line])),
};
