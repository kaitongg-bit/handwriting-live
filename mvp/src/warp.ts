/** 田字格邪修：位图 4 象限 + 可选斜四角 mesh（与桌面 demo 算法一致） */

export const SRC = 1024;
export const FRAME_MARGIN = 0.01;
export const AXIS_LO = 0.08;
export const AXIS_HI = 0.92;

export type Point = { x: number; y: number };
export type Corners = { tl: Point; tr: Point; bl: Point; br: Point };

export const defaultCorners = (): Corners => ({
  tl: { x: FRAME_MARGIN, y: FRAME_MARGIN },
  tr: { x: 1 - FRAME_MARGIN, y: FRAME_MARGIN },
  bl: { x: FRAME_MARGIN, y: 1 - FRAME_MARGIN },
  br: { x: 1 - FRAME_MARGIN, y: 1 - FRAME_MARGIN },
});

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function bilinear(c: Corners, vx: number, hy: number): Point {
  const top = lerp(c.tl, c.tr, vx);
  const bot = lerp(c.bl, c.br, vx);
  return lerp(top, bot, hy);
}

/** 9 点田字网（归一化 0~1）— 与 田字格变形-demo 覆盖层用同一构型 */
export function wireframeGrid(c: Corners, vx: number, hy: number) {
  const P_TL = c.tl;
  const P_TR = c.tr;
  const P_BL = c.bl;
  const P_BR = c.br;
  const P_T = lerp(c.tl, c.tr, vx);
  const P_B = lerp(c.bl, c.br, vx);
  const P_L = lerp(c.tl, c.bl, hy);
  const P_R = lerp(c.tr, c.br, hy);
  return { P_TL, P_TR, P_BL, P_BR, P_T, P_B, P_L, P_R };
}

export function defaultCornerPoint(key: keyof Corners, margin = FRAME_MARGIN): Point {
  return {
    tl: { x: margin, y: margin },
    tr: { x: 1 - margin, y: margin },
    bl: { x: margin, y: 1 - margin },
    br: { x: 1 - margin, y: 1 - margin },
  }[key];
}

export function isAxisAlignedRect(c: Corners, eps = 0.014): boolean {
  return (
    Math.abs(c.tl.y - c.tr.y) < eps &&
    Math.abs(c.bl.y - c.br.y) < eps &&
    Math.abs(c.tl.x - c.bl.x) < eps &&
    Math.abs(c.tr.x - c.br.x) < eps
  );
}

export function renderSourceText(
  ctx: CanvasRenderingContext2D,
  char: string,
  fontStack: string,
  size = SRC
) {
  ctx.clearRect(0, 0, size, size);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, '#f472b6');
  g.addColorStop(1, '#ec4899');
  ctx.fillStyle = g;
  ctx.font = `900 ${size * 0.92}px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(char || '字', size / 2, size * 0.52);
}

function getAffine(
  s0: Point,
  s1: Point,
  s2: Point,
  d0: Point,
  d1: Point,
  d2: Point
) {
  const x0 = s0.x,
    y0 = s0.y,
    x1 = s1.x,
    y1 = s1.y,
    x2 = s2.x,
    y2 = s2.y;
  const det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1);
  if (Math.abs(det) < 1e-9) return null;
  const invDet = 1 / det;
  const a = ((d0.x - d2.x) * (y1 - y2) - (d1.x - d2.x) * (y0 - y2)) * invDet;
  const c = ((d1.x - d2.x) * (x0 - x2) - (d0.x - d2.x) * (x1 - x2)) * invDet;
  const e = d0.x - a * x0 - c * y0;
  const b = ((d0.y - d2.y) * (y1 - y2) - (d1.y - d2.y) * (y0 - y2)) * invDet;
  const d = ((d1.y - d2.y) * (x0 - x2) - (d0.y - d2.y) * (x1 - x2)) * invDet;
  const f = d0.y - b * x0 - d * y0;
  return { a, b, c, d, e, f };
}

function drawTri(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  s0: Point,
  s1: Point,
  s2: Point,
  d0: Point,
  d1: Point,
  d2: Point
) {
  const m = getAffine(s0, s1, s2, d0, d1, d2);
  if (!m) return;
  destCtx.save();
  destCtx.beginPath();
  destCtx.moveTo(d0.x, d0.y);
  destCtx.lineTo(d1.x, d1.y);
  destCtx.lineTo(d2.x, d2.y);
  destCtx.closePath();
  destCtx.clip();
  destCtx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  destCtx.drawImage(srcCanvas, 0, 0);
  destCtx.restore();
}

function toPx(p: Point, W: number, H: number): Point {
  return { x: p.x * W, y: p.y * H };
}

/** 轴对齐矩形：源固定 50/50 切，目标按 vx/hy（与 v1 一致） */
function renderAxisAlignedRectWarp(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  c: Corners,
  vx: number,
  hy: number,
  W: number,
  H: number
) {
  const xL = c.tl.x * W;
  const xR = c.tr.x * W;
  const yT = c.tl.y * H;
  const yB = c.bl.y * H;
  const xSplit = xL + vx * (xR - xL);
  const ySplit = yT + hy * (yB - yT);
  const halfSw = SRC / 2;
  const halfSh = SRC / 2;
  const o = 1;
  destCtx.drawImage(srcCanvas, 0, 0, halfSw, halfSh, xL, yT, xSplit - xL + o, ySplit - yT + o);
  destCtx.drawImage(srcCanvas, halfSw, 0, halfSw, halfSh, xSplit, yT, xR - xSplit, ySplit - yT + o);
  destCtx.drawImage(srcCanvas, 0, halfSh, halfSw, halfSh, xL, ySplit, xSplit - xL + o, yB - ySplit);
  destCtx.drawImage(srcCanvas, halfSw, halfSh, halfSw, halfSh, xSplit, ySplit, xR - xSplit, yB - ySplit);
}

/** 将邪修结果绘制到 destCtx（尺寸 W×H） */
export function renderWarped(
  destCtx: CanvasRenderingContext2D,
  srcCanvas: HTMLCanvasElement,
  c: Corners,
  vx: number,
  hy: number,
  W: number,
  H: number
) {
  destCtx.clearRect(0, 0, W, H);
  if (isAxisAlignedRect(c)) {
    renderAxisAlignedRectWarp(destCtx, srcCanvas, c, vx, hy, W, H);
    return;
  }
  const sw = SRC,
    sh = SRC;
  const sHalfW = sw / 2,
    sHalfH = sh / 2;
  const sTL = { x: 0, y: 0 };
  const sTR = { x: sw, y: 0 };
  const sBL = { x: 0, y: sh };
  const sBR = { x: sw, y: sh };
  const sT = { x: sHalfW, y: 0 };
  const sB = { x: sHalfW, y: sh };
  const sL = { x: 0, y: sHalfH };
  const sR = { x: sw, y: sHalfH };
  const sC = { x: sHalfW, y: sHalfH };

  const P_T = lerp(c.tl, c.tr, vx);
  const P_B = lerp(c.bl, c.br, vx);
  const P_L = lerp(c.tl, c.bl, hy);
  const P_R = lerp(c.tr, c.br, hy);
  const dTL = toPx(c.tl, W, H);
  const dTR = toPx(c.tr, W, H);
  const dBL = toPx(c.bl, W, H);
  const dBR = toPx(c.br, W, H);
  const dT = toPx(P_T, W, H);
  const dB = toPx(P_B, W, H);
  const dL = toPx(P_L, W, H);
  const dR = toPx(P_R, W, H);
  const dC = toPx(bilinear(c, vx, hy), W, H);

  drawTri(destCtx, srcCanvas, sTL, sT, sC, dTL, dT, dC);
  drawTri(destCtx, srcCanvas, sTL, sC, sL, dTL, dC, dL);
  drawTri(destCtx, srcCanvas, sT, sTR, sR, dT, dTR, dR);
  drawTri(destCtx, srcCanvas, sT, sR, sC, dT, dR, dC);
  drawTri(destCtx, srcCanvas, sL, sC, sB, dL, dC, dB);
  drawTri(destCtx, srcCanvas, sL, sB, sBL, dL, dB, dBL);
  drawTri(destCtx, srcCanvas, sC, sR, sBR, dC, dR, dBR);
  drawTri(destCtx, srcCanvas, sC, sBR, sB, dC, dBR, dB);
}

/** 生成邪修后的方形位图（透明底外为裁切区，实际输出方形） */
export function buildWarpedCharCanvas(
  char: string,
  fontStack: string,
  corners: Corners,
  vx: number,
  hy: number,
  outSize: number
): HTMLCanvasElement {
  const src = document.createElement('canvas');
  src.width = SRC;
  src.height = SRC;
  const sctx = src.getContext('2d')!;
  renderSourceText(sctx, char, fontStack, SRC);

  const out = document.createElement('canvas');
  out.width = outSize;
  out.height = outSize;
  const octx = out.getContext('2d')!;
  renderWarped(octx, src, corners, vx, hy, outSize, outSize);
  return out;
}
