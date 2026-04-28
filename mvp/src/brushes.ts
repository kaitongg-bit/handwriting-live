// @ts-nocheck
/**
 * 笔刷注册表：新增笔刷只需往 BRUSHES 推一项，并在 applyBrush / postProcessPath 中补分支。
 * 墨水笔走 perfect-freehand 自定义画笔（Excalidraw / tldraw 同款）。
 */
import { createPerfectFreehandBrush } from './brush-engines/perfectFreehandBrush';
import { createPaintBoardBrush } from './brush-engines/paintBoard';

export type BrushId = string;

export type BrushDef = {
  id: BrushId;
  label: string;
  /** 横向滚动条里用的短名 */
  short: string;
};

export type BrushRuntimeOptions = {
  textPattern?: string;
  textFont?: string;
  textSizeMul?: number;
  textGapMul?: number;
  textRandomAngle?: number;
  textRandomScale?: number;
  inkPressureEnabled?: boolean;
  inkThinning?: number;
  inkSmoothing?: number;
  inkStreamline?: number;
  waveAmp?: number;
  meshDensity?: number;
  roughJitter?: number;
};

export const BRUSHES: BrushDef[] = [
  { id: 'pen', label: '顺滑', short: '顺滑' },
  { id: 'pencil', label: '铅笔', short: '铅笔' },
  { id: 'jitter', label: '手抖', short: '手抖' },
  { id: 'chalk', label: '粉笔', short: '粉笔' },
  { id: 'hollow', label: '中空', short: '中空' },
  { id: 'soft', label: '柔边', short: '柔边' },
  { id: 'ink', label: '墨水（Excalidraw 同款压感）', short: '墨水' },
  { id: 'dashpen', label: '虚线钢笔', short: '虚线' },
  { id: 'wave', label: '波浪笔', short: '波浪' },
  { id: 'roughpen', label: '草稿钢笔', short: '草稿' },
  { id: 'text', label: '文字笔', short: '文字' },
  { id: 'mesh', label: '多点连接', short: '连接' },
];

export function createNoisePattern(fabric: any, color: string) {
  const size = 64;
  const tCanvas = document.createElement('canvas');
  tCanvas.width = size;
  tCanvas.height = size;
  const ctx = tCanvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 800; i++) {
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 1.5, 1.5);
  }
  return new fabric.Pattern({ source: tCanvas, repeat: 'repeat' });
}

export function applyBrush(
  fabric: any,
  canvas: any,
  brushId: BrushId,
  color: string,
  size: number,
  opts: BrushRuntimeOptions = {}
) {
  if (brushId === 'ink') {
    /**
     * 参数沿用 Excalidraw freedraw 的 thinning/smoothing/streamline/easing，
     * 但 size 用 brushSize * 1.2（不是 Excalidraw 的 4.25）：
     *   - Excalidraw 的 strokeWidth 选项为 1/2/3 像素级，所以乘 4.25 才好看；
     *   - 我们 brushSize 滑杆已经是像素，1.2 倍能让中段视觉粗细 ≈ 其他笔的 brushSize。
     */
    const brush = createPerfectFreehandBrush(fabric, canvas);
    brush.color = color;
    brush.size = Math.max(2.5, size * 1.2);
    brush.thinning = opts.inkThinning ?? 0.6;
    brush.smoothing = opts.inkSmoothing ?? 0.5;
    brush.streamline = opts.inkStreamline ?? 0.5;
    brush.simulatePressure = opts.inkPressureEnabled !== false;
    canvas.freeDrawingBrush = brush;
    return;
  }
  if (brushId === 'text' || brushId === 'mesh' || brushId === 'wave' || brushId === 'roughpen') {
    /** wave → Wiggle (paint-board F 键, 半圆 arc 翻转 = 波浪曲线)
     *  roughpen → MultiLine (主笔 + 跨度副线, 草稿钢笔感) */
    const kindMap = { text: 'text', mesh: 'multiPoint', wave: 'wiggle', roughpen: 'multiLine' } as const;
    canvas.freeDrawingBrush = createPaintBoardBrush(
      fabric,
      canvas,
      kindMap[brushId],
      color,
      size,
      opts,
    );
    return;
  }
  const b = new fabric.PencilBrush(canvas);
  b.color = color;
  switch (brushId) {
    case 'pen':
      b.width = size;
      b.decimate = 14;
      break;
    case 'pencil':
      b.width = size * 1.35;
      b.decimate = 4;
      b.color = createNoisePattern(fabric, color);
      break;
    case 'jitter':
      b.width = size * 1.5;
      b.decimate = 1;
      break;
    case 'chalk':
      b.width = size * 2.2;
      b.decimate = 3;
      b.color = createNoisePattern(fabric, color);
      break;
    case 'hollow':
      b.width = size * 2.2;
      b.decimate = 5;
      break;
    case 'soft':
      b.width = size * 1.2;
      b.decimate = 8;
      break;
    case 'dashpen':
      b.width = size * 1.1;
      b.decimate = 8;
      break;
    case 'wave':
      b.width = size * 1.05;
      b.decimate = 2;
      break;
    case 'roughpen':
      b.width = size * 1.15;
      b.decimate = 1;
      break;
    case 'text':
      b.width = size * 1.1;
      b.decimate = 5;
      break;
    case 'mesh':
      b.width = size * 0.95;
      b.decimate = 4;
      break;
    default:
      b.width = size;
      b.decimate = 14;
  }
  canvas.freeDrawingBrush = b;
}

function deepClonePathData(pathData: any[]) {
  return pathData.map((cmd) => (Array.isArray(cmd) ? [...cmd] : cmd));
}

function pathToPoints(pathData: any[]) {
  const out: Array<{ x: number; y: number }> = [];
  pathData.forEach((cmd) => {
    if (!Array.isArray(cmd) || !cmd.length) return;
    const t = cmd[0];
    if (t === 'M' || t === 'L') out.push({ x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 });
    else if (t === 'Q') out.push({ x: Number(cmd[3]) || 0, y: Number(cmd[4]) || 0 });
    else if (t === 'C') out.push({ x: Number(cmd[5]) || 0, y: Number(cmd[6]) || 0 });
  });
  return out;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function quad(p0: any, p1: any, p2: any, t: number) {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
}

function cubic(p0: any, p1: any, p2: any, p3: any, t: number) {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t ** 3 * p3.y,
  };
}

function samplePath(pathData: any[], spacing = 4) {
  const pts: Array<{ x: number; y: number }> = [];
  let cur = { x: 0, y: 0 };
  let lastKept: { x: number; y: number } | null = null;
  const add = (p: { x: number; y: number }) => {
    if (!lastKept || dist(p, lastKept) >= spacing) {
      pts.push(p);
      lastKept = p;
    }
  };
  for (const cmd of pathData) {
    if (!Array.isArray(cmd) || !cmd.length) continue;
    if (cmd[0] === 'M') {
      cur = { x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 };
      add(cur);
    } else if (cmd[0] === 'L') {
      const end = { x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 };
      const n = Math.max(2, Math.ceil(dist(cur, end) / spacing));
      for (let i = 1; i <= n; i++) add({ x: lerp(cur.x, end.x, i / n), y: lerp(cur.y, end.y, i / n) });
      cur = end;
    } else if (cmd[0] === 'Q') {
      const c = { x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 };
      const end = { x: Number(cmd[3]) || 0, y: Number(cmd[4]) || 0 };
      const n = 18;
      for (let i = 1; i <= n; i++) add(quad(cur, c, end, i / n));
      cur = end;
    } else if (cmd[0] === 'C') {
      const c1 = { x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 };
      const c2 = { x: Number(cmd[3]) || 0, y: Number(cmd[4]) || 0 };
      const end = { x: Number(cmd[5]) || 0, y: Number(cmd[6]) || 0 };
      const n = 24;
      for (let i = 1; i <= n; i++) add(cubic(cur, c1, c2, end, i / n));
      cur = end;
    }
  }
  return pts;
}

function pointsToPath(pts: Array<{ x: number; y: number }>) {
  if (!pts.length) return [];
  const d: any[] = [['M', pts[0].x, pts[0].y]];
  for (let i = 1; i < pts.length; i++) d.push(['L', pts[i].x, pts[i].y]);
  return d;
}

function wavePoints(pts: Array<{ x: number; y: number }>, amp: number) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const s = Math.sin(i * 0.72) * amp;
    return { x: p.x + nx * s, y: p.y + ny * s };
  });
}

function makeVisibleInkGroup(fabric: any, pathData: any[], color: string, sw: number) {
  const pts = samplePath(pathData, Math.max(2.2, sw * 0.22)).slice(0, 260);
  const objects: any[] = [];
  if (pts.length < 2) {
    return new fabric.Path(pathData, { fill: null, stroke: color, strokeWidth: sw * 2.2, strokeLineCap: 'round' });
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const localSpeed = dist(prev, next);
    const fast = Math.max(0, Math.min(1, localSpeed / Math.max(1, sw * 2.6)));
    const t = i / Math.max(1, pts.length - 1);
    const taper = Math.pow(Math.sin(Math.PI * t), 0.55);
    const wobble = 0.86 + Math.sin(i * 0.75) * 0.22 + (Math.random() - 0.5) * 0.2;
    const r = Math.max(1.4, sw * (0.22 + taper * (1.35 - fast * 0.52)) * wobble);
    objects.push(
      new fabric.Circle({
        left: p.x,
        top: p.y,
        originX: 'center',
        originY: 'center',
        radius: r,
        fill: color,
        opacity: 0.72 + taper * 0.22,
      }),
    );
  }
  objects.push(
    new fabric.Circle({
      left: pts[0].x,
      top: pts[0].y,
      originX: 'center',
      originY: 'center',
      radius: sw * 0.9,
      fill: color,
      opacity: 0.95,
    }),
    new fabric.Circle({
      left: pts[pts.length - 1].x,
      top: pts[pts.length - 1].y,
      originX: 'center',
      originY: 'center',
      radius: sw * 1.05,
      fill: color,
      opacity: 0.98,
    }),
  );
  return new fabric.Group(objects, { isInk: true, strokeUniform: true });
}

function jitterPathData(pathData: any[], amp: number) {
  const d = deepClonePathData(pathData);
  for (const cmd of d) {
    if (!Array.isArray(cmd) || !cmd.length) continue;
    if (cmd[0] === 'Q') {
      cmd[1] += (Math.random() - 0.5) * amp;
      cmd[2] += (Math.random() - 0.5) * amp;
      cmd[3] += (Math.random() - 0.5) * amp;
      cmd[4] += (Math.random() - 0.5) * amp;
    } else if (cmd[0] === 'L' || cmd[0] === 'M') {
      cmd[1] += (Math.random() - 0.5) * amp;
      cmd[2] += (Math.random() - 0.5) * amp;
    } else if (cmd[0] === 'C') {
      for (let i = 1; i <= 6; i++) cmd[i] += (Math.random() - 0.5) * amp;
    }
  }
  return d;
}

function wavePathData(pathData: any[], amp: number) {
  const d = deepClonePathData(pathData);
  let k = 0;
  for (const cmd of d) {
    if (!Array.isArray(cmd) || !cmd.length) continue;
    const shift = Math.sin(k * 0.8) * amp;
    if (cmd[0] === 'Q') {
      cmd[2] += shift;
      cmd[4] += shift;
    } else if (cmd[0] === 'L' || cmd[0] === 'M') {
      cmd[2] += shift;
    } else if (cmd[0] === 'C') {
      cmd[2] += shift;
      cmd[4] += shift;
      cmd[6] += shift;
    }
    k++;
  }
  return d;
}

/**
 * path:created 之后调用；可能替换 path 对象（jitter / hollow）
 */
export function postProcessPath(
  fabric: any,
  canvas: any,
  path: any,
  brushId: BrushId,
  color: string,
  opts: BrushRuntimeOptions = {}
): any {
  let p = path;
  /**
   * 由自定义 brush 直接产出最终 fabric 对象（perfect-freehand → fabric.Path；
   * paint-board → fabric.Group），无需后处理。
   */
  if (brushId === 'ink' || brushId === 'text' || brushId === 'mesh' || brushId === 'wave' || brushId === 'roughpen') {
    p.set({ selectable: false, evented: true });
    return p;
  }
  p.set({ strokeLineCap: 'round', strokeLineJoin: 'round' });
  const pathData = Array.isArray(path.path) ? path.path : null;

  if (brushId === 'jitter' && pathData) {
    const newPath = new fabric.Path(jitterPathData(pathData, 5), {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    canvas.remove(path);
    p = newPath;
    canvas.add(p);
  } else if (brushId === 'wave' && pathData) {
    const ampMul = Math.max(0.2, Math.min(2.5, opts.waveAmp ?? 0.45));
    const pts = pathToPoints(pathData);
    const wavedPts = wavePoints(pts, path.strokeWidth * ampMul);
    const d = pointsToPath(wavedPts);
    const newPath = new fabric.Path(d, {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    canvas.remove(path);
    p = newPath;
    canvas.add(p);
  } else if (brushId === 'dashpen') {
    p.set({ strokeDashArray: [path.strokeWidth * 1.8, path.strokeWidth * 1.2] });
  } else if (brushId === 'hollow') {
    const outlinePath = new fabric.Path(path.path, {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    const innerPath = new fabric.Path(path.path, {
      fill: null,
      stroke: '#f4f1ea',
      strokeWidth: path.strokeWidth * 0.55,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      globalCompositeOperation: 'destination-out',
    });
    const group = new fabric.Group([outlinePath, innerPath], {
      isHollow: true,
      strokeUniform: true,
    });
    canvas.remove(path);
    p = group;
    canvas.add(p);
  } else if (brushId === 'roughpen' && pathData) {
    const j = Math.max(0.4, Math.min(6, opts.roughJitter ?? 1));
    const p1 = new fabric.Path(jitterPathData(pathData, 2.8 * j), {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth,
      opacity: 0.95,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
    });
    const p2 = new fabric.Path(jitterPathData(pathData, 4.3 * j), {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth * 0.7,
      opacity: 0.4,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
    });
    const group = new fabric.Group([p1, p2], { isRough: true, strokeUniform: true });
    canvas.remove(path);
    p = group;
    canvas.add(p);
  } else if (brushId === 'text' && pathData) {
    /** 沿采样后的等距路径放字（更均匀），并支持随机角度/大小，向 paint-board 靠齐 */
    const pts = samplePath(pathData, Math.max(4, path.strokeWidth * (opts.textGapMul ?? 1.1)));
    const pattern = (opts.textPattern || '字墨花风').replace(/\s+/g, '');
    const chars = [...pattern];
    if (!chars.length) chars.push('字');
    const baseSize = Math.max(10, path.strokeWidth * (opts.textSizeMul ?? 1.35));
    const randAng = Math.max(0, Math.min(1, opts.textRandomAngle ?? 0));
    const randScale = Math.max(0, Math.min(1, opts.textRandomScale ?? 0));
    const fontFamily = opts.textFont || `'Noto Serif SC', 'STSong', serif`;
    const glyphs: any[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const nxt = pts[Math.min(pts.length - 1, i + 1)] || cur;
      const baseAng = (Math.atan2(nxt.y - cur.y, nxt.x - cur.x) * 180) / Math.PI;
      const ang = baseAng + (Math.random() - 0.5) * 60 * randAng;
      const sc = 1 + (Math.random() - 0.5) * 0.6 * randScale;
      glyphs.push(
        new fabric.Text(chars[i % chars.length], {
          left: cur.x,
          top: cur.y,
          angle: ang,
          originX: 'center',
          originY: 'center',
          fontSize: baseSize * sc,
          fill: color,
          fontFamily,
          opacity: 0.92,
        }),
      );
    }
    const group = new fabric.Group(glyphs, { isTextBrush: true, strokeUniform: true });
    canvas.remove(path);
    p = group;
    canvas.add(p);
  } else if (brushId === 'mesh' && pathData) {
    /** 多点连接：density 影响跨点数量与跨度 */
    const density = Math.max(0.2, Math.min(2.5, opts.meshDensity ?? 1));
    const pts = samplePath(pathData, Math.max(3, path.strokeWidth * 1.4 / density));
    const lines: any[] = [];
    const span = Math.max(2, Math.round(3 / density));
    for (let i = 0; i + span < pts.length; i += span) {
      const a = pts[i];
      const b = pts[Math.min(pts.length - 1, i + span)];
      lines.push(
        new fabric.Line([a.x, a.y, b.x, b.y], {
          stroke: color,
          strokeWidth: Math.max(1, path.strokeWidth * 0.38),
          opacity: 0.5,
        }),
      );
      if (i + span * 2 < pts.length) {
        const c = pts[i + span * 2];
        lines.push(
          new fabric.Line([a.x, a.y, c.x, c.y], {
            stroke: color,
            strokeWidth: Math.max(1, path.strokeWidth * 0.3),
            opacity: 0.32,
          }),
        );
      }
    }
    const base = new fabric.Path(deepClonePathData(pathData), {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth * 0.7,
      opacity: 0.88,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
    });
    const group = new fabric.Group([base, ...lines], { isMesh: true, strokeUniform: true });
    canvas.remove(path);
    p = group;
    canvas.add(p);
  } else {
    if (brushId === 'pencil' || brushId === 'chalk') p.set({ opacity: 0.88 });
    if (brushId === 'soft')
      p.set({
        shadow: new fabric.Shadow({ color, blur: 3, offsetX: 0, offsetY: 0 }),
      });
  }

  return p;
}
