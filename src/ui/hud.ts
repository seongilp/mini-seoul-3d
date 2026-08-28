import { ArrivalsError, fetchStationArrivals, formatEta, type StationArrival } from "../live/arrivals";
import type { Ridership } from "../data/ridership";
import { displayTime, type Timetable } from "../data/timetable";
import type { Network, SimState, Station } from "../types";

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
};

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
  let crowdBucket = -1;
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
        <div class="timetable" id="timetable" hidden></div>
      `;
      // 역명은 외부 데이터라 textContent 로 넣는다.
      popup.querySelector("h2")!.textContent = station.name;
      popup.querySelector(".en")!.textContent = station.nameEn;
      shownStation = station;
      loadArrivals(station);
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
