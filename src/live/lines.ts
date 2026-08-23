/**
 * 서울 열린데이터광장 realtimePosition 이 제공하는 노선.
 *
 * apiName 은 요청 경로에 그대로 들어가는 이름이고, line 은 network.json 의 노선 id다.
 * 아래 목록과 subwayId 는 전부 실제 응답으로 확인했다.
 *
 * apiName 목록은 api/subway/position.ts 의 ALLOWED 와 일치해야 한다.
 *
 * 제공되지 않는 노선(요청 시 INFO-200): 중앙선(경의중앙선에 통합), 인천1·2호선,
 * 의정부경전철, 에버라인, 김포골드라인, 자기부상철도. 이 노선들은 실시간 모드에서도
 * 화면에 열차가 뜨지 않는다.
 */
export type LiveLine = {
  apiName: string;
  subwayId: string;
  line: string;
};

export const LIVE_LINES: LiveLine[] = [
  { apiName: "1호선", subwayId: "1001", line: "1" },
  { apiName: "2호선", subwayId: "1002", line: "2" },
  { apiName: "3호선", subwayId: "1003", line: "3" },
  { apiName: "4호선", subwayId: "1004", line: "4" },
  { apiName: "5호선", subwayId: "1005", line: "5" },
  { apiName: "6호선", subwayId: "1006", line: "6" },
  { apiName: "7호선", subwayId: "1007", line: "7" },
  { apiName: "8호선", subwayId: "1008", line: "8" },
  { apiName: "9호선", subwayId: "1009", line: "9" },
  { apiName: "경의중앙선", subwayId: "1063", line: "K" },
  { apiName: "공항철도", subwayId: "1065", line: "A" },
  { apiName: "경춘선", subwayId: "1067", line: "G" },
  { apiName: "수인분당선", subwayId: "1075", line: "B" },
  { apiName: "신분당선", subwayId: "1077", line: "S" },
  { apiName: "경강선", subwayId: "1081", line: "KK" },
  { apiName: "우이신설선", subwayId: "1092", line: "UI" },
  { apiName: "서해선", subwayId: "1093", line: "W" },
];

/** 실시간이 제공되지 않아 시뮬레이션으로 남는 노선. */
export const SIMULATED_ONLY = ["I", "I2", "U", "E", "GG", "M", "SU"];
