// @ts-nocheck
/**
 * 来源：vendor/paint-board/src/core/element/draw/wiggle.ts
 * MIT © LHRUN（https://github.com/LHRUN/paint-board）
 *
 * 改动：参数从 zustand store / paintBoard 单例解耦为构造参数（width）。
 */

export interface WiggleElementOptions {
  fabric: any;
  canvas: any;
  color: string;
  width: number;
}

export class WiggleElement {
  private flip = 1;
  private lastPoint: any = null;
  group: any;
  private fabric: any;
  private canvas: any;
  private opts: WiggleElementOptions;

  constructor(opts: WiggleElementOptions) {
    this.fabric = opts.fabric;
    this.canvas = opts.canvas;
    this.opts = opts;
    this.group = new this.fabric.Group([], { perPixelTargetFind: true });
    this.canvas.add(this.group);
  }

  addPosition(pt: { x: number; y: number } | null | undefined) {
    if (!pt) return;
    const p = new this.fabric.Point(pt.x, pt.y);
    if (!this.lastPoint) {
      this.lastPoint = p;
      return;
    }
    const obj = this._draw(p);
    if (obj) {
      this.group.addWithUpdate(obj);
      this.canvas.requestRenderAll();
    }
  }

  private _draw(curPoint: any) {
    const { fabric } = this;
    const lastPoint = this.lastPoint;
    const distance = Math.sqrt(
      Math.pow(lastPoint.x - curPoint.x, 2) + Math.pow(lastPoint.y - curPoint.y, 2),
    );
    const midX = (lastPoint.x + curPoint.x) / 2;
    const midY = (lastPoint.y + curPoint.y) / 2;
    const angle = fabric.util.radiansToDegrees(
      Math.atan2(curPoint.y - lastPoint.y, curPoint.x - lastPoint.x),
    );
    const flip = fabric.util.radiansToDegrees((this.flip % 2) * Math.PI);
    const zoom = (this.canvas.getZoom && this.canvas.getZoom()) || 1;
    const strokeWidth = Math.max(1, this.opts.width / zoom);

    const circle = new fabric.Circle({
      top: midY,
      left: midX,
      originX: 'center',
      originY: 'center',
      radius: distance / 2,
      startAngle: angle + flip,
      endAngle: angle + flip + fabric.util.radiansToDegrees(Math.PI),
      stroke: this.opts.color,
      strokeWidth,
      fill: '',
      strokeLineJoin: 'round',
      strokeLineCap: 'round',
    });
    this.lastPoint = curPoint;
    this.flip++;
    return circle;
  }
}
