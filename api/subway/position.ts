import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * 허용 노선명. src/live/lines.ts 의 apiName 과 같은 값이어야 한다.
 * Vercel 이 api/ 밖의 소스를 함수 번들에 넣지 않아 import 대신 여기에 둔다.
 * 불일치하면 클라이언트가 400 을 받으므로 조용히 깨지지는 않는다.
 */
const ALLOWED = new Set([
  "1호선",
  "2호선",
  "3호선",
  "4호선",
  "5호선",
  "6호선",
  "7호선",
  "8호선",
  "9호선",
  "경의중앙선",
  "공항철도",
  "경춘선",
  "수인분당선",
  "신분당선",
  "경강선",
  "우이신설선",
  "서해선",
]);

const UPSTREAM = "http://swopenapi.seoul.go.kr";
/** 노선당 최대 열차 수. 1호선이 80대 안팎이라 넉넉히 잡는다. */
const ROW_LIMIT = 300;
/**
 * CDN 캐시 수명(초). 상류 데이터가 20~30초 주기로 갱신되므로 그보다 짧게 잡을
 * 이유가 없다. 방문자가 몇 명이든 이 주기당 상류 호출은 노선별 1회로 묶인다.
 */
const CACHE_SECONDS = 20;
const STALE_SECONDS = 60;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const key = process.env.SUBWAY;
  if (!key) {
    res.status(500).json({ code: "NO_KEY", message: "SUBWAY 환경변수가 설정되지 않았습니다." });
    return;
  }

  const raw = req.query.line;
  const line = Array.isArray(raw) ? raw[0] : raw;
  if (!line || !ALLOWED.has(line)) {
    // 열린 프록시가 되지 않도록 알려진 노선명만 통과시킨다.
    res.status(400).json({ code: "BAD_LINE", message: `지원하지 않는 노선입니다: ${line ?? ""}` });
    return;
  }

  const url = `${UPSTREAM}/api/subway/${key}/json/realtimePosition/0/${ROW_LIMIT}/${encodeURIComponent(line)}`;

  try {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = await upstream.text();

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`,
    );
    res.status(upstream.ok ? 200 : 502).send(body);
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    res.status(504).json({
      code: timedOut ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      message: timedOut ? "실시간 API 응답이 지연됩니다." : "실시간 API 호출에 실패했습니다.",
    });
  }
}
