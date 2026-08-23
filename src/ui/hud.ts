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
  root.querySelector("#btn-layers")!.addEventListener("click", () => {
    legend.hidden = !legend.hidden;
    handlers.onLayers();
  });
  root.querySelector("#btn-search-focus")!.addEventListener("click", () => search.focus());

  const fmt = new Intl.DateTimeFormat("en-US", {
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
        const s = liveNote
          ? `${trainCount} trains  ·  ${network.stations.length} stations  ·  ${liveNote}`
          : `${trainCount} trains  ·  ${network.stations.length} stations`;
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
        <h2>${station.name}</h2>
        <div class="en">${station.nameEn}</div>
        <div class="chips">${chips}</div>
      `;
    },
    hideStation() {
      popup.hidden = true;
    },
  };
}
