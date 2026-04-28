# Third-Party Notices

This product includes code adapted from the following open-source projects.

## perfect-freehand

- Repository: https://github.com/steveruizok/perfect-freehand
- License: MIT © Steve Ruiz
- Used as: npm dependency (`perfect-freehand`).
- Where: `src/brush-engines/perfectFreehandBrush.ts` wraps `getStroke` into a fabric.js custom brush.
- Parameters mirrored from Excalidraw's `getFreedrawOutlinePoints`
  (`vendor/excalidraw/packages/element/src/shape.ts`):
  `thinning = 0.6`, `smoothing = 0.5`, `streamline = 0.5`,
  `easing = easeOutSine`.
- `size` deviates intentionally: Excalidraw uses `strokeWidth * 4.25` because its
  strokeWidth options are pixel-level small numbers (1/2/3). Our `brushSize`
  slider is already in pixels, so we use `brushSize * 1.2` to keep the visual
  thickness consistent with the other (PencilBrush-based) brushes.

## paint-board (LHRUN)

- Repository: https://github.com/LHRUN/paint-board
- License: MIT © LHRUN
- Used as: code adapted (re-implemented).
- Files adapted (kept algorithm, decoupled from zustand store / paintBoard singleton):
  | Our file | Upstream |
  | --- | --- |
  | `src/brush-engines/paintBoard/text.ts`       | `src/core/element/draw/text.ts` |
  | `src/brush-engines/paintBoard/multiPoint.ts` | `src/core/element/draw/multiPoint.ts` |
  | `src/brush-engines/paintBoard/multiLine.ts`  | `src/core/element/draw/multiLine.ts` |
  | `src/brush-engines/paintBoard/wiggle.ts`     | `src/core/element/draw/wiggle.ts` |
  | `src/brush-engines/paintBoard/utils.ts`      | `src/utils/index.ts`, `src/core/element/draw/utils/index.ts` |
- Brush mapping in our project (matches paint-board UI naming):
  - `text` brush     → DrawTextElement
  - `mesh` brush     → MultiPointElement
  - `wave` brush     → WiggleElement      (paint-board's "wiggle" = F key, half-arc waves)
  - `roughpen` brush → MultiLineElement   (paint-board's "multiLine" = X key)
