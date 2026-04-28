// @ts-nocheck
/**
 * 来源：vendor/paint-board/src/core/element/draw/multiPoint.ts
 * MIT © LHRUN（https://github.com/LHRUN/paint-board）
 *
 * 改动：参数从 zustand store 解耦为构造参数（width / shapeCount）。
 */
import { generateRandomCoordinates } from './utils';

export interface MultiPointElementOptions {
  fabric: any;
  canvas: any;
  color: string;
  width: number;
  shapeCount: number;
}

export class MultiPointElement {
  private points: any[] = [];
  private lastCoordinates: { x: number; y: number }[] = [];
  group: any;
  private fabric: any;
  private canvas: any;
  private opts: MultiPointElementOptions;

  constructor(opts: MultiPointElementOptions) {
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
    const drawWidth = this.opts.width;
    const shapeCount = this.opts.shapeCount;
    const color = this.opts.color;
    const boardZoom = (this.canvas.getZoom && this.canvas.getZoom()) || 1;
    const rectSize = Math.ceil((drawWidth * 3) / boardZoom);
    const radius = 6 / boardZoom;
    const strokeWidth = 2 / boardZoom;
    const curX = points[points.length - 1].x;
    const curY = points[points.length - 1].y;
    const objects: any[] = [];
    const coords = generateRandomCoordinates(curX, curY, rectSize, shapeCount);
    coords.forEach((c) => {
      objects.push(new fabric.Circle({ left: c.x, top: c.y, radius, fill: color }));
    });
    if (this.lastCoordinates && this.lastCoordinates.length) {
      this.lastCoordinates.forEach((c, i) => {
        const cur = coords[i];
        if (!cur) return;
        objects.push(
          new fabric.Line([c.x + radius, c.y + radius, cur.x + radius, cur.y + radius], {
            stroke: color,
            strokeWidth,
          }),
        );
      });
    }
    this.lastCoordinates = coords;
    return new fabric.Group(objects);
  }
}
