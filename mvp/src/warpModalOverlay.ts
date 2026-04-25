// @ts-nocheck
import type { Corners, Point } from './warp';
import { AXIS_HI, AXIS_LO, wireframeGrid } from './warp';

const SVG_VB = 1000;

function toSvgVb(p: Point) {
  return { x: p.x * SVG_VB, y: p.y * SVG_VB };
}

function lerpPt(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function getPointFromEvent(e: MouseEvent | TouchEvent) {
  if ('touches' in e && e.touches.length) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
}

type WarpState = { corners: Corners; vx: number; hy: number };

/**
 * 同步田字格 SVG 覆盖层（与 田字格变形-demo 一致：粉四角 + 蓝轴线 + 轴端点）
 */
export function syncWarpOverlayFromState(
  state: WarpState
): void {
  const g = wireframeGrid(state.corners, state.vx, state.hy);
  const { P_TL, P_TR, P_BL, P_BR, P_T, P_B, P_L, P_R } = g;

  const framePoly = document.getElementById('warp-frame-poly');
  const axisV = document.getElementById('warp-axis-v');
  const axisH = document.getElementById('warp-axis-h');
  const axisVHit = document.getElementById('warp-axis-v-hit');
  const axisHHit = document.getElementById('warp-axis-h-hit');
  const axisVxHandle = document.getElementById('warp-axis-vx-handle');
  const axisHyHandle = document.getElementById('warp-axis-hy-handle');
  const cornerTL = document.getElementById('warp-corner-tl');
  const cornerTR = document.getElementById('warp-corner-tr');
  const cornerBL = document.getElementById('warp-corner-bl');
  const cornerBR = document.getElementById('warp-corner-br');
  if (!framePoly || !axisV || !cornerTL) return;

  const tl = toSvgVb(P_TL);
  const tr = toSvgVb(P_TR);
  const bl = toSvgVb(P_BL);
  const br = toSvgVb(P_BR);
  const t = toSvgVb(P_T);
  const b = toSvgVb(P_B);
  const l = toSvgVb(P_L);
  const r = toSvgVb(P_R);

  framePoly.setAttribute('points', `${tl.x},${tl.y} ${tr.x},${tr.y} ${br.x},${br.y} ${bl.x},${bl.y}`);

  axisV.setAttribute('x1', String(t.x));
  axisV.setAttribute('y1', String(t.y));
  axisV.setAttribute('x2', String(b.x));
  axisV.setAttribute('y2', String(b.y));
  axisVHit?.setAttribute('x1', String(t.x));
  axisVHit?.setAttribute('y1', String(t.y));
  axisVHit?.setAttribute('x2', String(b.x));
  axisVHit?.setAttribute('y2', String(b.y));

  axisH.setAttribute('x1', String(l.x));
  axisH.setAttribute('y1', String(l.y));
  axisH.setAttribute('x2', String(r.x));
  axisH.setAttribute('y2', String(r.y));
  axisHHit?.setAttribute('x1', String(l.x));
  axisHHit?.setAttribute('y1', String(l.y));
  axisHHit?.setAttribute('x2', String(r.x));
  axisHHit?.setAttribute('y2', String(r.y));

  const tmid = lerpPt(P_T, P_B, 0.5);
  const lmid = lerpPt(P_L, P_R, 0.5);
  const tmidVb = toSvgVb(tmid);
  const lmidVb = toSvgVb(lmid);
  axisVxHandle?.setAttribute('cx', String(tmidVb.x));
  axisVxHandle?.setAttribute('cy', String(tmidVb.y));
  axisHyHandle?.setAttribute('cx', String(lmidVb.x));
  axisHyHandle?.setAttribute('cy', String(lmidVb.y));

  cornerTL.setAttribute('cx', String(tl.x));
  cornerTL.setAttribute('cy', String(tl.y));
  cornerTR?.setAttribute('cx', String(tr.x));
  cornerTR?.setAttribute('cy', String(tr.y));
  cornerBL?.setAttribute('cx', String(bl.x));
  cornerBL?.setAttribute('cy', String(bl.y));
  cornerBR?.setAttribute('cx', String(br.x));
  cornerBR?.setAttribute('cy', String(br.y));
}

type Drag = { kind: 'corner'; key: keyof Corners } | { kind: 'v' } | { kind: 'h' } | null;

let installed = false;
let activeDrag: Drag = null;

export type WarpModalDragHandlers = {
  onMoveCorner: (key: keyof Corners, n: { x: number; y: number }) => void;
  onMoveAxisV: (nx: number) => void;
  onMoveAxisH: (ny: number) => void;
  onResetCorner: (key: keyof Corners) => void;
  onResetAxisV: () => void;
  onResetAxisH: () => void;
};

/**
 * 安装四角 + 田字线拖拽（仅调用一次；与 demo 的 bindCornerDrag / bindAxisDrag 等效）
 */
export function installWarpModalDrag(
  getStage: () => HTMLElement,
  h: WarpModalDragHandlers
): void {
  if (installed) return;
  installed = true;

  function clientToNorm(clientX: number, clientY: number) {
    const st = getStage();
    const r = st.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width,
      y: (clientY - r.top) / r.height,
    };
  }

  function onPointerMove(e: Event) {
    if (!activeDrag) return;
    e.preventDefault();
    const p = getPointFromEvent(e as MouseEvent);
    const n = clientToNorm(p.x, p.y);
    if (activeDrag.kind === 'corner') {
      h.onMoveCorner(activeDrag.key, { x: clamp(n.x, -0.05, 1.05), y: clamp(n.y, -0.05, 1.05) });
    } else if (activeDrag.kind === 'v') {
      h.onMoveAxisV(clamp(n.x, AXIS_LO, AXIS_HI));
    } else if (activeDrag.kind === 'h') {
      h.onMoveAxisH(clamp(n.y, AXIS_LO, AXIS_HI));
    }
  }

  function onPointerUp() {
    activeDrag = null;
  }

  function bindCorner(el: Element | null, key: keyof Corners) {
    if (!el) return;
    const onStart = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      activeDrag = { kind: 'corner', key };
    };
    el.addEventListener('mousedown', onStart);
    el.addEventListener('touchstart', onStart, { passive: false });
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      h.onResetCorner(key);
    });
  }

  const bindAxis = (kind: 'v' | 'h', elems: (Element | null)[]) => {
    const onStart = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      activeDrag = { kind };
    };
    for (const elem of elems) {
      if (!elem) continue;
      elem.addEventListener('mousedown', onStart);
      elem.addEventListener('touchstart', onStart, { passive: false });
      elem.addEventListener('dblclick', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (kind === 'v') h.onResetAxisV();
        else h.onResetAxisH();
      });
    }
  };

  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('touchmove', onPointerMove, { passive: false });
  window.addEventListener('mouseup', onPointerUp);
  window.addEventListener('touchend', onPointerUp);

  bindCorner(document.getElementById('warp-corner-tl'), 'tl');
  bindCorner(document.getElementById('warp-corner-tr'), 'tr');
  bindCorner(document.getElementById('warp-corner-bl'), 'bl');
  bindCorner(document.getElementById('warp-corner-br'), 'br');

  bindAxis('v', [
    document.getElementById('warp-axis-v'),
    document.getElementById('warp-axis-v-hit'),
    document.getElementById('warp-axis-vx-handle'),
  ]);
  bindAxis('h', [
    document.getElementById('warp-axis-h'),
    document.getElementById('warp-axis-h-hit'),
    document.getElementById('warp-axis-hy-handle'),
  ]);
}
