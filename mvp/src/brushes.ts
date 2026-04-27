// @ts-nocheck
/**
 * 笔刷注册表：新增笔刷只需往 BRUSHES 推一项，并在 applyBrush / postProcessPath 中补分支。
 * 与 Example.html 思路对齐（PencilBrush + path:created 后处理）。
 */

export type BrushId = string;

export type BrushDef = {
  id: BrushId;
  label: string;
  /** 横向滚动条里用的短名 */
  short: string;
};

export const BRUSHES: BrushDef[] = [
  { id: 'pen', label: '顺滑', short: '顺滑' },
  { id: 'chubby', label: '粗笔', short: '粗笔' },
  { id: 'pencil', label: '铅笔', short: '铅笔' },
  { id: 'jitter', label: '手抖', short: '手抖' },
  { id: 'chalk', label: '粉笔', short: '粉笔' },
  { id: 'hollow', label: '中空', short: '中空' },
  { id: 'soft', label: '柔边', short: '柔边' },
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

export function applyBrush(fabric: any, canvas: any, brushId: BrushId, color: string, size: number) {
  const b = new fabric.PencilBrush(canvas);
  b.color = color;
  switch (brushId) {
    case 'pen':
      b.width = size;
      b.decimate = 14;
      break;
    case 'chubby':
      b.width = size * 2.6;
      b.decimate = 22;
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
    default:
      b.width = size;
      b.decimate = 14;
  }
  canvas.freeDrawingBrush = b;
}

/**
 * path:created 之后调用；可能替换 path 对象（jitter / hollow）
 */
export function postProcessPath(
  fabric: any,
  canvas: any,
  path: any,
  brushId: BrushId,
  color: string
): any {
  let p = path;
  p.set({ strokeLineCap: 'round', strokeLineJoin: 'round' });

  if (brushId === 'jitter') {
    const pathData = path.path;
    if (Array.isArray(pathData)) {
      for (let i = 0; i < pathData.length; i++) {
        const cmd = pathData[i];
        if (cmd[0] === 'Q') {
          cmd[1] += (Math.random() - 0.5) * 5;
          cmd[2] += (Math.random() - 0.5) * 5;
          cmd[3] += (Math.random() - 0.5) * 5;
          cmd[4] += (Math.random() - 0.5) * 5;
        } else if (cmd[0] === 'L') {
          cmd[1] += (Math.random() - 0.5) * 5;
          cmd[2] += (Math.random() - 0.5) * 5;
        }
      }
    }
    const newPath = new fabric.Path(path.path, {
      fill: null,
      stroke: color,
      strokeWidth: path.strokeWidth,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
    });
    canvas.remove(path);
    p = newPath;
    canvas.add(p);
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
  } else {
    if (brushId === 'pencil' || brushId === 'chalk') p.set({ opacity: 0.88 });
    if (brushId === 'soft')
      p.set({
        shadow: new fabric.Shadow({ color, blur: 3, offsetX: 0, offsetY: 0 }),
      });
  }

  return p;
}
