// @ts-nocheck
/**
 * 来源：vendor/paint-board/src/core/element/draw/text.ts
 * MIT © LHRUN（https://github.com/LHRUN/paint-board）
 *
 * 改动：从 zustand store / paintBoard 单例解耦为构造参数（fabric/canvas/color/font/pattern）。
 */
import { getDistance } from './utils';

export interface TextElementOptions {
  fabric: any;
  canvas: any;
  color: string;
  fontFamily: string;
  pattern: string;
}

export class DrawTextElement {
  private points: any[] = [];
  private counter = 0;
  private position: { x: number; y: number } = { x: 0, y: 0 };
  group: any;
  private fabric: any;
  private canvas: any;
  private opts: TextElementOptions;

  constructor(opts: TextElementOptions) {
    this.fabric = opts.fabric;
    this.canvas = opts.canvas;
    this.opts = opts;
    this.group = new this.fabric.Group([], { perPixelTargetFind: true });
    this.canvas.add(this.group);
  }

  addPosition(pt: { x: number; y: number } | null | undefined) {
    if (!pt) return;
    const p = new this.fabric.Point(pt.x, pt.y);
    this.points.push(p);
    if (this.points.length < 2) {
      this.position = { x: p.x, y: p.y };
      return;
    }
    const obj = this._draw();
    if (obj) {
      this.group.addWithUpdate(obj);
      this.canvas.requestRenderAll();
    }
  }

  private _draw() {
    const { fabric } = this;
    const points = this.points;
    const mouse = points[points.length - 1];
    const d = getDistance(this.position, mouse);
    const minFontSize = 3;
    const fontSize = minFontSize + d / 2;
    const pattern = (this.opts.pattern || '字').replace(/\s+/g, '') || '字';
    const letter = pattern[this.counter % pattern.length];
    const stepSize = this._textWidth(letter, fontSize);
    if (stepSize && d > stepSize) {
      const angle = Math.atan2(mouse.y - this.position.y, mouse.x - this.position.x);
      const text = new fabric.Text(letter, {
        fontSize,
        top: this.position.y,
        left: this.position.x,
        fontFamily: this.opts.fontFamily,
        originX: 'left',
        originY: 'bottom',
        angle: fabric.util.radiansToDegrees(angle),
        fill: this.opts.color,
      });
      this.position = {
        x: this.position.x + Math.cos(angle) * stepSize,
        y: this.position.y + Math.sin(angle) * stepSize,
      };
      this.counter++;
      return text;
    }
    return null;
  }

  private _textWidth(s: string, size: number) {
    const t = new this.fabric.Text(s, { fontSize: size, fontFamily: this.opts.fontFamily });
    return t.width;
  }
}
