// @ts-nocheck
/**
 * 基于 perfect-freehand 的 fabric 自定义画笔。
 * 来源：https://github.com/steveruizok/perfect-freehand （MIT, Steve Ruiz）
 * 参数对齐 Excalidraw 的 freedraw shape：
 *   vendor/excalidraw/packages/element/src/shape.ts → getFreedrawOutlinePoints
 *   { size: strokeWidth*4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5,
 *     easing: easeOutSine }
 */
import { getStroke } from 'perfect-freehand';

const easeOutSine = (t: number) => Math.sin((t * Math.PI) / 2);

export function createPerfectFreehandBrush(fabric: any, canvas: any) {
  const Base = fabric.BaseBrush;

  function Brush(this: any) {
    Base.call(this, canvas);
    this.canvas = canvas;
    this.color = '#1a1a1a';
    this.size = 14;
    this.thinning = 0.6;
    this.smoothing = 0.5;
    this.streamline = 0.5;
    this.simulatePressure = true;
    this._points = [] as Array<[number, number, number]>;
  }
  Brush.prototype = Object.create(Base.prototype);
  Brush.prototype.constructor = Brush;

  Brush.prototype._opts = function (last: boolean) {
    return {
      size: this.size,
      thinning: this.thinning,
      smoothing: this.smoothing,
      streamline: this.streamline,
      simulatePressure: this.simulatePressure,
      easing: easeOutSine,
      last,
    };
  };

  Brush.prototype._addPoint = function (pointer: { x: number; y: number }, e?: any) {
    let pressure = 0.5;
    if (e && typeof e.pressure === 'number' && e.pressure > 0) pressure = e.pressure;
    this._points.push([pointer.x, pointer.y, pressure]);
  };

  Brush.prototype._render = function (last = false) {
    const ctx = this.canvas.contextTop;
    this.canvas.clearContext(ctx);
    if (this._points.length < 1) return;
    ctx.save();
    const t = this.canvas.viewportTransform;
    if (t) ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    const stroke = getStroke(this._points, this._opts(last));
    if (stroke.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(stroke[0][0], stroke[0][1]);
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i][0], stroke[i][1]);
      ctx.closePath();
      ctx.fillStyle = this.color;
      ctx.fill();
    }
    ctx.restore();
  };

  Brush.prototype.onMouseDown = function (pointer: { x: number; y: number }, options: { e?: any }) {
    this._points = [];
    this._addPoint(pointer, options?.e);
    this._render(false);
  };

  Brush.prototype.onMouseMove = function (pointer: { x: number; y: number }, options: { e?: any }) {
    if (this._points.length === 0) return;
    this._addPoint(pointer, options?.e);
    this._render(false);
  };

  Brush.prototype.onMouseUp = function () {
    const ctx = this.canvas.contextTop;
    this.canvas.clearContext(ctx);
    if (this._points.length < 2) {
      this._points = [];
      this.canvas.requestRenderAll();
      return false;
    }
    const stroke = getStroke(this._points, this._opts(true));
    this._points = [];
    if (stroke.length < 3) {
      this.canvas.requestRenderAll();
      return false;
    }
    let d = `M ${stroke[0][0].toFixed(2)} ${stroke[0][1].toFixed(2)} `;
    for (let i = 1; i < stroke.length; i++) {
      d += `L ${stroke[i][0].toFixed(2)} ${stroke[i][1].toFixed(2)} `;
    }
    d += 'Z';
    const path = new fabric.Path(d, {
      fill: this.color,
      stroke: null,
      strokeWidth: 0,
      selectable: false,
      evented: true,
      objectCaching: true,
      perPixelTargetFind: false,
    });
    this.canvas.add(path);
    this.canvas.fire('path:created', { path });
    this.canvas.requestRenderAll();
    return false;
  };

  return new (Brush as any)();
}
