import type { StationFlow } from "../data/ridership";

const WIDTH = 268;
const HEIGHT = 62;
/** 위쪽 절반은 하차, 아래쪽 절반은 승차. 가운데가 기준선이다. */
const MID = HEIGHT / 2;
const GAP = 1.2;

const COLOR_OFF = "#6fb6e8";
const COLOR_ON = "#ff7a30";
const COLOR_AXIS = "rgba(246, 240, 228, 0.22)";
const COLOR_MARK = "rgba(246, 240, 228, 0.5)";

function bar(x: number, y: number, w: number, h: number, fill: string, dim: boolean): string {
  const r = Math.min(1.5, w / 2);
  return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(
    0.6,
    h,
  ).toFixed(1)}" rx="${r}" fill="${fill}" opacity="${dim ? 0.38 : 1}"/>`;
}

/**
 * 역의 24시간 승하차를 위아래 막대로 그린다.
 * 위(파랑)가 하차, 아래(주황)가 승차라서 지도 기둥 색과 뜻이 같다.
 */
export function renderStationChart(flow: StationFlow, currentHour: number): string {
  const peak = Math.max(1, ...flow.on, ...flow.off);
  const slot = WIDTH / 24;
  const w = slot - GAP;
  const now = Math.floor(currentHour) % 24;

  const bars: string[] = [];
  for (let h = 0; h < 24; h++) {
    const x = h * slot + GAP / 2;
    const dim = h !== now;
    const offH = (flow.off[h] / peak) * (MID - 2);
    const onH = (flow.on[h] / peak) * (MID - 2);
    bars.push(bar(x, MID - offH, w, offH, COLOR_OFF, dim));
    bars.push(bar(x, MID, w, onH, COLOR_ON, dim));
  }

  // 현재 시각 칸을 옅게 감싸 어디를 보는지 알려 준다.
  const markX = now * slot;
  const marks = [6, 12, 18]
    .map(
      (h) =>
        `<text x="${(h * slot).toFixed(1)}" y="${HEIGHT - 0.5}" fill="${COLOR_MARK}" font-size="7.5" font-family="IBM Plex Mono, monospace">${h}</text>`,
    )
    .join("");

  return `<svg class="chart" viewBox="0 0 ${WIDTH} ${HEIGHT + 9}" width="100%" role="img" aria-label="시간대별 승하차">
    <rect x="${markX.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${HEIGHT}" fill="rgba(246,240,228,0.07)"/>
    <line x1="0" y1="${MID}" x2="${WIDTH}" y2="${MID}" stroke="${COLOR_AXIS}" stroke-width="0.7"/>
    ${bars.join("")}
    ${marks}
  </svg>`;
}
