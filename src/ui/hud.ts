import { ArrivalsError, fetchStationArrivals, formatEta, type StationArrival } from "../live/arrivals";
import type { Ridership } from "../data/ridership";
import { congestionColor } from "../sim/congestion";
import type { UpcomingStop } from "../sim/fleet";
import { renderStationChart } from "./sparkline";
import { displayTime, type Timetable } from "../data/timetable";
import type { Network, SimState, Station } from "../types";

/** 따라가기 중인 열차 표시에 필요한 정보. */
export type FollowInfo = {
  line: string;
  color: string;
  destination: string;
  congestion: string | null;
  /** 혼잡도가 실측인지 추정인지. */
  congestionMeasured: boolean;
  /** 다음 정차역과 남은 거리. 종착으로 향하는 중이면 null. */
  next: { name: string; distance: number } | null;
  dwelling: boolean;
  /** 앞으로 설 역들. 왼쪽 상세 패널에 목록으로 보여 준다. */
  stops: UpcomingStop[];
};

export type HudHandlers = {
  onSearch: (station: Station) => void;
  onToggleLine: (id: string) => void;
  onZoom: (delta: number) => void;
  onCompass: () => void;
  onFullscreen: () => void;
  onUnderground: () => void;
  onPlayback: () => void;
  onEco: () => void;
  onNight: () => void;
  onLayers: () => void;
  onLive: () => void;
  onCrowd: () => void;
  /** 시간 슬라이더를 끌었을 때. hour 는 0~24 소수. */
  onScrub: (hour: number) => void;
  /** 시계를 실제 현재 시각으로 되돌릴 때. */
  onNow: () => void;
};

/** 초를 "3:36" 으로. */
function formatEtaClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 남은 거리를 사람이 읽는 표기로. */
function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters / 10) * 10}m`;
}

/** 서울 기준 현재 시각을 자정 기준 분으로. */
function seoulMinutesNow(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === t)?.value ?? 0);
  return (get("hour") % 24) * 60 + get("minute");
}

/** 자정 기준 분 → "08:35". */
function formatMinutes(minutes: number): string {
  const m = Math.round(minutes) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 오른쪽 툴바. 아이콘만으로는 무엇인지 알기 어려워서 이름과 설명을 함께 둔다.
 * 도움말 팔레트도 이 목록을 그대로 쓴다.
 */
const TOOLBAR: ReadonlyArray<{
  id: string;
  icon: string;
  name: string;
  desc: string;
  /** 글자가 들어가는 버튼은 아이콘보다 작게 써야 40px 안에 들어간다. */
  variant?: "text" | "stack";
}> = [
  { id: "btn-search-focus", icon: "⌕", name: "역 검색", desc: "역 이름으로 찾아 이동합니다" },
  { id: "btn-night", icon: "☾", name: "야간", desc: "어두운 지도로 바꿉니다" },
  {
    id: "btn-under",
    icon: "地下",
    name: "지하",
    desc: "건물을 낮춰 지하 구간이 드러납니다",
    variant: "stack",
  },
  { id: "btn-play", icon: "×1", name: "배속", desc: "시간이 흐르는 속도 ×1 → ×5 → ×15" },
  {
    id: "btn-eco",
    icon: "ECO",
    name: "절전",
    desc: "열차 수와 갱신을 줄여 가볍게 돌립니다",
    variant: "text",
  },
  {
    id: "btn-live",
    icon: "LIVE",
    name: "실시간",
    desc: "서울시 실시간 위치로 실제 열차를 띄웁니다",
    variant: "text",
  },
  {
    id: "btn-crowd",
    icon: "人",
    name: "사람",
    desc: "역별 승하차를 기둥으로, 열차를 혼잡도 색으로",
  },
  { id: "btn-layers", icon: "≡", name: "노선", desc: "노선을 하나씩 켜고 끕니다" },
  { id: "btn-full", icon: "⛶", name: "전체화면", desc: "브라우저를 전체화면으로" },
  { id: "btn-help", icon: "?", name: "도움말", desc: "사용법을 봅니다" },
];

/**
 * 사람 보기 모드의 색 범례.
 * 기둥은 승하차 방향, 열차는 혼잡도라 뜻이 다르므로 둘 다 적어 준다.
 */
function renderCrowdLegend(): string {
  const bands: Array<[number, string]> = [
    [0.3, "여유"],
    [0.65, "보통"],
    [0.95, "혼잡"],
    [1.25, "매우 혼잡"],
    [1.5, "극심"],
  ];
  const swatches = bands
    .map(
      ([ratio, label]) =>
        `<span class="lg-item"><i style="background:${congestionColor(ratio)}"></i>${label}</span>`,
    )
    .join("");

  return `
    <div class="lg-row">
      <span class="lg-title">열차 혼잡도</span>
      ${swatches}
      <span class="lg-item"><i style="background:#6b6862"></i>자료 없음</span>
    </div>
    <div class="lg-row">
      <span class="lg-title">역 기둥</span>
      <span class="lg-item"><i style="background:#6fb6e8"></i>하차 우세</span>
      <span class="lg-item"><i style="background:#ff7a30"></i>승차 우세</span>
      <span class="lg-note">높이 = 승하차 인원</span>
    </div>`;
}

/** 지도 조작과 클릭 동작. 툴바 설명과 함께 도움말에 함께 보여 준다. */
const HELP_SECTIONS: Array<{ title: string; rows: Array<[string, string]> }> = [
  {
    title: "지도",
    rows: [
      ["드래그", "지도 이동"],
      ["휠 · 핀치", "확대 · 축소"],
      ["우클릭 드래그", "회전과 기울이기"],
      ["N 버튼", "북쪽으로 되돌리기"],
    ],
  },
  {
    title: "클릭",
    rows: [
      ["역", "도착정보 · 시간대별 승하차 · 첫차와 막차"],
      ["열차", "카메라가 따라가고 앞으로 설 역을 보여 줍니다"],
      ["Esc", "따라가기 해제"],
    ],
  },
  {
    title: "시간",
    rows: [
      ["아래 슬라이더", "끌면 그 시각의 열차와 승하차로 바뀝니다"],
      ["지금", "실제 현재 시각으로 되돌리기"],
      ["배속", "가만히 두면 시간이 흐릅니다"],
    ],
  },
];

function renderHelp(): string {
  const escape = (v: string) =>
    v.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);

  const buttons = TOOLBAR.map(
    (b) =>
      `<div class="help-row"><span class="help-key">${escape(b.icon)}</span>
       <span class="help-name">${escape(b.name)}</span>
       <span class="help-desc">${escape(b.desc)}</span></div>`,
  ).join("");

  const sections = HELP_SECTIONS.map(
    (s) => `<div class="help-section">
      <div class="help-title">${escape(s.title)}</div>
      ${s.rows
        .map(
          ([k, v]) =>
            `<div class="help-row"><span class="help-key is-text">${escape(k)}</span>
             <span class="help-desc">${escape(v)}</span></div>`,
        )
        .join("")}
    </div>`,
  ).join("");

  return `${sections}
    <div class="help-section">
      <div class="help-title">오른쪽 버튼</div>
      ${buttons}
    </div>
    <div class="help-foot">
      데이터 · 서울 열린데이터광장 (실시간 위치 · 도착정보 · 시간표 · 시간대별 이용현황)<br />
      열차 혼잡도 · 서울교통공사 지하철혼잡도정보 (1~8호선 실측).
      자료가 없는 노선은 승하차로 어림한 값이라 패널에 "추정" 으로 표시된다.
    </div>`;
}

export function mountHud(root: HTMLElement, network: Network, state: SimState, handlers: HudHandlers) {
  root.innerHTML = `
    <div class="clock" id="clock"></div>
    <div class="brand">
      <strong>Mini Seoul 3D</strong>
      <span>수도권 전철 실시간 모형</span>
    </div>
    <div class="search">
      <input id="search" type="search" placeholder="역 검색 — 강남, 홍대입구, Seoul Station" autocomplete="off" />
      <div class="search-list" id="results" hidden></div>
    </div>
    <div class="toolbar">
      ${TOOLBAR.map(
        (b) =>
          `<button id="${b.id}" class="${b.variant ?? ""}" aria-label="${b.name}">${b.icon}</button>`,
      ).join("")}
    </div>
    <div class="tip" id="tip" hidden></div>
    <div class="zoom-stack">
      <button id="btn-in" title="확대">+</button>
      <button id="btn-out" title="축소">−</button>
      <button id="btn-north" title="북쪽으로">N</button>
    </div>
    <aside class="legend" id="legend" hidden></aside>
    <article class="popup" id="popup" hidden></article>
    <div class="help" id="help" hidden>
      <div class="help-card" role="dialog" aria-label="사용법">
        <div class="help-top">
          <strong>Mini Seoul 3D 사용법</strong>
          <button id="help-close" aria-label="닫기">✕</button>
        </div>
        <div class="help-body" id="help-body"></div>
      </div>
    </div>
    <div class="crowd-legend" id="crowd-legend" hidden></div>
    <div class="follow" id="follow" hidden></div>
    <div class="timebar" id="timebar">
      <span class="timebar-label" id="timebar-label">--:--</span>
      <input id="timebar-range" type="range" min="0" max="1439" step="1" value="0"
             aria-label="시각" />
      <button id="timebar-now" class="timebar-now" hidden>지금</button>
      <span class="timebar-hint" id="timebar-hint"></span>
    </div>
    <div class="status" id="status"></div>
  `;

  const clock = root.querySelector("#clock") as HTMLElement;
  const results = root.querySelector("#results") as HTMLElement;
  const search = root.querySelector("#search") as HTMLInputElement;
  const legend = root.querySelector("#legend") as HTMLElement;
  const popup = root.querySelector("#popup") as HTMLElement;
  const status = root.querySelector("#status") as HTMLElement;
  const play = root.querySelector("#btn-play") as HTMLButtonElement;
  const eco = root.querySelector("#btn-eco") as HTMLButtonElement;
  const under = root.querySelector("#btn-under") as HTMLButtonElement;
  const night = root.querySelector("#btn-night") as HTMLButtonElement;
  const live = root.querySelector("#btn-live") as HTMLButtonElement;
  const crowdBtn = root.querySelector("#btn-crowd") as HTMLButtonElement;
  const follow = root.querySelector("#follow") as HTMLElement;
  const timebar = root.querySelector("#timebar") as HTMLElement;
  const timeRange = root.querySelector("#timebar-range") as HTMLInputElement;
  const timeLabel = root.querySelector("#timebar-label") as HTMLElement;
  const timeHint = root.querySelector("#timebar-hint") as HTMLElement;
  const nowBtn = root.querySelector("#timebar-now") as HTMLButtonElement;
  const tip = root.querySelector("#tip") as HTMLElement;
  const help = root.querySelector("#help") as HTMLElement;
  const crowdLegend = root.querySelector("#crowd-legend") as HTMLElement;

  const renderLegend = () => {
    legend.innerHTML = `
      <div class="legend-head"><span>노선</span><span>클릭해서 켜고 끄기</span></div>
      <div class="legend-grid">
        ${network.lines
          .map(
            (l) => `
          <button class="legend-item ${state.hiddenLines.has(l.id) ? "is-off" : ""}" data-line="${l.id}">
            <span class="swatch" style="background:${l.color}"></span>${l.name}
          </button>`,
          )
          .join("")}
      </div>
    `;
    legend.querySelectorAll<HTMLButtonElement>("[data-line]").forEach((btn) => {
      btn.onclick = () => handlers.onToggleLine(btn.dataset.line!);
    });
  };
  renderLegend();

  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    if (!q) {
      results.hidden = true;
      results.innerHTML = "";
      return;
    }
    const hits = network.stations
      .filter((s) => s.name.toLowerCase().includes(q) || s.nameEn.toLowerCase().includes(q))
      .slice(0, 12);
    results.hidden = hits.length === 0;
    results.innerHTML = hits
      .map(
        (s) => `
        <button class="search-item" data-id="${s.id}">
          <span>${s.name}</span>
          <small>${s.nameEn} · ${s.lines.join(" ")}</small>
        </button>`,
      )
      .join("");
    results.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((btn) => {
      btn.onclick = () => {
        const station = network.stations.find((s) => s.id === btn.dataset.id);
        if (station) handlers.onSearch(station);
        results.hidden = true;
      };
    });
  });

  root.querySelector("#btn-in")!.addEventListener("click", () => handlers.onZoom(0.6));
  root.querySelector("#btn-out")!.addEventListener("click", () => handlers.onZoom(-0.6));
  root.querySelector("#btn-north")!.addEventListener("click", handlers.onCompass);
  root.querySelector("#btn-full")!.addEventListener("click", handlers.onFullscreen);
  under.addEventListener("click", handlers.onUnderground);
  play.addEventListener("click", handlers.onPlayback);
  eco.addEventListener("click", handlers.onEco);
  night.addEventListener("click", handlers.onNight);
  live.addEventListener("click", handlers.onLive);
  crowdBtn.addEventListener("click", handlers.onCrowd);

  /** 끄는 동안에는 시계가 슬라이더를 덮어쓰지 않게 한다. */
  let scrubbing = false;
  const endScrub = () => {
    scrubbing = false;
  };
  timeRange.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  timeRange.addEventListener("pointerup", endScrub);
  timeRange.addEventListener("pointercancel", endScrub);
  timeRange.addEventListener("blur", endScrub);
  timeRange.addEventListener("input", () => {
    scrubbing = true;
    const minutes = Number(timeRange.value);
    timeLabel.textContent = formatMinutes(minutes);
    handlers.onScrub(minutes / 60);
  });
  timeRange.addEventListener("change", endScrub);
  nowBtn.addEventListener("click", () => {
    scrubbing = false;
    handlers.onNow();
  });
  root.querySelector("#btn-layers")!.addEventListener("click", () => {
    legend.hidden = !legend.hidden;
    handlers.onLayers();
  });
  root.querySelector("#btn-search-focus")!.addEventListener("click", () => search.focus());

  /** 아이콘만 보고는 알기 어려우니 마우스를 올리면 이름과 설명을 띄운다. */
  for (const meta of TOOLBAR) {
    const button = root.querySelector(`#${meta.id}`) as HTMLButtonElement | null;
    if (!button) continue;
    button.addEventListener("pointerenter", () => {
      tip.hidden = false;
      tip.innerHTML = `<strong></strong><span></span>`;
      tip.querySelector("strong")!.textContent = meta.name;
      tip.querySelector("span")!.textContent = meta.desc;
      const box = button.getBoundingClientRect();
      tip.style.top = `${box.top + box.height / 2}px`;
      tip.style.right = `${window.innerWidth - box.left + 10}px`;
    });
    button.addEventListener("pointerleave", () => {
      tip.hidden = true;
    });
  }

  const helpBody = root.querySelector("#help-body") as HTMLElement;
  const setHelp = (open: boolean) => {
    help.hidden = !open;
    if (open) tip.hidden = true;
  };
  helpBody.innerHTML = renderHelp();
  root.querySelector("#btn-help")!.addEventListener("click", () => setHelp(help.hidden));
  root.querySelector("#help-close")!.addEventListener("click", () => setHelp(false));
  help.addEventListener("click", (e) => {
    // 카드 바깥을 누르면 닫는다.
    if (e.target === help) setHelp(false);
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !help.hidden) setHelp(false);
    // 입력 중이 아닐 때만 ? 로 연다.
    if (e.key === "?" && document.activeElement !== search) setHelp(help.hidden);
  });

  // 서울 지하철 모형이라 시계도 서울 시각으로 보여 준다. 시간표·첫차·막차와
  // 기준이 어긋나지 않게 하려는 것이기도 하다.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
  let lastClockText = "";
  let lastStatusText = "";
  let lastSpeedLabel = "";
  let lastEco: string | null = null;
  let lastUnder: string | null = null;
  let lastClockSec = -1;
  let lastNight: string | null = null;
  let liveNote = "";
  let crowdNote = "";
  let lastTimeValue = -1;
  let lastFollowKey = "";
  let nowVisible = false;
  let lastPanelKey = "";
  let crowdBucket = -1;
  /** 팝업 그래프가 가리키는 시각. 시계·슬라이더를 따라 움직인다. */
  let flowHour = 0;
  let arrivalsAbort: AbortController | null = null;
  let timetable: Timetable | null = null;
  let ridership: Ridership | null = null;
  let crowdOn = false;
  let shownStation: Station | null = null;

  const colorOf = (lineId: string | null) =>
    network.lines.find((l) => l.id === lineId)?.color ?? "#8a8a8a";

  /** 방향(상행/하행/내선/외선)별로 묶어서 각 방향 앞쪽 2대만 보여준다. */
  const renderArrivals = (host: HTMLElement, list: StationArrival[]) => {
    if (list.length === 0) {
      host.innerHTML = `<div class="arrivals-empty">지금은 도착 예정 열차가 없습니다.</div>`;
      return;
    }

    const groups = new Map<string, StationArrival[]>();
    for (const a of list) {
      const key = `${a.line ?? "?"}|${a.updown}`;
      const g = groups.get(key);
      if (g) g.push(a);
      else groups.set(key, [a]);
    }

    host.innerHTML = "";
    for (const group of groups.values()) {
      for (const a of group.slice(0, 2)) {
        const row = document.createElement("div");
        row.className = "arrival";

        const dot = document.createElement("span");
        dot.className = "arrival-dot";
        dot.style.background = colorOf(a.line);

        const body = document.createElement("div");
        body.className = "arrival-body";

        const head = document.createElement("div");
        head.className = "arrival-head";
        head.textContent = a.headsign;
        if (a.kind !== "일반") {
          const tag = document.createElement("em");
          tag.textContent = a.kind;
          head.appendChild(tag);
        }
        if (a.isLastTrain) {
          const tag = document.createElement("em");
          tag.className = "is-last";
          tag.textContent = "막차";
          head.appendChild(tag);
        }

        const eta = document.createElement("div");
        eta.className = "arrival-eta";
        eta.textContent = formatEta(a);

        body.append(head, eta);
        row.append(dot, body);
        host.appendChild(row);
      }
    }
  };

  /**
   * 시간대별 승하차. 현재 시각 수치를 위에 적고 하루 곡선을 아래에 그린다.
   * 하루 전체가 보여야 지금이 붐비는 때인지 아닌지 알 수 있다.
   */
  const renderFlow = (station: Station) => {
    const host = popup.querySelector("#flow") as HTMLElement | null;
    if (!host) return;
    const flow = ridership?.rawFlow(station.id);
    const sample = ridership?.sampleAt(station.id, flowHour);
    if (!flow || !sample) {
      host.hidden = true;
      return;
    }

    const n = (v: number) => Math.round(v).toLocaleString("ko-KR");
    host.hidden = false;
    host.innerHTML = `
      <div class="flow-head">
        <span class="flow-hour">${String(Math.floor(flowHour)).padStart(2, "0")}시</span>
        <span class="flow-nums">
          <b class="is-off">하차 ${n(sample.off)}</b><b class="is-on">승차 ${n(sample.on)}</b>
        </span>
      </div>
      ${renderStationChart(flow, flowHour)}
      <div class="flow-foot">시간대별 일평균 · ${ridership?.month.slice(0, 4)}년 ${Number(ridership?.month.slice(4))}월</div>
    `;
  };

  /** 첫차·막차. 서울교통공사 1~9호선만 데이터가 있다. */
  const renderTimetable = (station: Station) => {
    const host = popup.querySelector("#timetable") as HTMLElement | null;
    if (!host) return;
    if (!timetable) {
      host.hidden = true;
      return;
    }

    const rows = timetable.edgesFor(station.id, new Date());
    if (rows.length === 0) {
      host.hidden = true;
      return;
    }

    host.hidden = false;
    host.innerHTML = `<div class="timetable-head">첫차 · 막차</div>`;
    for (const { line, direction, edge } of rows) {
      const meta = network.lines.find((l) => l.id === line);
      const row = document.createElement("div");
      row.className = "tt-row";

      const dot = document.createElement("span");
      dot.className = "tt-dot";
      dot.style.background = meta?.color ?? "#8a8a8a";

      const dest = document.createElement("span");
      dest.className = "tt-dest";
      // 첫차와 막차의 종착역이 다를 수 있어 둘 다 보여 준다.
      dest.textContent = edge[1] === edge[3] ? `${edge[1]}행` : `${edge[1]}행 / ${edge[3]}행`;

      const times = document.createElement("span");
      times.className = "tt-times";
      times.textContent = `${displayTime(edge[0])} – ${displayTime(edge[2])}`;

      row.append(dot, dest, times);
      host.appendChild(row);
      void direction;
    }
  };

  /**
   * 따라가는 열차의 상세. 역 팝업과 같은 자리를 쓰므로 둘은 동시에 뜨지 않는다.
   * 매 프레임 불리므로 내용이 그대로면 DOM 을 건드리지 않는다.
   */
  const renderTrainPanel = (info: FollowInfo) => {
    const status = info.dwelling
      ? "정차 중"
      : info.next
        ? `다음 ${info.next.name} · ${formatDistance(info.next.distance)}`
        : "종착역으로";
    const key = [
      info.line,
      info.destination,
      status,
      info.congestion ?? "",
      String(info.congestionMeasured),
      info.stops.map((s) => `${s.name}${Math.floor(s.etaSec / 5)}`).join(","),
    ].join("|");
    if (key === lastPanelKey) return;
    lastPanelKey = key;

    popup.hidden = false;
    popup.innerHTML = `
      <div class="train-head">
        <span class="train-badge"></span>
        <span class="train-dest"></span>
      </div>
      <div class="train-status"></div>
      <div class="train-stops"></div>
    `;

    const badge = popup.querySelector(".train-badge") as HTMLElement;
    badge.textContent = info.line;
    badge.style.background = info.color;

    popup.querySelector(".train-dest")!.textContent = info.destination;

    const statusEl = popup.querySelector(".train-status") as HTMLElement;
    statusEl.textContent = status;
    if (info.congestion) {
      const tag = document.createElement("em");
      tag.textContent = info.congestion;
      // 실측이 아닌 값을 실측처럼 보이게 하면 안 된다.
      tag.title = info.congestionMeasured
        ? "서울교통공사 실측 혼잡도"
        : "승하차 자료로 어림한 값";
      if (!info.congestionMeasured) tag.classList.add("is-estimate");
      statusEl.appendChild(tag);

      const note = document.createElement("small");
      note.className = "train-cong-src";
      note.textContent = info.congestionMeasured ? "실측" : "추정";
      statusEl.appendChild(note);
    }

    const list = popup.querySelector(".train-stops") as HTMLElement;
    if (info.stops.length === 0) return;
    list.innerHTML = `<div class="train-stops-head">앞으로 설 역</div>`;
    for (const stop of info.stops) {
      const row = document.createElement("div");
      row.className = "train-stop";

      const dot = document.createElement("span");
      dot.className = "train-stop-dot";
      dot.style.background = info.color;

      const name = document.createElement("span");
      name.className = "train-stop-name";
      name.textContent = stop.name;

      const eta = document.createElement("span");
      eta.className = "train-stop-eta";
      eta.textContent = formatEtaClock(stop.etaSec);

      row.append(dot, name, eta);
      list.appendChild(row);
    }
  };

  const loadArrivals = (station: Station) => {
    const host = popup.querySelector("#arrivals") as HTMLElement | null;
    if (!host) return;

    arrivalsAbort?.abort();
    arrivalsAbort = new AbortController();
    const signal = arrivalsAbort.signal;

    fetchStationArrivals(station.name, signal)
      .then((list) => {
        if (signal.aborted) return;
        renderArrivals(host, list);
      })
      .catch((error) => {
        if (signal.aborted) return;
        host.innerHTML = "";
        const msg = document.createElement("div");
        msg.className = "arrivals-empty";
        msg.textContent =
          error instanceof ArrivalsError ? error.message : "도착정보를 불러오지 못했습니다.";
        host.appendChild(msg);
      });
  };

  return {
    tick(now: Date, trainCount: number) {
      // 끄는 중에는 사용자의 손이 우선이다.
      if (!scrubbing) {
        const minutes = now.getHours() * 60 + now.getMinutes();
        if (minutes !== lastTimeValue) {
          lastTimeValue = minutes;
          timeRange.value = String(minutes);
          timeLabel.textContent = formatMinutes(minutes);
        }
      }

      // 실제 시각과 2분 넘게 벌어지면 되돌릴 수단을 보여 준다.
      const realMinutes = seoulMinutesNow();
      const shown = Number(timeRange.value);
      const drifted = Math.min(
        Math.abs(shown - realMinutes),
        24 * 60 - Math.abs(shown - realMinutes),
      );
      const showNow = !timeRange.disabled && drifted > 2;
      if (showNow !== nowVisible) {
        nowVisible = showNow;
        nowBtn.hidden = !showNow;
        timeHint.hidden = showNow;
      }
      const sec = Math.floor(now.getTime() / 1000);
      if (sec !== lastClockSec) {
        lastClockSec = sec;
        const c = fmt.format(now);
        if (c !== lastClockText) {
          clock.textContent = c;
          lastClockText = c;
        }
        const parts = [`${trainCount} trains`, `${network.stations.length} stations`];
        if (crowdOn && crowdNote) parts.push(crowdNote);
        if (liveNote) parts.push(liveNote);
        const s = parts.join("  ·  ");
        if (s !== lastStatusText) {
          status.textContent = s;
          lastStatusText = s;
        }
      }
      const speedLabel = `×${state.speed}`;
      if (speedLabel !== lastSpeedLabel) {
        play.textContent = speedLabel;
        lastSpeedLabel = speedLabel;
      }
      const ecoV = String(state.eco);
      if (ecoV !== lastEco) {
        eco.setAttribute("aria-pressed", ecoV);
        lastEco = ecoV;
      }
      const underV = String(state.underground);
      if (underV !== lastUnder) {
        under.setAttribute("aria-pressed", underV);
        lastUnder = underV;
      }
      const nightV = String(state.night);
      if (nightV !== lastNight) {
        night.setAttribute("aria-pressed", nightV);
        lastNight = nightV;
      }
    },
    renderLegend,
    setRidership(next: Ridership | null) {
      ridership = next;
      if (shownStation && !popup.hidden) renderFlow(shownStation);
    },
    /** 시각이 바뀌면 열려 있는 팝업의 그래프도 따라 움직인다. */
    setFlowHour(hour: number) {
      if (Math.floor(hour * 4) === Math.floor(flowHour * 4)) return;
      flowHour = hour;
      if (shownStation && !popup.hidden) renderFlow(shownStation);
    },
    setCrowd(on: boolean) {
      crowdOn = on;
      crowdBtn.setAttribute("aria-pressed", String(on));
      crowdBtn.classList.toggle("is-crowd", on);
      crowdLegend.hidden = !on;
      if (on && !crowdLegend.innerHTML) crowdLegend.innerHTML = renderCrowdLegend();
      if (!on) crowdNote = "";
    },
    /** 승하차 요약. 시각이 바뀔 때만 다시 계산한다(전 역 합계라 가볍지 않다). */
    updateCrowdNote(hour: number) {
      if (!crowdOn || !ridership) return;
      const bucket = Math.floor(hour * 4);
      if (bucket === crowdBucket) return;
      crowdBucket = bucket;
      const { on, off } = ridership.cityTotalAt(hour);
      const k = (v: number) => `${Math.round(v / 1000).toLocaleString()}천`;
      crowdNote = `${String(Math.floor(hour)).padStart(2, "0")}시 승차 ${k(on)} · 하차 ${k(off)}`;
    },
    /** 실시간 모드에서는 시각을 임의로 옮길 수 없다. */
    setScrubEnabled(enabled: boolean, hint: string) {
      timeRange.disabled = !enabled;
      timebar.classList.toggle("is-locked", !enabled);
      timeHint.textContent = hint;
    },
    /**
     * 따라가는 열차 정보. null 이면 표시를 감춘다.
     * 열차는 계속 움직이므로 매 프레임 불린다. 내용이 같으면 DOM 을 건드리지 않는다.
     */
    setFollow(info: FollowInfo | null) {
      if (!info) {
        if (!follow.hidden) follow.hidden = true;
        if (lastPanelKey) {
          popup.hidden = true;
          lastPanelKey = "";
        }
        lastFollowKey = "";
        return;
      }
      renderTrainPanel(info);
      const nextText = info.dwelling
        ? "정차 중"
        : info.next
          ? `다음 ${info.next.name} · ${formatDistance(info.next.distance)}`
          : "종착역으로";
      const key = `${info.line}|${info.destination}|${info.congestion ?? ""}|${nextText}`;
      follow.hidden = false;
      if (key === lastFollowKey) return;
      lastFollowKey = key;

      follow.innerHTML = `
        <span class="follow-dot"></span>
        <span class="follow-line"></span>
        <span class="follow-dest"></span>
        <span class="follow-cong"></span>
        <span class="follow-next"></span>
        <span class="follow-hint">Esc 로 해제</span>
      `;
      follow.querySelector(".follow-next")!.textContent = nextText;
      (follow.querySelector(".follow-dot") as HTMLElement).style.background = info.color;
      follow.querySelector(".follow-line")!.textContent = info.line;
      follow.querySelector(".follow-dest")!.textContent = info.destination;
      const cong = follow.querySelector(".follow-cong") as HTMLElement;
      cong.textContent = info.congestion ?? "";
      cong.hidden = !info.congestion;
    },
    setLive(on: boolean, note: string) {
      live.setAttribute("aria-pressed", String(on));
      live.classList.toggle("is-live", on);
      liveNote = note;
    },
    showStation(station: Station) {
      const chips = station.lines
        .map((id) => {
          const line = network.lines.find((l) => l.id === id);
          return `<span class="chip" style="background:${line?.color ?? "#999"}">${line?.name ?? id}</span>`;
        })
        .join("");
      popup.hidden = false;
      popup.innerHTML = `
        <h2></h2>
        <div class="en"></div>
        <div class="chips">${chips}</div>
        <div class="arrivals" id="arrivals"><div class="arrivals-loading">도착정보 불러오는 중…</div></div>
        <div class="flow" id="flow" hidden></div>
        <div class="timetable" id="timetable" hidden></div>
      `;
      // 역명은 외부 데이터라 textContent 로 넣는다.
      popup.querySelector("h2")!.textContent = station.name;
      popup.querySelector(".en")!.textContent = station.nameEn;
      shownStation = station;
      lastPanelKey = "";
      loadArrivals(station);
      renderFlow(station);
      renderTimetable(station);
    },
    hideStation() {
      arrivalsAbort?.abort();
      arrivalsAbort = null;
      shownStation = null;
      lastPanelKey = "";
      popup.hidden = true;
    },
    /** 시간표는 늦게 도착할 수 있다. 팝업이 열려 있으면 다시 그린다. */
    setTimetable(next: Timetable | null) {
      timetable = next;
      if (shownStation && !popup.hidden) renderTimetable(shownStation);
    },
  };
}
