import type { Map as MapLibreMap } from "maplibre-gl";
import type { Station } from "../types";

/**
 * 역 이름표. 지도 기호(symbol)로는 굵기·자간·그림자를 마음대로 못 줘서
 * 지도 위에 HTML 로 얹는다. 겹침은 여기서 직접 가린다.
 */

/** 환승 노선이 많은 역일수록 멀리서도 보인다. */
function minZoomFor(lineCount: number): number {
  if (lineCount >= 3) return 10.6;
  if (lineCount === 2) return 12.2;
  return 13.4;
}

/** 이름표 아래 끝과 역 점 사이. */
const LIFT = 9;
/** 이름표끼리 이만큼은 떨어져야 둘 다 보인다. */
const PAD = 3;
/** 화면 밖으로 이만큼까지는 미리 계산해 가장자리에서 튀지 않게 한다. */
const MARGIN = 60;

type Item = {
  station: Station;
  minZoom: number;
  el: HTMLButtonElement | null;
  width: number;
  height: number;
  shown: boolean;
};

type Box = { left: number; top: number; right: number; bottom: number };

const overlaps = (a: Box, b: Box) =>
  a.left < b.right + PAD && b.left < a.right + PAD && a.top < b.bottom + PAD && b.top < a.bottom + PAD;

export class StationLabels {
  private readonly root: HTMLDivElement;
  private readonly items: Item[];
  private hidden: ReadonlySet<string> = new Set();
  private map: MapLibreMap | null = null;
  private frame = 0;

  constructor(
    container: HTMLElement,
    stations: Station[],
    private readonly onPick: (station: Station) => void,
    /** 이름표가 비켜 가야 할 패널들. 반투명 카드 뒤로 글자가 비치면 지저분하다. */
    private readonly avoidSelector = "",
  ) {
    this.root = document.createElement("div");
    this.root.className = "station-labels";
    container.appendChild(this.root);

    // 겹칠 때 환승역이 먼저 자리를 잡도록 미리 줄 세운다.
    this.items = stations
      .map((station) => ({
        station,
        minZoom: minZoomFor(station.lines.length),
        el: null,
        width: 0,
        height: 0,
        shown: false,
      }))
      .sort((a, b) => b.station.lines.length - a.station.lines.length);
  }

  attach(map: MapLibreMap): void {
    this.map = map;
    map.on("move", this.schedule);
    map.on("resize", this.schedule);
    // 웹 글꼴이 늦게 오면 폭이 달라진다. 다시 재서 겹침을 맞춘다.
    document.fonts?.ready.then(() => {
      for (const item of this.items) item.width = 0;
      this.schedule();
    });
    this.schedule();
  }

  /** 꺼 둔 노선에만 속한 역은 이름표도 감춘다. */
  setHiddenLines(hidden: ReadonlySet<string>): void {
    this.hidden = new Set(hidden);
    this.schedule();
  }

  private readonly schedule = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.layout();
    });
  };

  private element(item: Item): HTMLButtonElement {
    if (item.el) return item.el;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "station-label";
    // 역명은 외부 데이터라 textContent 로 넣는다.
    const name = document.createElement("b");
    name.textContent = item.station.name;
    const en = document.createElement("small");
    en.textContent = item.station.nameEn;
    el.append(name, en);
    el.addEventListener("click", () => this.onPick(item.station));
    this.root.appendChild(el);
    item.el = el;
    return el;
  }

  private obstacles(container: HTMLElement): Box[] {
    if (!this.avoidSelector) return [];
    const origin = container.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>(this.avoidSelector)]
      .filter((el) => !el.hidden && el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left - origin.left,
          top: r.top - origin.top,
          right: r.right - origin.left,
          bottom: r.bottom - origin.top,
        };
      });
  }

  private setShown(item: Item, shown: boolean): void {
    if (item.shown === shown) return;
    item.shown = shown;
    item.el?.classList.toggle("is-shown", shown);
  }

  private layout(): void {
    const map = this.map;
    if (!map) return;
    const zoom = map.getZoom();
    const container = map.getContainer();
    const { clientWidth: w, clientHeight: h } = container;
    // 위치를 쓰기 전에 패널 크기부터 읽어야 레이아웃을 두 번 계산하지 않는다.
    const placed: Box[] = this.obstacles(container);

    for (const item of this.items) {
      const { station } = item;
      const visible =
        zoom >= item.minZoom && station.lines.some((line) => !this.hidden.has(line));
      if (!visible) {
        this.setShown(item, false);
        continue;
      }

      const p = map.project([station.lng, station.lat]);
      if (p.x < -MARGIN || p.x > w + MARGIN || p.y < -MARGIN || p.y > h + MARGIN) {
        this.setShown(item, false);
        continue;
      }

      const el = this.element(item);
      if (!item.width) {
        item.width = el.offsetWidth;
        item.height = el.offsetHeight;
      }
      const box: Box = {
        left: p.x - item.width / 2,
        top: p.y - LIFT - item.height,
        right: p.x + item.width / 2,
        bottom: p.y - LIFT,
      };
      if (placed.some((other) => overlaps(box, other))) {
        this.setShown(item, false);
        continue;
      }

      placed.push(box);
      el.style.transform = `translate(${box.left.toFixed(1)}px, ${box.top.toFixed(1)}px)`;
      this.setShown(item, true);
    }
  }
}
