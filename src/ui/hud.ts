import { ArrivalsError, fetchStationArrivals, formatEta, type StationArrival } from "../live/arrivals";
import type { Ridership } from "../data/ridership";
import { renderStationChart } from "./sparkline";
import { displayTime, type Timetable } from "../data/timetable";
import type { Network, SimState, Station } from "../types";

/** 따라가기 중인 열차 표시에 필요한 정보. */
export type FollowInfo = {
  line: string;
  color: string;
  destination: string;
  congestion: string | null;
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
};

/** 자정 기준 분 → "08:35". */
function formatMinutes(minutes: number): string {
  const m = Math.round(minutes) % (24 * 60);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
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
      <button id="btn-search-focus" title="역 검색">⌕</button>
      <button id="btn-night" title="야간">☾</button>
      <button id="btn-under" title="지하">地下</button>
      <button id="btn-play" title="재생 속도">×1</button>
      <button id="btn-eco" title="에코">ECO</button>
      <button id="btn-live" title="실시간 운행 (서울 열린데이터광장)">LIVE</button>
      <button id="btn-crowd" title="시간대별 승하차 인원">人</button>
      <button id="btn-layers" title="노선">≡</button>
      <button id="btn-full" title="전체화면">⛶</button>
    </div>
    <div class="zoom-stack">
      <button id="btn-in" title="확대">+</button>
      <button id="btn-out" title="축소">−</button>
      <button id="btn-north" title="북쪽으로">N</button>
    </div>
    <aside class="legend" id="legend" hidden></aside>
    <article class="popup" id="popup" hidden></article>
    <div class="follow" id="follow" hidden></div>
    <div class="timebar" id="timebar">
      <span class="timebar-label" id="timebar-label">--:--</span>
      <input id="timebar-range" type="range" min="0" max="1439" step="1" value="0"
             aria-label="시각" />
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
  root.querySelector("#btn-layers")!.addEventListener("click", () => {
    legend.hidden = !legend.hidden;
    handlers.onLayers();
  });
  root.querySelector("#btn-search-focus")!.addEventListener("click", () => search.focus());

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
        lastFollowKey = "";
        return;
      }
      const key = `${info.line}|${info.destination}|${info.congestion ?? ""}`;
      follow.hidden = false;
      if (key === lastFollowKey) return;
      lastFollowKey = key;

      follow.innerHTML = `
        <span class="follow-dot"></span>
        <span class="follow-line"></span>
        <span class="follow-dest"></span>
        <span class="follow-cong"></span>
        <span class="follow-hint">Esc 로 해제</span>
      `;
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
      loadArrivals(station);
      renderFlow(station);
      renderTimetable(station);
    },
    hideStation() {
      arrivalsAbort?.abort();
      arrivalsAbort = null;
      shownStation = null;
      popup.hidden = true;
    },
    /** 시간표는 늦게 도착할 수 있다. 팝업이 열려 있으면 다시 그린다. */
    setTimetable(next: Timetable | null) {
      timetable = next;
      if (shownStation && !popup.hidden) renderTimetable(shownStation);
    },
  };
}
