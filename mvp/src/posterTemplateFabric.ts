// @ts-nocheck
import { fabric } from 'fabric';
import POSTER_TEMPLATES_JSON from './posterTemplates.json';

export type Placement = { x: number; y: number; w: number; h: number };

export type PosterCircleEl = {
  id: string;
  type: string;
  n?: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

export type PosterTemplate = {
  id: string;
  name: string;
  category: string;
  elements: PosterCircleEl[];
};

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

export const POSTER_TEMPLATES = POSTER_TEMPLATES_JSON as PosterTemplate[];

export function circledSlotLabel(n: string | undefined, index: number): string {
  if (n != null && n !== '') {
    const num = parseInt(String(n), 10);
    if (num >= 1 && num <= 10 && String(num) === String(n)) return CIRCLED[num - 1];
    return String(n);
  }
  return CIRCLED[index] ?? String(index + 1);
}

/** 槽位展示用：直接显示 1、2、3 或用户输入字符，不用带圈序号 */
export function plainSlotLabel(n: string | undefined, index: number): string {
  if (n != null && String(n).trim() !== '') return String(n).trim();
  return String(index + 1);
}

export function defaultPlacementForTemplate(t: PosterTemplate | undefined): Placement {
  if (!t) return { x: 28, y: 38, w: 44, h: 18 };
  if (t.category === 'square') return { x: 28, y: 24, w: 38, h: 38 };
  if (t.category === 'vertical') return { x: 34, y: 18, w: 28, h: 56 };
  if (t.category === 'horizontal') return { x: 14, y: 42, w: 72, h: 22 };
  return { x: 25, y: 30, w: 50, h: 28 };
}

export function getCircleElements(t: PosterTemplate): PosterCircleEl[] {
  return t.elements.filter((e) => e.type === 'circle');
}

export function placementBoxPx(placement: Placement, cw: number, ch: number) {
  const gw = (placement.w / 100) * cw;
  const gh = (placement.h / 100) * ch;
  const cx = (placement.x / 100) * cw + gw / 2;
  const cy = (placement.y / 100) * ch + gh / 2;
  return { cx, cy, gw, gh };
}

export function buildPosterTemplateParts(template: PosterTemplate, gw: number, gh: number) {
  const frame = new fabric.Rect({
    width: gw,
    height: gh,
    fill: 'rgba(0,0,0,0)',
    stroke: '#e32219',
    strokeWidth: 2.5,
    strokeDashArray: [8, 5],
    originX: 'center',
    originY: 'center',
    left: 0,
    top: 0,
    /** 不抢命中：让 Group.subTargetCheck 能点到下层邪修字图 */
    evented: false,
    selectable: false,
  });
  const circles = getCircleElements(template);
  const isCustom = template.id === 'custom';
  /** 预制模板仅为椭圆；自定义为「椭圆 + 圈内序号」的可拖组合 Group */
  const ellipses: fabric.Object[] = [];
  const labels: (fabric.Text | null)[] = [];
  const centers: { x: number; y: number; rx: number; ry: number }[] = [];
  for (let i = 0; i < circles.length; i++) {
    const el = circles[i];
    const lx = el.cx * gw - gw / 2;
    const ly = el.cy * gh - gh / 2;
    const rxPx = el.rx * gw;
    const ryPx = el.ry * gh;
    if (isCustom) {
      const fs = Math.max(12, Math.min(28, Math.min(rxPx, ryPx) * 0.62));
      const lab = plainSlotLabel(el.n, i);
      const txt = new fabric.Text(lab, {
        originX: 'center',
        originY: 'center',
        left: 0,
        top: 0,
        fontSize: fs,
        fill: '#e32219',
        fontFamily: 'Inter Tight, Inter, PingFang SC, sans-serif',
        fontWeight: 700,
        textAlign: 'center',
        lineHeight: 1,
        evented: false,
        selectable: false,
      });
      const ellipse = new fabric.Ellipse({
        left: 0,
        top: 0,
        rx: rxPx,
        ry: ryPx,
        originX: 'center',
        originY: 'center',
        fill: 'rgba(0,0,0,0)',
        stroke: '#e32219',
        strokeDashArray: [5, 4],
        strokeUniform: true,
        evented: false,
        selectable: false,
      });
      /** 不要用 padding：会使选中框远大于椭圆，数字看起来像跑偏且控制点在框角不在圆边 */
      const slotGrp = new fabric.Group([ellipse, txt], {
        left: lx,
        top: ly,
        originX: 'center',
        originY: 'center',
        subTargetCheck: false,
        lockRotation: true,
        lockScalingX: false,
        lockScalingY: false,
        lockScalingFlip: true,
        /** 圆位在画布顶层单独成组时可用圆心锚缩放，与调字模式一致 */
        centeredScaling: true,
        borderColor: '#ff9f0a',
        cornerColor: '#ff9f0a',
        cornerStyle: 'circle',
        transparentCorners: false,
      });
      (slotGrp as { customSlotIndex?: number }).customSlotIndex = i;
      ellipses.push(slotGrp);
      labels.push(null);
    } else {
      ellipses.push(
        new fabric.Ellipse({
          left: lx,
          top: ly,
          rx: rxPx,
          ry: ryPx,
          originX: 'center',
          originY: 'center',
          fill: 'rgba(0,0,0,0)',
          stroke: '#e32219',
          strokeDashArray: [5, 4],
          evented: false,
          selectable: false,
        })
      );
      labels.push(null);
    }
    centers.push({ x: lx, y: ly, rx: rxPx, ry: ryPx });
  }
  return { frame, ellipses, labels, centers };
}

export function fabricGroupOpts(overrides: Record<string, unknown> = {}) {
  return {
    originX: 'center',
    originY: 'center',
    /** 允许选中组内邪修字图单独缩放；依赖子元素 evented 与堆叠顺序 */
    subTargetCheck: true,
    cornerColor: '#6366f1',
    cornerStyle: 'circle',
    transparentCorners: false,
    borderColor: '#6366f1',
    lockScalingFlip: true,
    ...overrides,
  };
}

export function loadImageForSlot(
  url: string | null,
  center: { x: number; y: number; rx: number; ry: number },
  transparentPixel: string
): Promise<fabric.Image | null> {
  return new Promise((resolve) => {
    const u = url || transparentPixel;
    fabric.Image.fromURL(
      u,
      (img) => {
        if (!url) {
          resolve(null);
          return;
        }
        const fit = Math.min(center.rx, center.ry) * 2 * 0.92;
        const sc = (fit / Math.max(img.width || 1, img.height || 1)) as number;
        img.set({
          left: center.x,
          top: center.y,
          originX: 'center',
          originY: 'center',
          scaleX: sc,
          scaleY: sc,
        });
        resolve(img);
      },
      { crossOrigin: 'anonymous' }
    );
  });
}
