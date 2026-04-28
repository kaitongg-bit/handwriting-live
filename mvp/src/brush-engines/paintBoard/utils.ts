// @ts-nocheck
/**
 * 来源：vendor/paint-board/src/utils/index.ts 与
 *      vendor/paint-board/src/core/element/draw/utils/index.ts
 * MIT © LHRUN（https://github.com/LHRUN/paint-board）
 */

export function getDistance(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

export function generateRandomCoordinates(centerX: number, centerY: number, size: number, count: number) {
  const halfSize = size / 2;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const randomX = Math.floor(centerX - halfSize + Math.random() * size);
    const randomY = Math.floor(centerY - halfSize + Math.random() * size);
    points.push({ x: randomX, y: randomY });
  }
  return points;
}
