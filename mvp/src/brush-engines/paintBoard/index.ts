// @ts-nocheck
/**
 * paint-board 笔刷适配层：把 LHRUN/paint-board 的 *Element 类适配成 fabric.BaseBrush。
 *
 * 上游：https://github.com/LHRUN/paint-board （MIT © LHRUN）
 * 模式：
 *   每个 Element 内部持有一个 fabric.Group，addPosition(pt) 时往 group 里
 *   addWithUpdate 新对象。我们用 fabric.BaseBrush 的 onMouseDown/Move/Up 包一层，
 *   onMouseUp 时通过 fire('path:created', {path: group}) 复用现有的撤回 / 编辑链路。
 */

import { DrawTextElement } from './text';
import { MultiPointElement } from './multiPoint';
import { MultiLineElement } from './multiLine';
import { WiggleElement } from './wiggle';
import type { BrushRuntimeOptions } from '../../brushes';

export type PaintBoardBrushKind = 'text' | 'multiPoint' | 'multiLine' | 'wiggle';

interface ElementLike {
  group: any;
  addPosition(pt: { x: number; y: number } | null | undefined): void;
}

export function createPaintBoardBrush(
  fabric: any,
  canvas: any,
  kind: PaintBoardBrushKind,
  color: string,
  size: number,
  opts: BrushRuntimeOptions = {},
) {
  function newElement(): ElementLike | null {
    switch (kind) {
      case 'text':
        return new DrawTextElement({
          fabric,
          canvas,
          color,
          fontFamily: opts.textFont || `'Noto Serif SC', 'STSong', serif`,
          pattern: opts.textPattern || '字墨花风',
        }) as unknown as ElementLike;
      case 'multiPoint':
        return new MultiPointElement({
          fabric,
          canvas,
          color,
          width: size,
          shapeCount: Math.max(1, Math.round((opts.meshDensity ?? 1) * 4)),
        }) as unknown as ElementLike;
      case 'multiLine':
        return new MultiLineElement({
          fabric,
          canvas,
          color,
          width: size,
        }) as unknown as ElementLike;
      case 'wiggle':
        return new WiggleElement({
          fabric,
          canvas,
          color,
          width: Math.max(1, size * 0.6),
        }) as unknown as ElementLike;
      default:
        return null;
    }
  }

  const Base = fabric.BaseBrush;
  function Brush(this: any) {
    Base.call(this, canvas);
    this._element = null as ElementLike | null;
  }
  Brush.prototype = Object.create(Base.prototype);
  Brush.prototype.constructor = Brush;

  Brush.prototype.onMouseDown = function (pointer: { x: number; y: number }) {
    this._element = newElement();
    if (this._element) this._element.addPosition({ x: pointer.x, y: pointer.y });
  };

  Brush.prototype.onMouseMove = function (pointer: { x: number; y: number }) {
    if (this._element) this._element.addPosition({ x: pointer.x, y: pointer.y });
  };

  Brush.prototype.onMouseUp = function () {
    const el = this._element;
    this._element = null;
    if (!el) return false;
    const group = el.group;
    if (!group) return false;
    if (!group._objects || group._objects.length === 0) {
      canvas.remove(group);
      canvas.requestRenderAll();
      return false;
    }
    canvas.fire('path:created', { path: group });
    canvas.requestRenderAll();
    return false;
  };

  return new (Brush as any)();
}
