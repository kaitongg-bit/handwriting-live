// @ts-nocheck
/**
 * 来源：vendor/paint-board/src/core/element/draw/multiLine.ts
 * MIT © LHRUN（https://github.com/LHRUN/paint-board）
 *
 * 改动：参数从 zustand store 解耦为构造参数（width）。
 */

export interface MultiLineElementOptions {
  fabric: any;
  canvas: any;
  color: string;
  width: number;
}

export class MultiLineElement {
  private points: any[] = [];
  group: any;
  private fabric: any;
  private canvas: any;
  private opts: MultiLineElementOptions;

  constructor(opts: MultiLineElementOptions) {
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
    if (this.points.length < 2) return;
    const obj = this._draw();
    if (obj) {
      this.group.addWithUpdate(obj);
      this.canvas.requestRenderAll();
    }
  }

  private _draw() {
    const { fabric } = this;
    const points = this.points;
    const stroke = this.opts.color;
    const drawWidth = this.opts.width;
    const zoom = (this.canvas.getZoom && this.canvas.getZoom()) || 1;
    const strokeWidth = Math.max(1, Math.ceil(drawWidth / 3 / zoom));
    const lines: any[] = [];
    lines.push(
      new fabric.Line(
        [
          points[points.length - 1].x,
          points[points.length - 1].y,
          points[points.length - 2].x,
          points[points.length - 2].y,
        ],
        { stroke, strokeWidth },
      ),
    );
    if (points.length % 5 === 0) {
      for (let i = points.length - 5, count = 0; i >= 0 && count < 3; i = i - 5, count++) {
        lines.push(
          new fabric.Line(
            [
              points[points.length - 1].x,
              points[points.length - 1].y,
              points[i].x,
              points[i].y,
            ],
            { stroke, strokeWidth: Math.max(1, strokeWidth / 3) },
          ),
        );
      }
    }
    return new fabric.Group(lines);
  }
}
