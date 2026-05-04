// @ts-nocheck
import { fabric } from 'fabric';
import {
  SRC,
  AXIS_LO,
  AXIS_HI,
  defaultCorners,
  renderSourceText,
  renderWarped,
  defaultCornerPoint,
} from './warp';
import { installWarpModalDrag, syncWarpOverlayFromState } from './warpModalOverlay';
import {
  POSTER_TEMPLATES,
  defaultPlacementForTemplate,
  getCircleElements,
  placementBoxPx,
  buildPosterTemplateParts,
  fabricGroupOpts,
  loadImageForSlot,
  plainSlotLabel,
} from './posterTemplateFabric';
import type { PosterTemplate, PosterCircleEl } from './posterTemplateFabric';
import { BRUSHES, applyBrush, postProcessPath, createNoisePattern } from './brushes';
import type { BrushId } from './brushes';
import type { BrushRuntimeOptions } from './brushes';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

let step = 0;
let canvas: fabric.Canvas;
let bgImage: fabric.Image | null = null;
let templateGroup: fabric.Group | null = null;
let selectedPosterTemplate = POSTER_TEMPLATES[0];
const baseCustomTemplate = POSTER_TEMPLATES.find((t) => t.id === 'custom');
let customTemplate: PosterTemplate = baseCustomTemplate
  ? JSON.parse(JSON.stringify(baseCustomTemplate))
  : {
      id: 'custom',
      name: '自定义',
      category: 'custom',
      elements: [],
    };
let placement = defaultPlacementForTemplate(selectedPosterTemplate);
let slotUrls: (string | null)[] = [];
let refVisible = true;
/** 手写笔迹（含中空组等 fabric 对象） */
const drawHistory: fabric.Object[] = [];
let currentSlot = 0;
/** 槽位参考字 fabric.Image，与 slotUrls 同索引；从 templateGroup 解引用便于交互配置 */
let slotFabricImages: (fabric.Image | null)[] = [];
/** 第 2 步调字后相对圆心的局部偏移与相对「首次装入」的缩放倍率，供进第 3 步 / 重建模板时恢复 */
let slotImageAdjustments: Array<{
  offLX: number;
  offLY: number;
  scaleMul: number;
  scaleMulY: number;
  angle: number;
} | null> = [];
/** 自定义模板：圆位 Group 画布顶层（与海报 Group 分离），交互与第 2 步调字一致 */
let customSlotOverlayGroups: fabric.Group[] = [];
/** 第 3 步（面板）：poster＝拖整张模板；slot＝单独缩放/平移圈内参考字图 */
let step2CanvasMode: 'poster' | 'slot' = 'poster';
/** 第 4 步：选中笔画做缩放旋转（非节点级编辑） */
let pathEditMode = false;
/** 大字描写弹层打开中 */
let traceModalOpen = false;
let traceCanvas: fabric.Canvas | null = null;
/** 大字描写弹层里与主槽位同步的淡色参考图 */
let traceGuideImage: fabric.Image | null = null;
const pendingTracePaths: fabric.Object[] = [];
/** 有邪修图的槽位索引顺序 */
let traceSlotOrder: number[] = [];
let traceCursor = 0;
/** 自定义模板：点了「＋圆位」后，下一次在红框内点击将落点新圆 */
let customPlaceNext = false;

/** 自定义模板允许从 0 个圆开始，用「＋圆位 → 点画布」逐个添加 */
function normalizeCustomTemplate() {
  const circles = customTemplate.elements.filter((e) => e.type === 'circle') as PosterCircleEl[];
  if (!circles.length) {
    customTemplate.elements = [];
    return;
  }
  customTemplate.elements = circles.map((c, i) => ({
    ...c,
    id: c.id || `custom-c${i + 1}`,
    type: 'circle',
    n: c.n != null && String(c.n).trim() !== '' ? String(c.n) : String(i + 1),
    cx: Math.max(0.06, Math.min(0.94, Number(c.cx) || 0.5)),
    cy: Math.max(0.06, Math.min(0.94, Number(c.cy) || 0.5)),
    rx: Math.max(0.03, Math.min(0.4, Number(c.rx) || 0.1)),
    ry: Math.max(0.03, Math.min(0.4, Number(c.ry) || 0.1)),
  }));
}

const warpState = {
  corners: defaultCorners(),
  vx: 0.5,
  hy: 0.5,
};

const el = (id: string) => document.getElementById(id)!;

function getTplCategory(): string {
  const a = document.querySelector('.tpl-cat-btn.active') as HTMLElement | null;
  return a?.dataset.cat || 'all';
}

function syncTplCatButtons(cat: string) {
  document.querySelectorAll('.tpl-cat-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.cat === cat);
  });
}

function updatePanel1Tip() {
  const tip = document.getElementById('panel-1-tip');
  if (!tip || step !== 1) return;
  tip.textContent =
    selectedPosterTemplate.id === 'custom'
      ? '＋圆位后点红框落圆；拖橙框移圆，拖四角等比缩放，拖四边中点单独改宽窄/高低。数字连写如 12345。拖虚线框移整张 · 双指缩放'
      : '左右滑动选模板 · 拖红框移动 · 双指缩放';
}

function getSelectedWarpFont() {
  return (el('warp-font') as HTMLSelectElement).value;
}

function alignSlidersToState() {
  (el('warp-vx') as HTMLInputElement).value = String(Math.round(warpState.vx * 100));
  (el('warp-hy') as HTMLInputElement).value = String(Math.round(warpState.hy * 100));
}

function toast(msg: string) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function setStep(n: number) {
  step = Math.max(0, Math.min(3, n));
  if (step !== 1) {
    customPlaceNext = false;
    el('btn-custom-add')?.classList.remove('active');
    el('custom-place-hint')?.classList.add('hidden');
  }
  if (step !== 3) {
    pathEditMode = false;
  }
  if (n === 2) {
    step2CanvasMode = 'poster';
  }
  document.querySelectorAll('.steps .dot').forEach((d, i) => {
    d.classList.toggle('active', i === step);
    d.classList.toggle('done', i < step);
  });
  for (let i = 0; i < 4; i++) {
    el(`panel-${i}`).classList.toggle('hidden', i !== step);
  }
  const titles = [
    '第 1 步 · 选照片',
    '第 2 步 · 摆红框',
    '第 3 步 · 参考字与田字格',
    '第 4 步 · 写字与导出',
  ];
  const hints = [
    '可跳过，用浅色底。',
    '拖动整张红框到画面里你想写字的位置。',
    '生成参考字；点「调参考字」在圈内单独放缩、平移。',
    '只写字。参考布局请在第 3 步定好。',
  ];
  el('step-title').textContent = titles[step];
  el('step-hint').textContent = hints[step];
  updatePanel1Tip();
  if (step === 2) rebuildSlotButtons();

  const back = el('btn-back');
  const next = el('btn-next');
  back.style.visibility = step === 0 ? 'hidden' : 'visible';
  if (step === 3) {
    next.textContent = '导出视频';
  } else {
    next.textContent = '下一步';
  }

  applyStepMode();
  renderCustomEditor();
}

function resizeCanvas() {
  const wrap = el('stage-wrap');
  const r = wrap.getBoundingClientRect();
  canvas.setDimensions({ width: Math.max(200, r.width), height: Math.max(200, r.height) });
  if (templateGroup && selectedPosterTemplate.id === 'custom') {
    positionCustomSlotOverlaysFromData();
  } else {
    canvas.renderAll();
  }
  if (traceModalOpen && traceCanvas) {
    syncTraceCanvasSize();
    traceCanvas.renderAll();
  }
}

function syncStep2Coach() {
  const coach = document.getElementById('step2-coach');
  const btnP = document.getElementById('btn-step2-poster');
  const btnS = document.getElementById('btn-step2-slot');
  if (btnP && btnS) {
    btnP.classList.toggle('active', step2CanvasMode === 'poster');
    btnS.classList.toggle('active', step2CanvasMode === 'slot');
  }
  if (!coach) return;
  if (step !== 2) {
    coach.textContent = '';
    return;
  }
  coach.textContent =
    step2CanvasMode === 'poster'
      ? '拖动、缩放、旋转整张红框。'
      : '点圈里的字图：拖中间移动，拖角缩放；双击字图重开田字格。';
}

function syncStep4Coach() {
  /** 文案降为 toast/标题副标题，避免再占面板高度 */
  const hint = document.getElementById('step-hint');
  if (step !== 3 || !hint) return;
  if (traceModalOpen) return;
  hint.textContent = pathEditMode
    ? '编辑模式：点选已写的笔迹，拖控制点调整。再点「编辑」恢复书写。'
    : '本步只写字。参考布局请在第 3 步定好。';
}

function applyStepMode() {
  const pathEdit = step === 3 && pathEditMode && !traceModalOpen;
  canvas.selection = step === 1 || step === 2 || pathEdit;
  canvas.isDrawingMode = step === 3 && !pathEditMode && !traceModalOpen;
  if (step === 3 && canvas.isDrawingMode) updateBrush();
  /** 在 step 2 + slot 模式下，把字图从 templateGroup 取出来；其他时候放回 group。
   *  这样独立 image 能被 fabric 单独选中、拖、缩。*/
  if (step === 2 && step2CanvasMode === 'slot') detachSlotImagesFromGroup();
  else attachSlotImagesToGroup();
  if (templateGroup) {
    if (step <= 1) {
      const placeMode = step === 1 && selectedPosterTemplate.id === 'custom' && customPlaceNext;
      const movePoster = step === 1 && !placeMode;
      templateGroup.evented = movePoster;
      templateGroup.selectable = movePoster;
    } else if (step === 2) {
      const movePoster = step2CanvasMode === 'poster';
      templateGroup.evented = movePoster;
      templateGroup.selectable = movePoster;
    } else {
      templateGroup.evented = false;
      templateGroup.selectable = false;
    }
    applyCustomSlotInteraction();
  }
  applySlotImagesInteraction();
  applyPathObjectsInteraction();
  const pathBtn = el('btn-path-edit');
  if (pathBtn) pathBtn.classList.toggle('active', pathEdit);
  if (canvas) {
    if (step === 2 && step2CanvasMode === 'slot') {
      canvas.set({ cornerSize: 16, touchCornerSize: 28 });
    } else if (step === 3 && pathEditMode) {
      canvas.set({ cornerSize: 16, touchCornerSize: 28 });
    } else if (
      selectedPosterTemplate.id === 'custom' &&
      (step === 1 || (step === 2 && step2CanvasMode === 'poster'))
    ) {
      /** 自定义圆：角点与边中点缩放，触控加大便于命中 */
      canvas.set({ cornerSize: 18, touchCornerSize: 40 });
    } else {
      canvas.set({ cornerSize: 12, touchCornerSize: 20 });
    }
  }
  syncStep2Coach();
  syncStep4Coach();
  // 第 1 步不画画：必须关掉上层 canvas 命中，否则会挡住底部「下一步」
  const pe = step === 0 ? 'none' : 'auto';
  if (canvas.upperCanvasEl) (canvas.upperCanvasEl as HTMLCanvasElement).style.pointerEvents = pe;
  if (canvas.lowerCanvasEl) (canvas.lowerCanvasEl as HTMLCanvasElement).style.pointerEvents = pe;
  applyRefOpacity();
  canvas.renderAll();
}

function applyPathObjectsInteraction() {
  const allow = step === 3 && pathEditMode && !traceModalOpen;
  drawHistory.forEach((obj) => {
    if (!canvas.getObjects().includes(obj)) return;
    obj.set({ selectable: allow, evented: true });
  });
}

function clearCustomSlotOverlaysFromCanvas() {
  if (!canvas) return;
  customSlotOverlayGroups.forEach((g) => {
    if (canvas.getObjects().includes(g)) canvas.remove(g);
  });
  customSlotOverlayGroups = [];
}

function unbindTemplateGroupLayoutSync() {
  if (!templateGroup) return;
  templateGroup.off('moving', onTemplateGroupTransformForOverlays);
  templateGroup.off('scaling', onTemplateGroupTransformForOverlays);
  templateGroup.off('rotating', onTemplateGroupTransformForOverlays);
  templateGroup.off('modified', onTemplateGroupTransformForOverlays);
}

function onTemplateGroupTransformForOverlays() {
  positionCustomSlotOverlaysFromData();
}

function bindTemplateGroupLayoutSync() {
  unbindTemplateGroupLayoutSync();
  if (!templateGroup || selectedPosterTemplate.id !== 'custom') return;
  templateGroup.on('moving', onTemplateGroupTransformForOverlays);
  templateGroup.on('scaling', onTemplateGroupTransformForOverlays);
  templateGroup.on('rotating', onTemplateGroupTransformForOverlays);
  templateGroup.on('modified', onTemplateGroupTransformForOverlays);
}

/** 数据驱动：红框变换后把顶层圆位与（脱组的）字图摆回正确屏幕位置 */
function positionCustomSlotOverlaysFromData() {
  if (!templateGroup || selectedPosterTemplate.id !== 'custom' || !canvas) return;
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const M = templateGroup.calcTransformMatrix();
  const circles = getCircleElements(customTemplate) as PosterCircleEl[];
  const tg = templateGroup;

  customSlotOverlayGroups.forEach((slotGrp, i) => {
    const c = circles[i];
    if (!c) return;
    const lx = c.cx * gw - gw / 2;
    const ly = c.cy * gh - gh / 2;
    const pt = fabric.util.transformPoint(new fabric.Point(lx, ly), M);
    const rxPx = c.rx * gw;
    const ryPx = c.ry * gh;
    const fs = Math.max(12, Math.min(28, Math.min(rxPx, ryPx) * 0.62));
    slotGrp.set({
      left: pt.x,
      top: pt.y,
      angle: tg.angle ?? 0,
      scaleX: tg.scaleX ?? 1,
      scaleY: tg.scaleY ?? 1,
      skewX: tg.skewX ?? 0,
      skewY: tg.skewY ?? 0,
      originX: 'center',
      originY: 'center',
    });
    const subs = slotGrp.getObjects();
    const ell = subs[0] as fabric.Ellipse | undefined;
    const txt = subs.find((x) => x.type === 'text') as fabric.Text | undefined;
    if (ell && ell.type === 'ellipse') {
      ell.set({ rx: rxPx, ry: ryPx });
    }
    if (txt) {
      txt.set({ text: plainSlotLabel(c.n, i), fontSize: fs });
    }
    slotGrp.setCoords();
  });

  layoutCustomSlotImagesWorldFromData();
  canvas.requestRenderAll();
}

/** 参考字图在红框外顶层时，随红框矩阵对齐（组内子对象由 Fabric 自己跟父级走） */
function layoutCustomSlotImagesWorldFromData() {
  if (!templateGroup || selectedPosterTemplate.id !== 'custom' || !canvas) return;
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const M = templateGroup.calcTransformMatrix();
  const circles = getCircleElements(customTemplate) as PosterCircleEl[];
  const tg = templateGroup;
  const tgsx = tg.scaleX ?? 1;
  const tgsy = tg.scaleY ?? 1;

  slotFabricImages.forEach((img, i) => {
    if (!img) return;
    if (templateGroup.contains(img)) return;
    const c = circles[i];
    if (!c) return;
    const adj = slotImageAdjustments[i];
    const lx = c.cx * gw - gw / 2 + (adj?.offLX ?? 0);
    const ly = c.cy * gh - gh / 2 + (adj?.offLY ?? 0);
    const pt = fabric.util.transformPoint(new fabric.Point(lx, ly), M);
    const ext = img as fabric.Image & {
      __baseFitScX?: number;
      __baseFitScY?: number;
      __intrinsicFitScX?: number;
      __intrinsicFitScY?: number;
    };
    let bx = ext.__intrinsicFitScX ?? ext.__baseFitScX;
    let by = ext.__intrinsicFitScY ?? ext.__baseFitScY;
    if (bx == null || by == null) {
      bx = (img.scaleX || 1) / tgsx / (adj?.scaleMul ?? 1);
      by = (img.scaleY || 1) / tgsy / (adj?.scaleMulY ?? adj?.scaleMul ?? 1);
    }
    const sm = adj?.scaleMul ?? 1;
    const smY = adj?.scaleMulY ?? sm;
    img.set({
      left: pt.x,
      top: pt.y,
      angle: tg.angle ?? 0,
      scaleX: bx * tgsx * sm,
      scaleY: by * tgsy * smY,
      originX: 'center',
      originY: 'center',
    });
    img.setCoords();
  });
}

function canvasSlotCenterToNormalized(grp: fabric.Group) {
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  if (!templateGroup) return { cx: 0.5, cy: 0.5 };
  const inv = fabric.util.invertTransform(templateGroup.calcTransformMatrix());
  const local = fabric.util.transformPoint(new fabric.Point(grp.left ?? 0, grp.top ?? 0), inv);
  return {
    cx: Math.max(0.04, Math.min(0.96, (local.x + gw / 2) / gw)),
    cy: Math.max(0.04, Math.min(0.96, (local.y + gh / 2) / gh)),
  };
}

/** 自定义：圆位在画布顶层，红框单独 templateGroup；拖圆与拖框分开 */
function applyCustomSlotInteraction() {
  if (!templateGroup || selectedPosterTemplate.id !== 'custom') return;
  const placeMode = step === 1 && customPlaceNext;
  const canMoveSlots =
    !placeMode && (step === 1 || (step === 2 && step2CanvasMode === 'poster'));
  customSlotOverlayGroups.forEach((g) => {
    g.set({
      selectable: canMoveSlots,
      evented: canMoveSlots,
      hasBorders: canMoveSlots,
      hasControls: canMoveSlots,
      lockScalingX: false,
      lockScalingY: false,
    });
    if (canMoveSlots) {
      g.setControlsVisibility({
        tl: true,
        tr: true,
        bl: true,
        br: true,
        ml: true,
        mt: true,
        mr: true,
        mb: true,
        mtr: false,
      });
    }
    g.setCoords();
  });
}

function isCustomSlotGroup(o: fabric.Object | null | undefined): o is fabric.Object & {
  customSlotIndex: number;
} {
  return o != null && (o as fabric.Object & { customSlotIndex?: number }).customSlotIndex != null;
}

/** 嵌套 Group 选中后需重算 oCoords，否则四角控制点会堆在左上角 */
function refreshActiveCustomSlotCoords() {
  if (!canvas) return;
  const a = canvas.getActiveObject();
  if (!isCustomSlotGroup(a)) return;
  a.setCoords();
  canvas.requestRenderAll();
}

function refreshAllCustomSlotGroupsCoords() {
  if (!canvas || selectedPosterTemplate.id !== 'custom') return;
  customSlotOverlayGroups.forEach((g) => g.setCoords());
  canvas.requestRenderAll();
}

function onCustomSlotGroupModified(obj: fabric.Object) {
  const idx = (obj as fabric.Object & { customSlotIndex?: number }).customSlotIndex;
  if (idx == null || selectedPosterTemplate.id !== 'custom') return;
  if (!(step === 1 || (step === 2 && step2CanvasMode === 'poster'))) return;
  const circles = getCircleElements(customTemplate) as PosterCircleEl[];
  const c = circles[idx];
  if (!c) return;
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const grp = obj as fabric.Group;
  const tgsx = templateGroup?.scaleX ?? 1;
  const tgsy = templateGroup?.scaleY ?? 1;
  const sx = grp.scaleX ?? 1;
  const sy = grp.scaleY ?? 1;
  const relX = sx / tgsx;
  const relY = sy / tgsy;
  const subs = grp.getObjects();
  const ell = subs[0] as fabric.Ellipse | undefined;
  const txt = subs.find((x) => x.type === 'text') as fabric.Text | undefined;
  const scaled = Math.abs(relX - 1) > 0.002 || Math.abs(relY - 1) > 0.002;
  if (scaled && ell && ell.type === 'ellipse') {
    /** 四角常为等比（relX≈relY）；拖四边中点时单独改变 rx / ry */
    let nrx = (ell.rx ?? 0) * relX;
    let nry = (ell.ry ?? 0) * relY;
    nrx = Math.max(gw * 0.03, Math.min(gw * 0.48, nrx));
    nry = Math.max(gh * 0.03, Math.min(gh * 0.48, nry));
    c.rx = nrx / gw;
    c.ry = nry / gh;
    grp.set({ scaleX: tgsx, scaleY: tgsy });
    ell.set({ rx: nrx, ry: nry });
    if (txt) {
      const fs = Math.max(10, Math.min(30, Math.min(nrx, nry) * 0.62));
      txt.set({ fontSize: fs });
    }
    grp.setCoords();
  }
  const { cx, cy } = canvasSlotCenterToNormalized(grp);
  c.cx = cx;
  c.cy = cy;
  customTemplate.elements = circles;
  selectedPosterTemplate = customTemplate;
  positionCustomSlotOverlaysFromData();
}

/** 仅更新圈内文字（改槽位序号输入时，避免整组重建） */
function syncCustomSlotLabelTexts() {
  if (!templateGroup || selectedPosterTemplate.id !== 'custom') return;
  const circles = getCircleElements(customTemplate);
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  customSlotOverlayGroups.forEach((grp, idx) => {
    const txt = grp.getObjects().find((x) => x.type === 'text') as fabric.Text | undefined;
    if (!txt) return;
    const c = circles[idx];
    if (!c) return;
    const rxPx = c.rx * gw;
    const ryPx = c.ry * gh;
    const fs = Math.max(12, Math.min(28, Math.min(rxPx, ryPx) * 0.62));
    txt.set({ text: plainSlotLabel(c.n, idx), fontSize: fs });
  });
  canvas.requestRenderAll();
}

function applySlotImagesInteraction() {
  const allow = step === 2 && step2CanvasMode === 'slot';
  slotFabricImages.forEach((img) => {
    if (!img) return;
    img.set({
      selectable: allow,
      evented: allow,
      hasControls: allow,
      hasBorders: allow,
      borderColor: '#0a84ff',
      cornerColor: '#0a84ff',
      lockMovementX: !allow,
      lockMovementY: !allow,
      /** 整块位图区域可点（含透明像素），手机更好点中 */
      perPixelTargetFind: false,
    });
    img.setControlsVisibility({ mtr: false });
  });
}

/** 把当前在 canvas 顶层的字图加回 templateGroup，以便整组联动平移/缩放/旋转 */
function attachSlotImagesToGroup() {
  if (!templateGroup) return;
  let changed = false;
  slotFabricImages.forEach((img) => {
    if (!img) return;
    if (templateGroup!.contains(img)) return;
    if (canvas.getObjects().includes(img)) {
      canvas.remove(img);
    }
    /** addWithUpdate 会把世界坐标转换为 group 局部坐标，保持视觉位置 */
    templateGroup!.addWithUpdate(img);
    changed = true;
  });
  if (changed) {
    templateGroup.setCoords();
    canvas.requestRenderAll();
  }
}

/** 把字图从 templateGroup 取出到 canvas 顶层，便于单独拖动/缩放 */
function detachSlotImagesFromGroup() {
  if (!templateGroup) return;
  let changed = false;
  slotFabricImages.forEach((img) => {
    if (!img) return;
    if (!templateGroup!.contains(img)) return;
    templateGroup!.removeWithUpdate(img);
    canvas.add(img);
    changed = true;
  });
  if (changed) {
    templateGroup.setCoords();
    canvas.requestRenderAll();
  }
}

function configureSlotFabricImage(img: fabric.Image, slotIndex: number) {
  img.set({
    borderColor: '#6366f1',
    cornerColor: '#6366f1',
    cornerStyle: 'circle',
    transparentCorners: false,
    lockScalingFlip: true,
    lockRotation: true,
    hasRotatingPoint: false,
    centeredScaling: true,
    lockMovementX: false,
    lockMovementY: false,
  });
  img.setControlsVisibility({ mtr: false });
  (img as fabric.Image & { __slotIndex?: number }).__slotIndex = slotIndex;
  img.off('mousedblclick');
  img.on('mousedblclick', (opt) => {
    if (opt.e && typeof opt.e.stopPropagation === 'function') opt.e.stopPropagation();
    if (step !== 2 || step2CanvasMode !== 'slot') return;
    currentSlot = slotIndex;
    openWarpModal();
  });
}

/** 把槽位字图收进红框组后读取局部坐标，写入 slotImageAdjustments，供进下一步或重建时恢复 */
function captureSlotImageAdjustments() {
  if (!templateGroup) return;
  ensureSlotLen();
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const { centers } = buildPosterTemplateParts(selectedPosterTemplate, gw, gh);
  const wasDetachedSlot = step === 2 && step2CanvasMode === 'slot';

  attachSlotImagesToGroup();

  slotFabricImages.forEach((img, i) => {
    if (!img) {
      slotImageAdjustments[i] = null;
      return;
    }
    const c = centers[i];
    if (!c) {
      slotImageAdjustments[i] = null;
      return;
    }
    const ix =
      (img as fabric.Image & { __intrinsicFitScX?: number }).__intrinsicFitScX ?? img.scaleX ?? 1;
    const iy =
      (img as fabric.Image & { __intrinsicFitScY?: number }).__intrinsicFitScY ?? img.scaleY ?? 1;
    slotImageAdjustments[i] = {
      offLX: (img.left ?? 0) - c.x,
      offLY: (img.top ?? 0) - c.y,
      scaleMul: (img.scaleX ?? 1) / ix,
      scaleMulY: (img.scaleY ?? 1) / iy,
      angle: img.angle ?? 0,
    };
  });

  if (wasDetachedSlot) {
    detachSlotImagesFromGroup();
  }
}

function applyRefOpacity() {
  if (!templateGroup) return;
  if (step !== 3) {
    templateGroup.set({ opacity: 1 });
    if (selectedPosterTemplate.id === 'custom') {
      customSlotOverlayGroups.forEach((g) => g.set({ opacity: 1 }));
      slotFabricImages.forEach((im) => im && im.set({ opacity: 1 }));
    }
    return;
  }
  /** 第 4 步：开 = 极淡（不抢戏），关 = 完全不可见 */
  const o = refVisible ? 0.28 : 0;
  templateGroup.set({ opacity: o });
  if (selectedPosterTemplate.id === 'custom') {
    customSlotOverlayGroups.forEach((g) => g.set({ opacity: o }));
    slotFabricImages.forEach((im) => im && im.set({ opacity: o }));
  }
}

function ensureBgSolid() {
  if (bgImage) return;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const x = c.getContext('2d')!;
  x.fillStyle = '#f4f1ea';
  x.fillRect(0, 0, 4, 4);
  fabric.Image.fromURL(c.toDataURL(), (img) => {
    img.set({
      selectable: false,
      evented: false,
      originX: 'left',
      originY: 'top',
      left: 0,
      top: 0,
      scaleX: canvas.width! / 4,
      scaleY: canvas.height! / 4,
    });
    canvas.add(img);
    img.sendToBack();
    bgImage = img;
    canvas.renderAll();
  });
}

function setBgFromFile(file: File) {
  const url = URL.createObjectURL(file);
  fabric.Image.fromURL(
    url,
    (img) => {
      if (bgImage) canvas.remove(bgImage);
      const cw = canvas.width!;
      const ch = canvas.height!;
      const sc = Math.max(cw / img.width!, ch / img.height!);
      img.set({
        selectable: false,
        evented: false,
        originX: 'center',
        originY: 'center',
        left: cw / 2,
        top: ch / 2,
        scaleX: sc,
        scaleY: sc,
      });
      canvas.add(img);
      img.sendToBack();
      bgImage = img;
      URL.revokeObjectURL(url);
      canvas.renderAll();
      toast('照片已设为底图');
    },
    { crossOrigin: 'anonymous' }
  );
}

function filteredTemplates() {
  const cat = getTplCategory();
  return POSTER_TEMPLATES.filter((t) => cat === 'all' || t.category === cat);
}

function renderTplList() {
  const list = el('tpl-list');
  list.innerHTML = '';
  filteredTemplates().forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tpl-btn' + (t.id === selectedPosterTemplate.id ? ' active' : '');
    btn.textContent = t.id === 'custom' ? '圆位布局' : t.name;
    btn.dataset.tid = t.id;
    list.appendChild(btn);
  });
}

function renderCustomEditor() {
  const host = document.getElementById('custom-editor');
  const list = document.getElementById('custom-slot-list');
  if (!host || !list) return;
  const visible = step === 1 && selectedPosterTemplate.id === 'custom';
  host.classList.toggle('hidden', !visible);
  if (!visible) return;
  normalizeCustomTemplate();
  const circles = getCircleElements(customTemplate);
  const labelsIn = el('custom-labels') as HTMLInputElement;
  const typing = document.activeElement === labelsIn;
  const selA = labelsIn.selectionStart;
  const selB = labelsIn.selectionEnd;
  if (!typing) labelsIn.value = circles.map((c) => String(c.n ?? '')).join('');
  list.innerHTML = circles
    .map(
      (c, i) => `
      <div class="custom-chip" data-idx="${i}">
        <span class="custom-chip-lab">${plainSlotLabel(c.n, i)}</span>
        <button type="button" class="custom-chip-del" data-idx="${i}" aria-label="删除">×</button>
      </div>`
    )
    .join('');
  if (typing && typeof selA === 'number' && typeof selB === 'number') {
    labelsIn.focus();
    labelsIn.setSelectionRange(selA, selB);
  }
}

function refreshCustomTemplateOnCanvas(preserveTransform = false) {
  normalizeCustomTemplate();
  if (selectedPosterTemplate.id !== 'custom') return;
  selectedPosterTemplate = customTemplate;
  syncSlotsForTemplateChange(false);
  if (templateGroup && (step === 1 || step === 2)) createTemplateGroup(preserveTransform);
  renderCustomEditor();
}

function setCustomPlaceNext(on: boolean) {
  customPlaceNext = on;
  const b = el('btn-custom-add');
  if (b) b.classList.toggle('active', on);
  const hint = el('custom-place-hint');
  if (hint) hint.classList.toggle('hidden', !on);
  applyStepMode();
}

function pointerToCustomNorm(e: Event): { cx: number; cy: number } | null {
  if (!templateGroup || !canvas) return null;
  const p = canvas.getPointer(e);
  const inv = fabric.util.invertTransform(templateGroup.calcTransformMatrix());
  const pt = fabric.util.transformPoint(new fabric.Point(p.x, p.y), inv);
  const cw = canvas.getWidth();
  const ch = canvas.getHeight();
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const halfW = gw / 2;
  const halfH = gh / 2;
  if (pt.x < -halfW || pt.x > halfW || pt.y < -halfH || pt.y > halfH) return null;
  return {
    cx: Math.max(0.06, Math.min(0.94, (pt.x + halfW) / gw)),
    cy: Math.max(0.06, Math.min(0.94, (pt.y + halfH) / gh)),
  };
}

function tryConsumeCustomPlace(opt: { e?: Event }): boolean {
  if (step !== 1 || selectedPosterTemplate.id !== 'custom' || !customPlaceNext || !templateGroup)
    return false;
  const e = opt.e;
  if (!e) return false;
  const norm = pointerToCustomNorm(e);
  if (!norm) {
    toast('请在红框虚线内点击');
    setCustomPlaceNext(false);
    return true;
  }
  const circles = getCircleElements(customTemplate);
  const k = circles.length + 1;
  const last = circles[circles.length - 1];
  const r = last
    ? Math.max(0.05, Math.min(0.22, last.rx || 0.11))
    : 0.11;
  customTemplate.elements.push({
    id: `custom-c${Date.now()}`,
    type: 'circle',
    n: String(k),
    cx: norm.cx,
    cy: norm.cy,
    rx: r,
    ry: r,
  });
  selectedPosterTemplate = customTemplate;
  setCustomPlaceNext(false);
  canvas.discardActiveObject();
  refreshCustomTemplateOnCanvas(true);
  toast('已添加圆位；可继续「＋圆位」');
  return true;
}

function syncSlotsForTemplateChange(clearUrls: boolean) {
  const n = getCircleElements(selectedPosterTemplate).length;
  if (clearUrls) {
    slotUrls = new Array(n).fill(null);
    slotImageAdjustments = new Array(n).fill(null);
  } else {
    const next = new Array(n).fill(null);
    const nextAdj = new Array(n).fill(null);
    for (let i = 0; i < Math.min(n, slotUrls.length); i++) next[i] = slotUrls[i];
    for (let i = 0; i < Math.min(n, slotImageAdjustments.length); i++) nextAdj[i] = slotImageAdjustments[i];
    slotUrls = next;
    slotImageAdjustments = nextAdj;
  }
  currentSlot = Math.min(currentSlot, Math.max(0, n - 1));
  if (step === 2) rebuildSlotButtons();
}

function ensureSlotLen() {
  const n = getCircleElements(selectedPosterTemplate).length;
  while (slotUrls.length < n) slotUrls.push(null);
  slotUrls.length = n;
  while (slotImageAdjustments.length < n) slotImageAdjustments.push(null);
  slotImageAdjustments.length = n;
  currentSlot = Math.min(currentSlot, Math.max(0, n - 1));
}

function rebuildSlotButtons() {
  const row = el('slot-row');
  row.innerHTML = '';
  const circles = getCircleElements(selectedPosterTemplate);
  circles.forEach((ce, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot-btn' + (i === currentSlot ? ' active' : '');
    b.dataset.slot = String(i);
    b.textContent = `字${plainSlotLabel(ce.n, i)}`;
    row.appendChild(b);
  });
}

/** 清理画布顶层已脱出的 slot 字图，避免重建后残留 */
function clearTopLevelSlotImages() {
  slotFabricImages.forEach((im) => {
    if (im && canvas?.getObjects().includes(im)) canvas.remove(im);
  });
}

function createTemplateGroup(preserveTransform = false) {
  if (!canvas) return;
  if (templateGroup) unbindTemplateGroupLayoutSync();
  clearCustomSlotOverlaysFromCanvas();
  clearTopLevelSlotImages();
  slotFabricImages = [];
  const cw = canvas.width!;
  const ch = canvas.height!;
  let prev: { left: number; top: number; scaleX: number; scaleY: number; angle: number } | null = null;
  if (preserveTransform && templateGroup) {
    prev = {
      left: templateGroup.left!,
      top: templateGroup.top!,
      scaleX: templateGroup.scaleX!,
      scaleY: templateGroup.scaleY!,
      angle: templateGroup.angle!,
    };
    canvas.remove(templateGroup);
  } else if (templateGroup) {
    canvas.remove(templateGroup);
  }

  ensureSlotLen();
  const { cx, cy, gw, gh } = placementBoxPx(placement, cw, ch);
  const { frame, ellipses, labels } = buildPosterTemplateParts(selectedPosterTemplate, gw, gh);
  const parts: fabric.Object[] = [frame];
  if (selectedPosterTemplate.id !== 'custom') {
    for (let i = 0; i < ellipses.length; i++) {
      parts.push(ellipses[i]);
      if (labels[i]) parts.push(labels[i] as fabric.Object);
    }
  }
  const g = new fabric.Group(
    parts,
    fabricGroupOpts({
      left: prev ? prev.left : cx,
      top: prev ? prev.top : cy,
      scaleX: prev ? prev.scaleX : 1,
      scaleY: prev ? prev.scaleY : 1,
      angle: prev ? prev.angle : 0,
    })
  );
  g.setControlsVisibility({ mtr: true });
  canvas.add(g);
  templateGroup = g;
  if (selectedPosterTemplate.id === 'custom') {
    ellipses.forEach((slotGrp) => {
      canvas.add(slotGrp as fabric.Group);
      customSlotOverlayGroups.push(slotGrp as fabric.Group);
    });
    positionCustomSlotOverlaysFromData();
    bindTemplateGroupLayoutSync();
  }
  applyStepMode();
  canvas.renderAll();
}

function transparentPixel(): string {
  return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
}

function rebuildTemplateWithImages(cb?: () => void) {
  if (!templateGroup) {
    createTemplateGroup(false);
    rebuildTemplateWithImages(cb);
    return;
  }
  const { left, top, scaleX, scaleY, angle } = templateGroup;
  unbindTemplateGroupLayoutSync();
  clearCustomSlotOverlaysFromCanvas();
  clearTopLevelSlotImages();
  canvas.remove(templateGroup);

  const cw = canvas.width!;
  const ch = canvas.height!;
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const { frame, ellipses, labels, centers } = buildPosterTemplateParts(selectedPosterTemplate, gw, gh);
  ensureSlotLen();

  Promise.all(centers.map((c, i) => loadImageForSlot(slotUrls[i] ?? null, c, transparentPixel()))).then(
    (imgs) => {
      slotFabricImages = new Array(ellipses.length).fill(null);
      if (selectedPosterTemplate.id === 'custom') {
        customSlotOverlayGroups = [];
        const g = new fabric.Group([frame], fabricGroupOpts({ left, top, scaleX, scaleY, angle }));
        g.setControlsVisibility({ mtr: true });
        canvas.add(g);
        templateGroup = g;
        for (let i = 0; i < ellipses.length; i++) {
          const im = imgs[i];
          const slotGrp = ellipses[i] as fabric.Group;
          if (im) {
            configureSlotFabricImage(im, i);
            slotFabricImages[i] = im;
            canvas.add(im);
            const ix = im.scaleX ?? 1;
            const iy = im.scaleY ?? 1;
            const ext = im as fabric.Image & {
              __baseFitScX?: number;
              __baseFitScY?: number;
              __intrinsicFitScX?: number;
              __intrinsicFitScY?: number;
            };
            ext.__intrinsicFitScX = ix;
            ext.__intrinsicFitScY = iy;
            ext.__baseFitScX = ix;
            ext.__baseFitScY = iy;
          }
          canvas.add(slotGrp);
          customSlotOverlayGroups.push(slotGrp);
        }
        positionCustomSlotOverlaysFromData();
        bindTemplateGroupLayoutSync();
        applyStepMode();
        canvas.renderAll();
        cb?.();
        return;
      }
      const objs: fabric.Object[] = [frame];
      for (let i = 0; i < ellipses.length; i++) {
        const im = imgs[i];
        if (im) {
          configureSlotFabricImage(im, i);
          const ix = im.scaleX ?? 1;
          const iy = im.scaleY ?? 1;
          const imRef = im as fabric.Image & { __intrinsicFitScX?: number; __intrinsicFitScY?: number };
          imRef.__intrinsicFitScX = ix;
          imRef.__intrinsicFitScY = iy;
          const adj = slotImageAdjustments[i];
          if (adj) {
            im.set({
              left: centers[i].x + adj.offLX,
              top: centers[i].y + adj.offLY,
              scaleX: ix * adj.scaleMul,
              scaleY: iy * (adj.scaleMulY ?? adj.scaleMul),
              angle: adj.angle ?? 0,
            });
          }
          slotFabricImages[i] = im;
          objs.push(im);
        }
        objs.push(ellipses[i]);
        if (labels[i]) objs.push(labels[i] as fabric.Object);
      }
      const g = new fabric.Group(objs, fabricGroupOpts({ left, top, scaleX, scaleY, angle }));
      g.setControlsVisibility({ mtr: true });
      canvas.add(g);
      templateGroup = g;
      applyStepMode();
      canvas.renderAll();
      cb?.();
    }
  );
}

/* ---------- 邪修弹层 ---------- */
const srcBuf = document.createElement('canvas');
srcBuf.width = SRC;
srcBuf.height = SRC;
const srcCtx = srcBuf.getContext('2d')!;

function openWarpModal() {
  const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
  warpState.corners = defaultCorners();
  warpState.vx = 0.5;
  warpState.hy = 0.5;
  alignSlidersToState();
  renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
  paintWarpPreview();
  el('warp-modal').classList.remove('hidden');
  if (document.fonts && document.fonts.ready) {
    void document.fonts.ready.then(() => {
      if (el('warp-modal').classList.contains('hidden')) return;
      const ch2 = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
      renderSourceText(srcCtx, ch2, getSelectedWarpFont(), SRC);
      paintWarpPreview();
    });
  }
}

function closeWarpModal() {
  el('warp-modal').classList.add('hidden');
}

function paintWarpPreview() {
  const c = el('warp-out') as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  renderWarped(ctx, srcBuf, warpState.corners, warpState.vx, warpState.hy, c.width, c.height);
  syncWarpOverlayFromState(warpState);
}

function readWarpSliders() {
  warpState.vx = Number((el('warp-vx') as HTMLInputElement).value) / 100;
  warpState.hy = Number((el('warp-hy') as HTMLInputElement).value) / 100;
  warpState.vx = Math.min(AXIS_HI, Math.max(AXIS_LO, warpState.vx));
  warpState.hy = Math.min(AXIS_HI, Math.max(AXIS_LO, warpState.hy));
}

function confirmWarp() {
  const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
  renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
  readWarpSliders();
  const out = document.createElement('canvas');
  out.width = 512;
  out.height = 512;
  renderWarped(out.getContext('2d')!, srcBuf, warpState.corners, warpState.vx, warpState.hy, 512, 512);
  const url = out.toDataURL('image/png');
  slotUrls[currentSlot] = url;
  ensureSlotLen();
  slotImageAdjustments[currentSlot] = null;
  const circles = getCircleElements(selectedPosterTemplate);
  const lab = plainSlotLabel(circles[currentSlot]?.n, currentSlot);
  rebuildTemplateWithImages(() => {
    toast(`字${lab} 已更新`);
    closeWarpModal();
  });
}

/* ---------- 笔刷 ---------- */
let brushColor = '#1a1a1a';
let brushSize = 4;
let brushKind: BrushId = 'pen';

const textBrushState = {
  pattern: '字墨花风',
  font: `'Noto Serif SC', 'STSong', serif`,
  sizeMul: 1.35,
  gapMul: 1.1,
  randomAngle: 0.15,
  randomScale: 0.15,
};
const inkBrushState = {
  pressureEnabled: true,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.55,
};
const waveBrushState = { amp: 0.45 };
const meshBrushState = { density: 1 };
const roughBrushState = { jitter: 1 };

function brushRuntimeOptions(): BrushRuntimeOptions {
  return {
    textPattern: textBrushState.pattern,
    textFont: textBrushState.font,
    textSizeMul: textBrushState.sizeMul,
    textGapMul: textBrushState.gapMul,
    textRandomAngle: textBrushState.randomAngle,
    textRandomScale: textBrushState.randomScale,
    inkPressureEnabled: inkBrushState.pressureEnabled,
    inkThinning: inkBrushState.thinning,
    inkSmoothing: inkBrushState.smoothing,
    inkStreamline: inkBrushState.streamline,
    waveAmp: waveBrushState.amp,
    meshDensity: meshBrushState.density,
    roughJitter: roughBrushState.jitter,
  };
}

function updateBrush() {
  applyBrush(fabric, canvas, brushKind, brushColor, brushSize, brushRuntimeOptions());
}

/* ---------- 「笔画」模式：选中笔画即时改色 / 粗细 / 效果 ---------- */
function isHollowGroup(o: fabric.Object): boolean {
  return !!(o as fabric.Object & { isHollow?: boolean }).isHollow;
}

function applyColorToOne(o: fabric.Object, color: string) {
  const paintGroupChildren = (g: fabric.Group) => {
    (g._objects || []).forEach((sub) => {
      if ((sub as fabric.Path).stroke != null) sub.set({ stroke: color });
      if (sub.type === 'text' || (sub as fabric.Text).text != null) sub.set({ fill: color });
    });
  };
  if (isHollowGroup(o)) {
    const sub = (o as fabric.Group)._objects?.[0];
    if (sub) sub.set({ stroke: color });
    return;
  }
  if ((o as fabric.Group)._objects) {
    paintGroupChildren(o as fabric.Group);
    return;
  }
  const cur = (o as fabric.Path).stroke;
  if (cur && typeof cur === 'object') {
    /** 铅笔 / 粉笔 用噪点 pattern：换色就要重新生成 pattern */
    o.set({ stroke: createNoisePattern(fabric, color) });
  } else {
    o.set({ stroke: color });
  }
  /** 发光效果的 shadow 颜色跟着 stroke */
  if ((o as fabric.Object & { customEffect?: string }).customEffect === 'neon') {
    o.set({ shadow: new fabric.Shadow({ color, blur: 14, offsetX: 0, offsetY: 0 }) });
  }
}
function applyColorToSelected(color: string) {
  const objs = canvas.getActiveObjects();
  if (!objs.length) return;
  objs.forEach((o) => applyColorToOne(o, color));
  canvas.requestRenderAll();
}

function applyWidthToOne(o: fabric.Object, w: number) {
  const scaleGroupWidths = (g: fabric.Group) => {
    (g._objects || []).forEach((sub) => {
      if ((sub as fabric.Path).strokeWidth != null) {
        const sw = (sub as fabric.Path).strokeWidth || w;
        const mul = sw > 0 ? sw / Math.max(1, brushSize) : 1;
        sub.set({ strokeWidth: Math.max(1, w * mul) });
      }
    });
  };
  if (isHollowGroup(o)) {
    const subs = (o as fabric.Group)._objects;
    if (subs && subs.length >= 2) {
      const outerW = w * 2.2;
      subs[0].set({ strokeWidth: outerW });
      subs[1].set({ strokeWidth: outerW * 0.55 });
    }
    return;
  }
  if ((o as fabric.Group)._objects) {
    scaleGroupWidths(o as fabric.Group);
    return;
  }
  o.set({ strokeWidth: w });
}
function applyWidthToSelected(w: number) {
  const objs = canvas.getActiveObjects();
  if (!objs.length) return;
  objs.forEach((o) => applyWidthToOne(o, w));
  canvas.requestRenderAll();
}

function applyEffectToOne(o: fabric.Object, eff: 'none' | 'neon' | 'emboss' | 'knockout') {
  (o as fabric.Object & { customEffect?: string }).customEffect = eff;
  if (eff === 'none') {
    o.set({ globalCompositeOperation: 'source-over', shadow: null });
  } else if (eff === 'knockout') {
    o.set({ globalCompositeOperation: 'destination-out', shadow: null });
  } else if (eff === 'neon') {
    let c: string;
    if (isHollowGroup(o)) {
      const s = (o as fabric.Group)._objects?.[0]?.stroke;
      c = typeof s === 'string' ? s : '#fff';
    } else {
      const s = (o as fabric.Path).stroke;
      c = typeof s === 'string' ? s : '#fff';
    }
    o.set({
      globalCompositeOperation: 'source-over',
      shadow: new fabric.Shadow({ color: c, blur: 14, offsetX: 0, offsetY: 0 }),
    });
  } else if (eff === 'emboss') {
    o.set({
      globalCompositeOperation: 'source-over',
      shadow: new fabric.Shadow({ color: 'rgba(0,0,0,0.5)', blur: 2, offsetX: 3, offsetY: 3 }),
    });
  }
}
function applyEffectToSelected(eff: 'none' | 'neon' | 'emboss' | 'knockout') {
  const objs = canvas.getActiveObjects();
  if (!objs.length) return;
  objs.forEach((o) => applyEffectToOne(o, eff));
  canvas.requestRenderAll();
}

function syncEffectRowVisibility() {
  el('effect-row').classList.toggle('hidden', !(step === 3 && pathEditMode));
}

function syncEffectRowState() {
  syncEffectRowVisibility();
  const a = canvas.getActiveObject();
  const cur = a ? (a as fabric.Object & { customEffect?: string }).customEffect || 'none' : 'none';
  document.querySelectorAll('#effect-row .effect-btn').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.effect === cur);
  });
}

function updateTraceBrush() {
  if (!traceCanvas) return;
  applyBrush(fabric, traceCanvas, brushKind, brushColor, brushSize, brushRuntimeOptions());
}

const BRUSH_ICONS: Record<string, string> = {
  pen: '✒',
  pencil: '✏',
  jitter: '〰',
  chalk: '🖌',
  hollow: '◌',
  soft: '◉',
  ink: '🖋',
  dashpen: '┄',
  wave: '∿',
  roughpen: '✒',
  text: '字',
  mesh: '※',
};

function brushIcon(id: string): string {
  return BRUSH_ICONS[id] || '✒';
}

function brushDef(id: string) {
  return BRUSHES.find((b) => b.id === id) || BRUSHES[0];
}

function refreshBrushButton() {
  const def = brushDef(brushKind);
  const btn = el('btn-open-brush-modal') as HTMLButtonElement | null;
  if (!btn) return;
  const icon = el('brush-current-icon');
  const label = el('brush-current-label');
  if (icon) icon.textContent = brushIcon(def.id);
  if (label) label.textContent = def.short || def.label;
}

function setBrushKind(id: BrushId) {
  brushKind = id;
  refreshBrushButton();
  updateBrush();
  updateTraceBrush();
  /** 「笔画」模式且有选中：把选中笔画整体改成新笔刷的样子（重建 path） */
  if (step === 3 && pathEditMode) {
    const objs = canvas.getActiveObjects();
    if (!objs.length) return;
    const made: fabric.Object[] = [];
    objs.forEach((o) => {
      const n = rebrushOne(o, id, brushColor, brushSize);
      if (n) made.push(n);
    });
    canvas.discardActiveObject();
    if (made.length === 1) canvas.setActiveObject(made[0]);
    else if (made.length > 1) {
      const sel = new fabric.ActiveSelection(made, { canvas });
      canvas.setActiveObject(sel);
    }
    canvas.requestRenderAll();
    syncEffectRowState();
  }
}

/* ---------- 笔刷选择 + 参数抽屉 ---------- */
type ParamDef =
  | { kind: 'range'; key: string; label: string; min: number; max: number; step: number; get: () => number; set: (v: number) => void }
  | { kind: 'text'; key: string; label: string; max: number; get: () => string; set: (v: string) => void }
  | { kind: 'select'; key: string; label: string; options: { v: string; t: string }[]; get: () => string; set: (v: string) => void };

function brushParams(id: BrushId): ParamDef[] {
  if (id === 'ink') {
    return [
      {
        kind: 'select',
        key: 'pressure',
        label: '压感',
        options: [
          { v: 'on', t: '开（速度模拟 + 触控笔压感）' },
          { v: 'off', t: '关（恒定粗细）' },
        ],
        get: () => (inkBrushState.pressureEnabled ? 'on' : 'off'),
        set: (v) => {
          inkBrushState.pressureEnabled = v === 'on';
        },
      },
      { kind: 'range', key: 'thinning', label: '细化', min: -0.4, max: 0.95, step: 0.05, get: () => inkBrushState.thinning, set: (v) => (inkBrushState.thinning = v) },
      { kind: 'range', key: 'smoothing', label: '平滑', min: 0, max: 1, step: 0.05, get: () => inkBrushState.smoothing, set: (v) => (inkBrushState.smoothing = v) },
      { kind: 'range', key: 'streamline', label: '抖动滤除', min: 0, max: 0.95, step: 0.05, get: () => inkBrushState.streamline, set: (v) => (inkBrushState.streamline = v) },
    ];
  }
  if (id === 'text') {
    return [
      { kind: 'text', key: 'pattern', label: '文字内容', max: 24, get: () => textBrushState.pattern, set: (v) => (textBrushState.pattern = v || '字') },
      {
        kind: 'select',
        key: 'font',
        label: '字体',
        options: [
          { v: `'Noto Serif SC', 'STSong', serif`, t: '思源宋（默认）' },
          { v: `'Noto Sans SC', system-ui, sans-serif`, t: '思源黑' },
          { v: `'KaiTi', '楷体', serif`, t: '楷体' },
          { v: `'STKaiti', '楷体', serif`, t: '华文楷体' },
          { v: `'STFangsong', '仿宋', serif`, t: '仿宋' },
          { v: `'Ma Shan Zheng', 'KaiTi', cursive`, t: '马善政体（手写）' },
        ],
        get: () => textBrushState.font,
        set: (v) => (textBrushState.font = v),
      },
      { kind: 'range', key: 'sizeMul', label: '字号倍率', min: 0.6, max: 2.4, step: 0.05, get: () => textBrushState.sizeMul, set: (v) => (textBrushState.sizeMul = v) },
      { kind: 'range', key: 'gapMul', label: '间距倍率', min: 0.4, max: 3, step: 0.05, get: () => textBrushState.gapMul, set: (v) => (textBrushState.gapMul = v) },
      { kind: 'range', key: 'randAng', label: '角度随机', min: 0, max: 1, step: 0.02, get: () => textBrushState.randomAngle, set: (v) => (textBrushState.randomAngle = v) },
      { kind: 'range', key: 'randSc', label: '大小随机', min: 0, max: 1, step: 0.02, get: () => textBrushState.randomScale, set: (v) => (textBrushState.randomScale = v) },
    ];
  }
  if (id === 'wave') {
    return [{ kind: 'range', key: 'amp', label: '振幅', min: 0.1, max: 2, step: 0.05, get: () => waveBrushState.amp, set: (v) => (waveBrushState.amp = v) }];
  }
  if (id === 'mesh') {
    return [{ kind: 'range', key: 'density', label: '密度', min: 0.3, max: 2, step: 0.05, get: () => meshBrushState.density, set: (v) => (meshBrushState.density = v) }];
  }
  if (id === 'roughpen') {
    return [{ kind: 'range', key: 'jitter', label: '抖动幅度', min: 0.3, max: 4, step: 0.1, get: () => roughBrushState.jitter, set: (v) => (roughBrushState.jitter = v) }];
  }
  return [];
}

let brushModalDraft: BrushId = 'pen';

function renderBrushParams(id: BrushId) {
  const host = el('brush-params');
  if (!host) return;
  host.innerHTML = '';
  const defs = brushParams(id);
  if (!defs.length) {
    const empty = document.createElement('div');
    empty.className = 'param-empty';
    empty.textContent = '此笔刷无额外参数';
    host.appendChild(empty);
    return;
  }
  defs.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = d.label;
    row.appendChild(label);
    if (d.kind === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      input.value = String(d.get());
      const val = document.createElement('span');
      val.style.minWidth = '32px';
      val.style.textAlign = 'right';
      val.style.fontSize = '12px';
      val.style.color = 'var(--muted)';
      val.textContent = Number(input.value).toFixed(2);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        d.set(v);
        val.textContent = v.toFixed(2);
        if (id === brushKind) {
          updateBrush();
          updateTraceBrush();
        }
      });
      row.appendChild(input);
      row.appendChild(val);
    } else if (d.kind === 'text') {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = d.max;
      input.value = d.get();
      input.addEventListener('input', () => {
        d.set(input.value);
        if (id === brushKind) {
          updateBrush();
          updateTraceBrush();
        }
      });
      row.appendChild(input);
    } else if (d.kind === 'select') {
      const sel = document.createElement('select');
      d.options.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o.v;
        opt.textContent = o.t;
        if (o.v === d.get()) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', () => {
        d.set(sel.value);
        if (id === brushKind) {
          updateBrush();
          updateTraceBrush();
        }
      });
      row.appendChild(sel);
    }
    host.appendChild(row);
  });
}

function renderBrushGrid() {
  const host = el('brush-grid');
  if (!host) return;
  host.innerHTML = '';
  BRUSHES.forEach((b) => {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'brush-tile' + (b.id === brushModalDraft ? ' active' : '');
    tile.dataset.brush = b.id;
    const icon = document.createElement('span');
    icon.className = 'brush-tile-icon';
    icon.textContent = brushIcon(b.id);
    const label = document.createElement('span');
    label.textContent = b.short || b.label;
    tile.appendChild(icon);
    tile.appendChild(label);
    tile.addEventListener('click', () => {
      brushModalDraft = b.id as BrushId;
      Array.from(host.children).forEach((c) => c.classList.remove('active'));
      tile.classList.add('active');
      renderBrushParams(brushModalDraft);
    });
    host.appendChild(tile);
  });
}

function openBrushModal() {
  brushModalDraft = brushKind;
  renderBrushGrid();
  renderBrushParams(brushModalDraft);
  el('brush-modal').classList.remove('hidden');
}

function closeBrushModal() {
  el('brush-modal').classList.add('hidden');
}

function setupBrushModal() {
  el('btn-open-brush-modal').addEventListener('click', openBrushModal);
  el('brush-modal-close').addEventListener('click', closeBrushModal);
  el('brush-modal-ok').addEventListener('click', () => {
    setBrushKind(brushModalDraft);
    closeBrushModal();
  });
  el('brush-modal').addEventListener('click', (e) => {
    if (e.target === el('brush-modal')) closeBrushModal();
  });
}

/** 提取 path data（支持 hollow group 与普通 path），深拷贝防破坏 */
function extractPathData(o: fabric.Object): unknown[] | null {
  const src = isHollowGroup(o)
    ? ((o as fabric.Group)._objects?.[0] as fabric.Path | undefined)?.path
    : (o as fabric.Path).path;
  if (!Array.isArray(src)) return null;
  return src.map((c) => (Array.isArray(c) ? [...c] : c));
}

/** 把现有笔画整体改成 brushId 对应的笔刷外观 / 形态。保留位置与变换。 */
function rebrushOne(
  o: fabric.Object,
  brushId: BrushId,
  color: string,
  baseW: number
): fabric.Object | null {
  const data = extractPathData(o);
  if (!data) return null;

  const transform = {
    left: o.left,
    top: o.top,
    scaleX: o.scaleX,
    scaleY: o.scaleY,
    angle: o.angle,
    originX: o.originX,
    originY: o.originY,
    selectable: o.selectable,
    evented: true,
    strokeUniform: true,
  };
  const meta = {
    customEffect: (o as fabric.Object & { customEffect?: string }).customEffect,
    __slotIndex: (o as fabric.Object & { __slotIndex?: number }).__slotIndex,
  };

  const widthMul: Record<string, number> = {
    pen: 1,
    pencil: 1.35,
    jitter: 1.5,
    chalk: 2.2,
    hollow: 2.2,
    soft: 1.2,
    ink: 1.35,
    dashpen: 1.1,
    wave: 1.05,
    roughpen: 1.15,
    text: 1.1,
    mesh: 0.95,
  };
  const sw = baseW * (widthMul[brushId] ?? 1);
  const usePattern = brushId === 'pencil' || brushId === 'chalk';
  const stroke = usePattern ? createNoisePattern(fabric, color) : color;

  let next: fabric.Object;
  const mkPath = (d: unknown[], extra: Record<string, unknown> = {}) =>
    new fabric.Path(d as never, {
      fill: null,
      stroke,
      strokeWidth: sw,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      ...extra,
    });
  const toPts = (d: Array<Array<string | number>>) => {
    const pts: Array<{ x: number; y: number }> = [];
    d.forEach((cmd) => {
      if (cmd[0] === 'M' || cmd[0] === 'L') pts.push({ x: Number(cmd[1]) || 0, y: Number(cmd[2]) || 0 });
      else if (cmd[0] === 'Q') pts.push({ x: Number(cmd[3]) || 0, y: Number(cmd[4]) || 0 });
      else if (cmd[0] === 'C') pts.push({ x: Number(cmd[5]) || 0, y: Number(cmd[6]) || 0 });
    });
    return pts;
  };
  const jittered = (d: Array<Array<string | number>>, amp: number) =>
    d.map((cmd) => {
      const c = [...cmd];
      if (c[0] === 'Q') {
        c[1] = (c[1] as number) + (Math.random() - 0.5) * amp;
        c[2] = (c[2] as number) + (Math.random() - 0.5) * amp;
        c[3] = (c[3] as number) + (Math.random() - 0.5) * amp;
        c[4] = (c[4] as number) + (Math.random() - 0.5) * amp;
      } else if (c[0] === 'L' || c[0] === 'M') {
        c[1] = (c[1] as number) + (Math.random() - 0.5) * amp;
        c[2] = (c[2] as number) + (Math.random() - 0.5) * amp;
      } else if (c[0] === 'C') {
        for (let i = 1; i <= 6; i++) c[i] = (c[i] as number) + (Math.random() - 0.5) * amp;
      }
      return c;
    });
  if (brushId === 'jitter') {
    const d = data as Array<Array<string | number>>;
    for (const cmd of d) {
      if (cmd[0] === 'Q') {
        cmd[1] = (cmd[1] as number) + (Math.random() - 0.5) * 5;
        cmd[2] = (cmd[2] as number) + (Math.random() - 0.5) * 5;
        cmd[3] = (cmd[3] as number) + (Math.random() - 0.5) * 5;
        cmd[4] = (cmd[4] as number) + (Math.random() - 0.5) * 5;
      } else if (cmd[0] === 'L') {
        cmd[1] = (cmd[1] as number) + (Math.random() - 0.5) * 5;
        cmd[2] = (cmd[2] as number) + (Math.random() - 0.5) * 5;
      }
    }
    next = mkPath(d as unknown[]);
  } else if (brushId === 'wave') {
    const d = data as Array<Array<string | number>>;
    const w = d.map((cmd, idx) => {
      const c = [...cmd];
      const shift = Math.sin(idx * 0.8) * (sw * 0.45);
      if (c[0] === 'Q') {
        c[2] = (c[2] as number) + shift;
        c[4] = (c[4] as number) + shift;
      } else if (c[0] === 'L' || c[0] === 'M') {
        c[2] = (c[2] as number) + shift;
      } else if (c[0] === 'C') {
        c[2] = (c[2] as number) + shift;
        c[4] = (c[4] as number) + shift;
        c[6] = (c[6] as number) + shift;
      }
      return c;
    });
    next = mkPath(w as unknown[]);
  } else if (brushId === 'dashpen') {
    next = mkPath(data, { strokeDashArray: [sw * 1.8, sw * 1.2] });
  } else if (brushId === 'roughpen') {
    const d = data as Array<Array<string | number>>;
    const p1 = mkPath(jittered(d, 2.8) as unknown[], { opacity: 0.95, strokeUniform: true });
    const p2 = mkPath(jittered(d, 4.3) as unknown[], {
      opacity: 0.4,
      strokeWidth: sw * 0.7,
      strokeUniform: true,
    });
    next = new fabric.Group([p1, p2], { isRough: true, strokeUniform: true });
  } else if (brushId === 'ink') {
    const d = data as Array<Array<string | number>>;
    const base = mkPath(d as unknown[], { stroke: color, strokeWidth: sw * 0.95, strokeUniform: true });
    const bloom = mkPath(d as unknown[], {
      stroke: color,
      opacity: 0.32,
      strokeWidth: sw * 1.7,
      strokeUniform: true,
      shadow: new fabric.Shadow({ color, blur: 2, offsetX: 0, offsetY: 0 }),
    });
    const pts = toPts(d);
    const dots: fabric.Object[] = [];
    if (pts[0]) {
      dots.push(
        new fabric.Circle({
          left: pts[0].x,
          top: pts[0].y,
          originX: 'center',
          originY: 'center',
          radius: Math.max(1, sw * 0.36),
          fill: color,
          opacity: 0.85,
        }),
      );
    }
    if (pts[pts.length - 1]) {
      dots.push(
        new fabric.Circle({
          left: pts[pts.length - 1].x,
          top: pts[pts.length - 1].y,
          originX: 'center',
          originY: 'center',
          radius: Math.max(1, sw * 0.42),
          fill: color,
          opacity: 0.9,
        }),
      );
    }
    next = new fabric.Group([bloom, base, ...dots], { isInk: true, strokeUniform: true });
  } else if (brushId === 'text') {
    const pts = toPts(data as Array<Array<string | number>>);
    const pattern = (textBrushState.pattern || '字墨花风').replace(/\s+/g, '');
    const chars = [...pattern];
    if (!chars.length) chars.push('字');
    const step = Math.max(2, Math.floor(sw * 1.1));
    const glyphs: fabric.Object[] = [];
    for (let i = 0; i < pts.length; i += step) {
      const cur = pts[i];
      const nxt = pts[Math.min(pts.length - 1, i + 1)] || cur;
      const ang = (Math.atan2(nxt.y - cur.y, nxt.x - cur.x) * 180) / Math.PI;
      glyphs.push(
        new fabric.Text(chars[Math.floor(i / step) % chars.length], {
          left: cur.x,
          top: cur.y,
          angle: ang,
          originX: 'center',
          originY: 'center',
          fontSize: Math.max(10, sw * 1.35),
          fill: color,
          fontFamily: `'Noto Serif SC', 'STSong', serif`,
          opacity: 0.9,
        }),
      );
    }
    next = new fabric.Group(glyphs, { isTextBrush: true, strokeUniform: true });
  } else if (brushId === 'mesh') {
    const d = data as Array<Array<string | number>>;
    const pts = toPts(d);
    const lines: fabric.Object[] = [];
    for (let i = 0; i + 3 < pts.length; i += 3) {
      const a = pts[i];
      const b = pts[Math.min(pts.length - 1, i + 3)];
      lines.push(
        new fabric.Line([a.x, a.y, b.x, b.y], {
          stroke: color,
          strokeWidth: Math.max(1, sw * 0.38),
          opacity: 0.45,
        }),
      );
      if (i + 6 < pts.length) {
        const c = pts[i + 6];
        lines.push(
          new fabric.Line([a.x, a.y, c.x, c.y], {
            stroke: color,
            strokeWidth: Math.max(1, sw * 0.3),
            opacity: 0.32,
          }),
        );
      }
    }
    const base = mkPath(d as unknown[], { stroke: color, strokeWidth: sw * 0.7, opacity: 0.88, strokeUniform: true });
    next = new fabric.Group([base, ...lines], { isMesh: true, strokeUniform: true });
  } else if (brushId === 'hollow') {
    const outer = new fabric.Path(data as never, {
      fill: null,
      stroke: color,
      strokeWidth: sw,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
    });
    const inner = new fabric.Path(data as never, {
      fill: null,
      stroke: '#f4f1ea',
      strokeWidth: sw * 0.55,
      strokeLineCap: 'round',
      strokeLineJoin: 'round',
      strokeUniform: true,
      globalCompositeOperation: 'destination-out',
    });
    next = new fabric.Group([outer, inner], { isHollow: true, strokeUniform: true });
  } else {
    next = mkPath(data);
    if (brushId === 'pencil' || brushId === 'chalk') (next as fabric.Path).set({ opacity: 0.88 });
    if (brushId === 'soft')
      (next as fabric.Path).set({
        shadow: new fabric.Shadow({ color, blur: 3, offsetX: 0, offsetY: 0 }),
      });
  }

  next.set(transform);
  if ((next as fabric.Group)._objects) {
    (next as fabric.Group)._objects.forEach((sub: fabric.Object) =>
      sub.set({ strokeUniform: true })
    );
  }
  Object.assign(next, meta);

  const idx = drawHistory.indexOf(o);
  canvas.remove(o);
  canvas.add(next);
  if (idx >= 0) drawHistory[idx] = next;
  if (meta.customEffect && meta.customEffect !== 'none') {
    applyEffectToOne(next, meta.customEffect as 'none' | 'neon' | 'emboss' | 'knockout');
  }
  return next;
}

type ReplayFx = 'dash' | 'drop' | 'shake' | 'squash' | 'erase';

function dashAnimateObject(obj: fabric.Object, dur: number): Promise<void> {
  return new Promise((resolve) => {
    obj.set({ opacity: 1 });
    const g = obj as fabric.Group & { isHollow?: boolean };
    if (g.isHollow && g._objects && g._objects[0]) {
      const sub = g._objects[0] as fabric.Path;
      const len = 5000;
      sub.set({ strokeDashArray: [len, len], strokeDashOffset: len });
      sub.animate(
        { strokeDashOffset: 0 },
        {
          duration: dur,
          easing: fabric.util.ease.easeOutSine,
          onChange: () => canvas.renderAll(),
          onComplete: () => {
            sub.set({ strokeDashArray: null, strokeDashOffset: 0 });
            canvas.renderAll();
            resolve();
          },
        }
      );
      return;
    }
    if (obj.type !== 'path') {
      resolve();
      return;
    }
    const p = obj as fabric.Path;
    const len = 5000;
    p.set({ strokeDashArray: [len, len], strokeDashOffset: len });
    p.animate(
      { strokeDashOffset: 0 },
      {
        duration: dur,
        easing: fabric.util.ease.easeOutSine,
        onChange: () => canvas.renderAll(),
        onComplete: () => {
          p.set({ strokeDashArray: null, strokeDashOffset: 0 });
          canvas.renderAll();
          resolve();
        },
      }
    );
  });
}

function dropAnimateObject(obj: fabric.Object, dur: number): Promise<void> {
  return new Promise((resolve) => {
    const top0 = obj.top ?? 0;
    const sx = obj.scaleX || 1;
    const sy = obj.scaleY || 1;
    obj.set({ opacity: 0, top: top0 - 36, scaleX: sx * 0.9, scaleY: sy * 0.9 });
    obj.animate('opacity', 1, { duration: Math.floor(dur * 0.5), onChange: () => canvas.renderAll() });
    obj.animate('top', top0, {
      duration: dur,
      easing: fabric.util.ease.easeOutBack,
      onChange: () => canvas.renderAll(),
    });
    obj.animate('scaleX', sx, { duration: dur, easing: fabric.util.ease.easeOutBack });
    obj.animate('scaleY', sy, {
      duration: dur,
      easing: fabric.util.ease.easeOutBack,
      onChange: () => canvas.renderAll(),
      onComplete: () => resolve(),
    });
  });
}

/** 回放「抖动」：抽帧感 + 非匀速混频位移，略带头尾粗细/旋转微变，避免单一水平正弦摆 */
function shakeAnimateObject(obj: fabric.Object, dur: number): Promise<void> {
  return new Promise((resolve) => {
    const left0 = obj.left ?? 0;
    const top0 = obj.top ?? 0;
    const ang0 = obj.angle ?? 0;
    const sx0 = obj.scaleX ?? 1;
    const sy0 = obj.scaleY ?? 1;
    const amp = Math.max(2.5, Math.min(9, (obj.strokeWidth as number) || 5));
    const seed = ((left0 + top0 * 1.7) % 997) * 0.01;
    const ph = [seed * 6.2, seed * 4.1 + 0.7, seed * 8.9 + 0.3];
    /** 阶梯时间：像逐帧重描，又保留整体淡出包络 */
    const holdSteps = Math.max(10, Math.min(22, Math.floor(dur / 55)));
    const pathLike = obj.type === 'path';
    const sw0 = pathLike ? (obj as fabric.Path).strokeWidth ?? 1 : 1;

    obj.set({ opacity: 0 });
    obj.animate('opacity', 1, { duration: 110, onChange: () => canvas.renderAll() });
    fabric.util.animate({
      startValue: 0,
      endValue: 1,
      duration: dur,
      easing: fabric.util.ease.easeOutCubic,
      onChange: (t: number) => {
        const decay = Math.pow(1 - t, 0.82);
        const denom = Math.max(1, holdSteps - 1);
        const k = holdSteps > 1 ? Math.floor(t * holdSteps) / denom : t;
        const a = Math.sin(k * 11.7 * Math.PI + ph[0]) * 0.42;
        const b = Math.sin(k * 18.4 * Math.PI + ph[1]) * 0.38;
        const c = Math.cos(k * 7.9 * Math.PI * 2 + ph[2]) * 0.2;
        const jx = (a + b + c) * amp * decay;
        const d = Math.cos(k * 13.2 * Math.PI + ph[0] * 0.5) * 0.48;
        const e = Math.sin(k * 16.8 * Math.PI + ph[2]) * 0.52;
        const jy = (d + e) * amp * 0.62 * decay;
        const rot =
          (Math.sin(k * 21.3 * Math.PI + ph[1]) * 0.55 + Math.cos(k * 9.6 * Math.PI + ph[0]) * 0.45) *
          decay *
          2.8;
        const breathe =
          1 +
          (Math.sin(k * 29 * Math.PI + seed) * 0.008 + Math.cos(k * 17 * Math.PI + ph[2]) * 0.005) *
            decay;
        obj.set({
          left: left0 + jx,
          top: top0 + jy,
          angle: ang0 + rot,
          scaleX: sx0 * breathe,
          scaleY: sy0 * (2 - breathe),
        });
        if (pathLike) {
          const swPulse =
            1 + (Math.sin(k * 26 * Math.PI + ph[2]) * 0.045 + Math.cos(k * 33 * Math.PI) * 0.025) * decay;
          (obj as fabric.Path).set({ strokeWidth: sw0 * swPulse });
        }
        canvas.renderAll();
      },
      onComplete: () => {
        obj.set({ left: left0, top: top0, angle: ang0, scaleX: sx0, scaleY: sy0 });
        if (pathLike) {
          (obj as fabric.Path).set({ strokeWidth: sw0 });
        }
        canvas.renderAll();
        resolve();
      },
    });
  });
}

/** 全体可读作「压扁再弹起」：纵向压扁 + 略横向拉伸，再回弹，并带轻微横向余抖 */
function squashAnimateObject(obj: fabric.Object, dur: number): Promise<void> {
  return new Promise((resolve) => {
    const sx0 = obj.scaleX || 1;
    const sy0 = obj.scaleY || 1;
    const left0 = obj.left ?? 0;
    const amp = Math.max(2, Math.min(8, (obj.strokeWidth as number) || 5));
    obj.set({ opacity: 0, scaleX: sx0 * 1.12, scaleY: sy0 * 0.46, left: left0 });
    const opDur = Math.max(90, Math.floor(dur * 0.18));
    obj.animate('opacity', 1, { duration: opDur, onChange: () => canvas.renderAll() });
    obj.animate('scaleX', sx0, {
      duration: dur,
      easing: fabric.util.ease.easeOutBack,
      onChange: () => canvas.renderAll(),
    });
    obj.animate('scaleY', sy0, {
      duration: dur,
      easing: fabric.util.ease.easeOutBack,
      onChange: () => canvas.renderAll(),
    });
    fabric.util.animate({
      startValue: 0,
      endValue: 1,
      duration: dur,
      easing: fabric.util.ease.easeOutSine,
      onChange: (t: number) => {
        const decay = 1 - t;
        obj.set({ left: left0 + Math.sin(t * 18 * Math.PI) * amp * decay * 0.9 });
        canvas.renderAll();
      },
      onComplete: () => {
        obj.set({ left: left0, scaleX: sx0, scaleY: sy0 });
        canvas.renderAll();
        resolve();
      },
    });
  });
}

function eraseInAnimateObject(obj: fabric.Object, dur: number): Promise<void> {
  return new Promise((resolve) => {
    const b = obj.getBoundingRect(true, true);
    const clip = new fabric.Rect({
      left: b.left,
      top: b.top,
      width: 0.5,
      height: b.height + 2,
      absolutePositioned: true,
      originX: 'left',
      originY: 'top',
    });
    obj.set({ opacity: 1, clipPath: clip });
    clip.animate('width', b.width + 2, {
      duration: dur,
      easing: fabric.util.ease.easeOutSine,
      onChange: () => canvas.renderAll(),
      onComplete: () => {
        obj.set({ clipPath: undefined });
        canvas.renderAll();
        resolve();
      },
    });
  });
}

function animateObjectByFx(obj: fabric.Object, dur: number, fx: ReplayFx): Promise<void> {
  if (fx === 'drop') return dropAnimateObject(obj, dur);
  if (fx === 'shake') return shakeAnimateObject(obj, dur);
  if (fx === 'squash') return squashAnimateObject(obj, dur);
  if (fx === 'erase') return eraseInAnimateObject(obj, dur);
  return dashAnimateObject(obj, dur);
}

/** Live Photo 风格：整段约 3 秒；按笔画/按字均分。stroke/char 模式下用 dash 动画。 */
const LIVE_TARGET_MS = 3200;

function playbackModeFromReplay(replay: string): 'stroke' | 'char' | 'char-sync' {
  if (replay === 'char-sync') return 'char-sync';
  if (replay === 'char') return 'char';
  return 'stroke';
}

async function runExportPlayback(
  paths: fabric.Object[],
  mode: 'stroke' | 'char' | 'char-sync' = 'stroke',
  fx: ReplayFx = 'dash'
) {
  if (mode === 'char-sync') {
    const bucket = new Map<number, fabric.Object[]>();
    for (const p of paths) {
      const k = (p as fabric.Object & { __slotIndex?: number }).__slotIndex;
      const key = k != null ? k : 998;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key)!.push(p);
    }
    const keys = [...bucket.keys()].sort((a, b) => a - b);
    const all = keys.flatMap((k) => bucket.get(k)!);
    if (!all.length) return;
    const dur = Math.max(360, Math.min(2800, LIVE_TARGET_MS - 160));
    await Promise.all(all.map((o) => animateObjectByFx(o, dur, fx)));
    return;
  }
  if (mode === 'char') {
    const bucket = new Map<number, fabric.Object[]>();
    for (const p of paths) {
      const k = (p as fabric.Object & { __slotIndex?: number }).__slotIndex;
      const key = k != null ? k : 998;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key)!.push(p);
    }
    const keys = [...bucket.keys()].sort((a, b) => a - b);
    const n = Math.max(1, keys.length);
    const dur = Math.max(220, Math.min(800, Math.floor(LIVE_TARGET_MS / n) - 60));
    const pause = Math.max(40, Math.floor((LIVE_TARGET_MS - dur * n) / Math.max(1, n - 1)));
    for (const k of keys) {
      const grp = bucket.get(k)!;
      await Promise.all(grp.map((o) => animateObjectByFx(o, dur, fx)));
      await new Promise((r) => setTimeout(r, pause));
    }
    return;
  }
  const n = Math.max(1, paths.length);
  const dur = Math.max(80, Math.min(600, Math.floor(LIVE_TARGET_MS / n) - 20));
  const pause = Math.max(8, Math.floor((LIVE_TARGET_MS - dur * n) / Math.max(1, n - 1)));
  for (const p of paths) {
    if (!canvas.getObjects().includes(p)) continue;
    await animateObjectByFx(p, dur, fx);
    await new Promise((r) => setTimeout(r, pause));
  }
}

/** 不写直出：把第 3 步的字图按槽位顺序逐个 fade-in + scale-in，整段≈3s */
async function runSilentPopIn() {
  const ordered = slotFabricImages
    .map((im, i) => ({ im, i }))
    .filter((x) => !!x.im && !!slotUrls[x.i]) as { im: fabric.Image; i: number }[];
  if (!ordered.length) return;
  const n = ordered.length;
  const dur = Math.max(280, Math.min(900, Math.floor(LIVE_TARGET_MS / n) - 80));
  const pause = Math.max(60, Math.floor((LIVE_TARGET_MS - dur * n) / Math.max(1, n - 1)));
  for (const { im } of ordered) {
    const sx = im.scaleX || 1;
    const sy = im.scaleY || 1;
    im.set({ scaleX: sx * 0.82, scaleY: sy * 0.82, opacity: 0 });
    await new Promise<void>((resolve) => {
      im.animate('opacity', 1, {
        duration: Math.floor(dur * 0.6),
        onChange: () => canvas.renderAll(),
      });
      im.animate('scaleX', sx, {
        duration: dur,
        easing: fabric.util.ease.easeOutBack,
        onChange: () => canvas.renderAll(),
      });
      im.animate('scaleY', sy, {
        duration: dur,
        easing: fabric.util.ease.easeOutBack,
        onChange: () => canvas.renderAll(),
        onComplete: () => setTimeout(resolve, pause),
      });
    });
  }
}

/** 不写直出：所有槽位字图同一时段压扁弹入（非逐个蹦出） */
async function runSilentSquashTogether() {
  const ordered = slotFabricImages
    .map((im, i) => ({ im, i }))
    .filter((x) => !!x.im && !!slotUrls[x.i]) as { im: fabric.Image; i: number }[];
  if (!ordered.length) return;
  const dur = Math.max(420, Math.min(2600, LIVE_TARGET_MS - 180));
  await Promise.all(
    ordered.map(
      ({ im }) =>
        new Promise<void>((resolve) => {
          const sx = im.scaleX || 1;
          const sy = im.scaleY || 1;
          const left0 = im.left ?? 0;
          const amp = 5;
          im.set({ scaleX: sx * 1.1, scaleY: sy * 0.48, opacity: 0, left: left0 });
          im.animate('opacity', 1, {
            duration: Math.floor(dur * 0.2),
            onChange: () => canvas.renderAll(),
          });
          im.animate('scaleX', sx, {
            duration: dur,
            easing: fabric.util.ease.easeOutBack,
            onChange: () => canvas.renderAll(),
          });
          im.animate('scaleY', sy, {
            duration: dur,
            easing: fabric.util.ease.easeOutBack,
            onChange: () => canvas.renderAll(),
          });
          fabric.util.animate({
            startValue: 0,
            endValue: 1,
            duration: dur,
            easing: fabric.util.ease.easeOutSine,
            onChange: (t: number) => {
              const decay = 1 - t;
              im.set({ left: left0 + Math.sin(t * 16 * Math.PI) * amp * decay });
              canvas.renderAll();
            },
            onComplete: () => {
              im.set({ left: left0, scaleX: sx, scaleY: sy });
              canvas.renderAll();
              resolve();
            },
          });
        }),
    ),
  );
}

/* ---------- 视频编码（WebCodecs + mp4-muxer，苹果相册友好的 H.264 MP4） ---------- */
function isWebCodecsAvailable(): boolean {
  return (
    typeof (window as any).VideoEncoder !== 'undefined' &&
    typeof (window as any).VideoFrame !== 'undefined'
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 800);
}

/** 用 WebCodecs 把 srcCanvas 在 runAnim 跑动期间逐帧编码成 H.264，
 *  再用 mp4-muxer 合到非 fragmented MP4（moov 在头部）。
 *  iOS 相册 / QuickTime / 微信全部直接识别。 */
async function encodeWithWebCodecs(
  srcCanvas: HTMLCanvasElement,
  runAnim: () => Promise<void>,
): Promise<Blob> {
  const fps = 30;
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as any),
    error: (e) => console.error('[VideoEncoder]', e),
  });

  /** 优先 baseline → main → high；都尝试 avcc 再试默认 */
  const profiles = ['avc1.42E01F', 'avc1.4D401F', 'avc1.640028'];
  let configured = false;
  for (const codec of profiles) {
    for (const avcFmt of ['avc', undefined] as const) {
      const cfg: any = {
        codec,
        width: w,
        height: h,
        framerate: fps,
        bitrate: 4_500_000,
        bitrateMode: 'variable',
      };
      if (avcFmt) cfg.avc = { format: avcFmt };
      try {
        const support = await (VideoEncoder as any).isConfigSupported(cfg);
        if (support && support.supported) {
          encoder.configure(support.config || cfg);
          configured = true;
          break;
        }
      } catch (_) {}
    }
    if (configured) break;
  }
  if (!configured) {
    encoder.close();
    throw new Error('No supported H.264 config in this browser');
  }

  let frameIdx = 0;
  let stopped = false;
  const grabFrame = () => {
    if (stopped) return;
    const ts = Math.round((frameIdx * 1_000_000) / fps);
    try {
      const vf = new VideoFrame(srcCanvas, { timestamp: ts });
      const isKey = frameIdx % fps === 0;
      encoder.encode(vf, { keyFrame: isKey });
      vf.close();
      frameIdx++;
    } catch (e) {
      console.warn('[VideoFrame] encode failed', e);
    }
  };
  const interval = setInterval(grabFrame, 1000 / fps);

  try {
    await runAnim();
  } finally {
    stopped = true;
    clearInterval(interval);
  }

  /** 多吸两帧让最后一画的尾巴稳定 */
  for (let i = 0; i < 6; i++) grabFrame();

  await encoder.flush();
  encoder.close();
  muxer.finalize();

  const ab = (muxer.target as ArrayBufferTarget).buffer;
  return new Blob([ab], { type: 'video/mp4' });
}

/* ---------- 导出视频 ---------- */
async function exportVideo() {
  const replay = (el('replay-mode') as HTMLSelectElement).value as
    | 'stroke'
    | 'char'
    | 'char-sync'
    | 'silent'
    | 'silent-sync';
  const fx = (el('replay-fx') as HTMLSelectElement).value as ReplayFx;
  const isSilent = replay === 'silent' || replay === 'silent-sync';
  if (!isSilent && drawHistory.length === 0) {
    toast('请先写几笔，或在「回放」里选择「不写直出」');
    return;
  }
  if (isSilent && !slotUrls.some((u) => !!u)) {
    toast('请先在第 3 步生成至少一个参考字');
    return;
  }
  el('export-mask').classList.remove('hidden');
  const maskMsg = el('export-mask').querySelector('p');
  if (maskMsg) maskMsg.textContent = '正在合成视频…';
  canvas.discardActiveObject();
  canvas.isDrawingMode = false;
  const tgSave = templateGroup ? templateGroup.opacity : 1;

  /** silent: 字图作为顶层独立对象 fade-in，红框/编号 全藏；
   *  非 silent: 整模板（红框+字图）藏掉，仅显示用户笔画 */
  let savedScales: Array<{ im: fabric.Image; sx: number; sy: number; op: number }> = [];
  let paths: fabric.Object[] = [];
  if (isSilent) {
    detachSlotImagesFromGroup();
    if (templateGroup) templateGroup.set({ opacity: 0 });
    if (selectedPosterTemplate.id === 'custom') {
      customSlotOverlayGroups.forEach((g) => g.set({ opacity: 0 }));
    }
    savedScales = slotFabricImages
      .filter((im): im is fabric.Image => !!im)
      .map((im) => ({ im, sx: im.scaleX || 1, sy: im.scaleY || 1, op: im.opacity ?? 1 }));
    savedScales.forEach((s) => s.im.set({ opacity: 0 }));
  } else {
    if (templateGroup) templateGroup.set({ opacity: 0 });
    if (selectedPosterTemplate.id === 'custom') {
      customSlotOverlayGroups.forEach((g) => g.set({ opacity: 0 }));
    }
    paths = drawHistory.filter((p) => canvas.getObjects().includes(p));
    paths.forEach((p) => p.set({ opacity: 0 }));
  }
  canvas.renderAll();

  const sourceCanvas = canvas.lowerCanvasEl;
  const streamCanvas = document.createElement('canvas');
  /** H.264 要求偶数尺寸 */
  streamCanvas.width = sourceCanvas.width - (sourceCanvas.width % 2);
  streamCanvas.height = sourceCanvas.height - (sourceCanvas.height % 2);
  const sctx = streamCanvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;

  let anim = true;
  const tickStream = () => {
    if (!anim) return;
    sctx.save();
    sctx.scale(dpr, dpr);
    sctx.fillStyle = '#f4f1ea';
    sctx.fillRect(0, 0, streamCanvas.width / dpr, streamCanvas.height / dpr);
    sctx.restore();
    sctx.drawImage(sourceCanvas, 0, 0);
    requestAnimationFrame(tickStream);
  };
  tickStream();

  /** 导出主路径：WebCodecs + mp4-muxer → 标准非 fragmented MP4（H.264）；
   *  iOS 相册 / QuickTime / 微信都直接吃。Safari < 17 无 WebCodecs，回退 MediaRecorder。 */
  const useWebCodecs = isWebCodecsAvailable();
  let exported = false;
  if (useWebCodecs) {
    try {
      const blob = await encodeWithWebCodecs(streamCanvas, async () => {
        if (isSilent) {
          if (replay === 'silent-sync') await runSilentSquashTogether();
          else await runSilentPopIn();
        } else await runExportPlayback(paths, playbackModeFromReplay(replay), fx);
      });
      anim = false;
      downloadBlob(blob, `手写Live_${Date.now()}.mp4`);
      toast('已保存到下载（苹果相册可直接存）');
      exported = true;
    } catch (e) {
      console.warn('[export] WebCodecs path failed, fallback to MediaRecorder', e);
    }
  }

  if (!exported) {
    let mime = '';
    if (MediaRecorder.isTypeSupported('video/mp4')) mime = 'video/mp4';
    else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mime = 'video/webm;codecs=vp9';
    else if (MediaRecorder.isTypeSupported('video/webm')) mime = 'video/webm';

    let recorder: MediaRecorder | null = null;
    const chunks: Blob[] = [];
    if (mime) {
      const stream = streamCanvas.captureStream(30);
      recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.start();
    }

    if (isSilent) {
      if (replay === 'silent-sync') await runSilentSquashTogether();
      else await runSilentPopIn();
    } else {
      await runExportPlayback(paths, playbackModeFromReplay(replay), fx);
    }
    anim = false;
    await new Promise((r) => setTimeout(r, 400));
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    await new Promise((r) => setTimeout(r, 200));

    if (mime && chunks.length) {
      const blob = new Blob(chunks, { type: mime });
      const ext = mime.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(blob, `手写Live_${Date.now()}.${ext}`);
      toast(
        ext === 'webm'
          ? '已保存为 WebM。苹果设备建议升级 Safari 17+ 后再导出 MP4'
          : '已保存到下载',
      );
    } else {
      toast('本机不支持录制，请换 Chrome / Edge 或升级 Safari 17+');
    }
  }

  if (isSilent) {
    savedScales.forEach((s) => s.im.set({ scaleX: s.sx, scaleY: s.sy, opacity: s.op }));
    attachSlotImagesToGroup();
  } else {
    paths.forEach((p) => p.set({ opacity: 1 }));
  }
  if (templateGroup) templateGroup.set({ opacity: tgSave });
  el('export-mask').classList.add('hidden');
  applyStepMode();
  canvas.renderAll();
}

/** 「预览」：跑一遍回放动画但不录制不导出，让用户先看效果 */
async function runPreview() {
  const replay = (el('replay-mode') as HTMLSelectElement).value as
    | 'stroke'
    | 'char'
    | 'char-sync'
    | 'silent'
    | 'silent-sync';
  const fx = (el('replay-fx') as HTMLSelectElement).value as ReplayFx;
  const isSilent = replay === 'silent' || replay === 'silent-sync';
  if (!isSilent && drawHistory.length === 0) {
    toast('还没有可预览的笔画；可在「回放」选「不写直出」');
    return;
  }
  if (isSilent && !slotUrls.some((u) => !!u)) {
    toast('请先在第 3 步生成至少一个参考字');
    return;
  }
  canvas.discardActiveObject();
  const wasDrawing = canvas.isDrawingMode;
  canvas.isDrawingMode = false;
  const tgSave = templateGroup ? templateGroup.opacity : 1;

  let savedScales: Array<{ im: fabric.Image; sx: number; sy: number; op: number }> = [];
  let paths: fabric.Object[] = [];
  if (isSilent) {
    detachSlotImagesFromGroup();
    if (templateGroup) templateGroup.set({ opacity: 0 });
    if (selectedPosterTemplate.id === 'custom') {
      customSlotOverlayGroups.forEach((g) => g.set({ opacity: 0 }));
    }
    savedScales = slotFabricImages
      .filter((im): im is fabric.Image => !!im)
      .map((im) => ({ im, sx: im.scaleX || 1, sy: im.scaleY || 1, op: im.opacity ?? 1 }));
    savedScales.forEach((s) => s.im.set({ opacity: 0 }));
  } else {
    if (templateGroup) templateGroup.set({ opacity: 0 });
    if (selectedPosterTemplate.id === 'custom') {
      customSlotOverlayGroups.forEach((g) => g.set({ opacity: 0 }));
    }
    paths = drawHistory.filter((p) => canvas.getObjects().includes(p));
    paths.forEach((p) => p.set({ opacity: 0 }));
  }
  canvas.renderAll();

  if (isSilent) {
    if (replay === 'silent-sync') await runSilentSquashTogether();
    else await runSilentPopIn();
  } else await runExportPlayback(paths, playbackModeFromReplay(replay), fx);

  if (isSilent) {
    savedScales.forEach((s) => s.im.set({ scaleX: s.sx, scaleY: s.sy, opacity: s.op }));
    attachSlotImagesToGroup();
  } else {
    paths.forEach((p) => p.set({ opacity: 1 }));
  }
  if (templateGroup) templateGroup.set({ opacity: tgSave });
  canvas.isDrawingMode = wasDrawing;
  applyStepMode();
  canvas.renderAll();
  toast('预览结束');
}

/* ---------- 大字描写 ---------- */
function initTraceCanvas() {
  if (traceCanvas) return;
  traceCanvas = new fabric.Canvas('trace-canvas', {
    isDrawingMode: true,
    selection: false,
  });
  traceCanvas.on('path:created', (e: { path?: fabric.Object }) => {
    let p = e.path;
    if (!p) return;
    p = postProcessPath(fabric, traceCanvas, p, brushKind, brushColor, brushRuntimeOptions());
    /** strokeUniform: 之后在 flush 时整体 scale，stroke 不会跟随变细 → 粗细一致 */
    p.set({ selectable: false, evented: true, strokeUniform: true });
    if ((p as fabric.Group)._objects) {
      (p as fabric.Group)._objects.forEach((sub) => sub.set({ strokeUniform: true }));
    }
    pendingTracePaths.push(p);
  });
}

function syncTraceCanvasSize() {
  if (!traceCanvas || !canvas) return;
  traceCanvas.setDimensions({ width: canvas.getWidth(), height: canvas.getHeight() });
}

function renderTraceSlotGuide() {
  if (!traceCanvas) return;
  const slotIdx = traceSlotOrder[traceCursor];
  const url = slotUrls[slotIdx];
  traceGuideImage = null;
  traceCanvas.clear();
  pendingTracePaths.length = 0;
  if (!url) {
    traceCanvas.renderAll();
    updateTraceBrush();
    return;
  }
  /** 直接用 slotUrls 的 PNG 数据（来自田字格输出），重新居中、按短边 75% 等比放大；
   *  完全不依赖 main canvas 上 image 当前的 left/top/scale（那些可能是 group 局部坐标） */
  fabric.Image.fromURL(url, (img: fabric.Image) => {
    if (!traceCanvas) return;
    const cw = traceCanvas.getWidth();
    const ch = traceCanvas.getHeight();
    const iw = img.width || 1;
    const ih = img.height || 1;
    const target = Math.min(cw, ch) * 0.75;
    const k = target / Math.max(iw, ih);
    img.set({
      left: cw / 2,
      top: ch / 2,
      originX: 'center',
      originY: 'center',
      scaleX: k,
      scaleY: k,
      opacity: 0.32,
      selectable: false,
      evented: false,
      hasControls: false,
      lockMovementX: true,
      lockMovementY: true,
    });
    traceCanvas.add(img);
    traceCanvas.sendToBack(img);
    traceGuideImage = img;
    traceCanvas.renderAll();
  });
  updateTraceBrush();
}

function updateTraceModalTitle() {
  const slotIdx = traceSlotOrder[traceCursor];
  const circles = getCircleElements(selectedPosterTemplate);
  const lab = plainSlotLabel(circles[slotIdx]?.n, slotIdx);
  el('trace-title').textContent = `大字描写 · 字${lab}（${traceCursor + 1}/${traceSlotOrder.length}）`;
}

function discardPendingTraceStrokes() {
  if (!traceCanvas) return;
  pendingTracePaths.forEach((p) => {
    try {
      traceCanvas.remove(p);
    } catch (_) {
      /* */
    }
  });
  pendingTracePaths.length = 0;
}

function openTraceModal() {
  traceSlotOrder = slotUrls.map((u, i) => (u ? i : -1)).filter((i) => i >= 0);
  if (!traceSlotOrder.length) {
    toast('请先在第 3 步为至少一个槽位生成参考字');
    return;
  }
  traceCursor = 0;
  traceModalOpen = true;
  initTraceCanvas();
  syncTraceCanvasSize();
  traceCanvas.discardActiveObject();
  traceCanvas.isDrawingMode = true;
  renderTraceSlotGuide();
  updateTraceModalTitle();
  applyStepMode();
  el('trace-modal').classList.remove('hidden');
}

function closeTraceModal() {
  discardPendingTraceStrokes();
  traceCanvas?.clear();
  traceGuideImage = null;
  traceModalOpen = false;
  el('trace-modal').classList.add('hidden');
  applyStepMode();
}

/** 取对象在所在 fabric canvas 上的世界包围盒（含祖先 group transform） */
function worldRect(o: fabric.Object) {
  const r = o.getBoundingRect(true, true);
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
}

function flushCurrentTraceSlotToMain() {
  if (!traceCanvas || !pendingTracePaths.length) return;
  const slotIdx = traceSlotOrder[traceCursor];
  const slotImg = slotFabricImages[slotIdx];

  /** 把 trace 弹层里写出的 path（按全屏放大写）映射到主画布对应槽位的字图大小：
   *  guideRect → slotRect 的等比缩放 + 中心对齐。strokeUniform 让粗细保持当前 brushSize。*/
  let map: { tx: number; ty: number; gx: number; gy: number; k: number } | null = null;
  if (traceGuideImage && slotImg) {
    const t = worldRect(traceGuideImage);
    const s = worldRect(slotImg);
    const guideSize = Math.max(t.w, t.h);
    const slotSize = Math.max(s.w, s.h);
    if (guideSize > 0 && slotSize > 0) {
      map = { tx: t.cx, ty: t.cy, gx: s.cx, gy: s.cy, k: slotSize / guideSize };
    }
  }

  pendingTracePaths.forEach((p) => {
    traceCanvas!.remove(p);
    (p as fabric.Object & { __slotIndex?: number }).__slotIndex = slotIdx;
    if (map) {
      const c = worldRect(p);
      const newCx = map.gx + (c.cx - map.tx) * map.k;
      const newCy = map.gy + (c.cy - map.ty) * map.k;
      p.set({
        scaleX: (p.scaleX || 1) * map.k,
        scaleY: (p.scaleY || 1) * map.k,
        strokeUniform: true,
      });
      p.setPositionByOrigin(new fabric.Point(newCx, newCy), 'center', 'center');
      p.setCoords();
    }
    p.set({ selectable: step === 3 && pathEditMode, evented: true });
    canvas.add(p);
    drawHistory.push(p);
  });
  pendingTracePaths.length = 0;
  traceCanvas.discardActiveObject();
  traceCanvas.clear();
  traceGuideImage = null;
  canvas.renderAll();
  traceCanvas.renderAll();
}

function advanceTraceAfterDone() {
  flushCurrentTraceSlotToMain();
  traceCursor += 1;
  if (traceCursor >= traceSlotOrder.length) {
    toast('本轮大字描写已合并到主画布');
    closeTraceModal();
    return;
  }
  renderTraceSlotGuide();
  updateTraceModalTitle();
}

/* ---------- 自由画布：双指缩放 + 滚轮缩放 + 平移（参考 Example.html） ---------- */
function setupCanvasZoomPan() {
  const wrap = el('stage-wrap');
  const resetBtn = el('btn-reset-view');
  const MIN_Z = 0.3;
  const MAX_Z = 5;
  let pinching = false;
  let savedDrawingMode = false;
  let initialDist = 0;
  let initialZoom = 1;
  let lastCenter = { x: 0, y: 0 };

  /** 视图变化（缩放 / 平移）后显示「复位」 */
  const showReset = () => {
    const vpt = canvas.viewportTransform!;
    const dirty =
      Math.abs(vpt[0] - 1) > 0.001 ||
      Math.abs(vpt[3] - 1) > 0.001 ||
      Math.abs(vpt[4]) > 0.5 ||
      Math.abs(vpt[5]) > 0.5;
    resetBtn.classList.toggle('hidden', !dirty);
  };

  const localPoint = (clientX: number, clientY: number) => {
    const r = (canvas.upperCanvasEl as HTMLCanvasElement).getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  wrap.addEventListener(
    'touchstart',
    (e: TouchEvent) => {
      if (e.touches.length === 2) {
        pinching = true;
        savedDrawingMode = canvas.isDrawingMode;
        canvas.isDrawingMode = false;
        const a = e.touches[0];
        const b = e.touches[1];
        initialDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        initialZoom = canvas.getZoom();
        lastCenter = {
          x: (a.clientX + b.clientX) / 2,
          y: (a.clientY + b.clientY) / 2,
        };
      }
    },
    { passive: false }
  );

  wrap.addEventListener(
    'touchmove',
    (e: TouchEvent) => {
      if (!pinching || e.touches.length < 2) return;
      e.preventDefault();
      const a = e.touches[0];
      const b = e.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      let zoom = initialZoom * (dist / Math.max(1, initialDist));
      zoom = Math.min(MAX_Z, Math.max(MIN_Z, zoom));
      const center = {
        x: (a.clientX + b.clientX) / 2,
        y: (a.clientY + b.clientY) / 2,
      };
      const local = localPoint(center.x, center.y);
      canvas.zoomToPoint(new fabric.Point(local.x, local.y), zoom);
      canvas.relativePan(new fabric.Point(center.x - lastCenter.x, center.y - lastCenter.y));
      lastCenter = center;
      showReset();
    },
    { passive: false }
  );

  const endPinch = () => {
    if (!pinching) return;
    pinching = false;
    canvas.isDrawingMode = savedDrawingMode;
    refreshAllCustomSlotGroupsCoords();
  };
  wrap.addEventListener('touchend', (e: TouchEvent) => {
    if (e.touches.length < 2) endPinch();
  });
  wrap.addEventListener('touchcancel', endPinch);

  wrap.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      e.preventDefault();
      let zoom = canvas.getZoom();
      zoom *= Math.pow(0.999, e.deltaY);
      zoom = Math.min(MAX_Z, Math.max(MIN_Z, zoom));
      const local = localPoint(e.clientX, e.clientY);
      canvas.zoomToPoint(new fabric.Point(local.x, local.y), zoom);
      showReset();
      refreshAllCustomSlotGroupsCoords();
    },
    { passive: false }
  );

  resetBtn.addEventListener('click', () => {
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
    refreshAllCustomSlotGroupsCoords();
    resetBtn.classList.add('hidden');
  });
}

/* ---------- 初始化 ---------- */
function init() {
  normalizeCustomTemplate();
  canvas = new fabric.Canvas('main', {
    isDrawingMode: false,
    selection: true,
    preserveObjectStacking: true,
  });
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  setupCanvasZoomPan();

  /**
   * Fabric 命中嵌套 Group 时 findTarget 仍返回外层海报 Group，真正的圆位在 canvas.targets 里。
   * 在默认选中逻辑运行前把 _target 换成自定义圆组，才能单选圆并拖/缩放。
   */
  canvas.on('mouse:down:before', () => {
    if (step !== 1 && !(step === 2 && step2CanvasMode === 'poster')) return;
    if (selectedPosterTemplate.id !== 'custom' || customPlaceNext) return;
    /** 圆位已脱离父组，findTarget 直接命中顶层圆位，不必改 _target */
    if (customSlotOverlayGroups.length) return;
    const subs = (canvas as fabric.Canvas & { targets?: fabric.Object[] }).targets;
    if (!subs?.length) return;
    for (let i = subs.length - 1; i >= 0; i--) {
      const t = subs[i] as fabric.Object & { customSlotIndex?: number };
      if (t?.customSlotIndex != null) {
        (canvas as fabric.Canvas & { _target?: fabric.Object })._target = t;
        break;
      }
    }
  });

  canvas.on('path:created', (e: { path?: fabric.Object }) => {
    if (traceModalOpen) return;
    let p = e.path;
    if (!p) return;
    p = postProcessPath(fabric, canvas, p, brushKind, brushColor, brushRuntimeOptions());
    p.set({
      selectable: step === 3 && pathEditMode,
      evented: true,
      strokeUniform: true,
    });
    if ((p as fabric.Group)._objects) {
      (p as fabric.Group)._objects.forEach((sub) => sub.set({ strokeUniform: true }));
    }
    drawHistory.push(p);
  });

  canvas.on('mouse:down', (opt: { e?: Event }) => {
    if (tryConsumeCustomPlace(opt)) {
      opt.e?.preventDefault?.();
      opt.e?.stopPropagation?.();
      return;
    }
    queueMicrotask(() => refreshActiveCustomSlotCoords());
  });

  canvas.on('selection:created', () => {
    queueMicrotask(() => refreshActiveCustomSlotCoords());
  });
  canvas.on('selection:updated', () => {
    queueMicrotask(() => refreshActiveCustomSlotCoords());
  });

  canvas.on('object:modified', (opt: { target?: fabric.Object }) => {
    const t = opt.target;
    if (t && (t as fabric.Object & { customSlotIndex?: number }).customSlotIndex != null) {
      onCustomSlotGroupModified(t);
    } else if (
      t &&
      t.type === 'image' &&
      (t as fabric.Image & { __slotIndex?: number }).__slotIndex != null &&
      step === 2
    ) {
      captureSlotImageAdjustments();
    } else if (t && templateGroup && t === templateGroup) {
      positionCustomSlotOverlaysFromData();
    }
  });

  el('input-photo').addEventListener('change', (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) setBgFromFile(f);
  });
  el('btn-skip-photo').addEventListener('click', () => {
    ensureBgSolid();
    toast('已使用浅色底');
  });

  el('btn-back').addEventListener('click', () => {
    if (step === 0) return;
    setStep(step - 1);
  });

  el('btn-next').addEventListener('click', () => {
    if (step === 0) {
      ensureBgSolid();
      if (!bgImage) ensureBgSolid();
      createTemplateGroup(false);
      setStep(1);
      return;
    }
    if (step === 1) {
      if (selectedPosterTemplate.id === 'custom' && getCircleElements(customTemplate).length === 0) {
        toast('自定义请先点「＋圆位」，在红框内放置至少一个圆');
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!slotUrls[0]) {
        toast('请先在第 3 步完成第一个槽位的参考字');
        return;
      }
      captureSlotImageAdjustments();
      rebuildTemplateWithImages(() => {
        setStep(3);
      });
      return;
    }
    if (step === 3) {
      void exportVideo();
    }
  });

  document.querySelectorAll('.tpl-cat-btn').forEach((btnEl) => {
    btnEl.addEventListener('click', () => {
      const cat = (btnEl as HTMLElement).dataset.cat;
      if (!cat) return;
      syncTplCatButtons(cat);
      const items = filteredTemplates();
      if (!items.some((t) => t.id === selectedPosterTemplate.id)) {
        const next = items[0] || POSTER_TEMPLATES[0];
        selectedPosterTemplate = next.id === 'custom' ? customTemplate : next;
        placement = defaultPlacementForTemplate(selectedPosterTemplate);
        syncSlotsForTemplateChange(true);
        if (templateGroup && (step === 1 || step === 2)) createTemplateGroup(false);
      }
      renderTplList();
      renderCustomEditor();
      updatePanel1Tip();
    });
  });

  el('tpl-list').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('.tpl-btn') as HTMLButtonElement | null;
    if (!b?.dataset.tid) return;
    const t = POSTER_TEMPLATES.find((x) => x.id === b.dataset.tid);
    if (!t || t.id === selectedPosterTemplate.id) return;
    selectedPosterTemplate = t.id === 'custom' ? customTemplate : t;
    placement = defaultPlacementForTemplate(selectedPosterTemplate);
    syncSlotsForTemplateChange(true);
    if (templateGroup && (step === 1 || step === 2)) createTemplateGroup(false);
    renderTplList();
    renderCustomEditor();
    updatePanel1Tip();
  });

  el('btn-custom-add').addEventListener('click', () => {
    if (selectedPosterTemplate.id !== 'custom') return;
    if (customPlaceNext) {
      setCustomPlaceNext(false);
      toast('已取消，可再点「＋圆位」');
      return;
    }
    setCustomPlaceNext(true);
    toast('请在红框内轻点，放置新圆心');
  });

  el('custom-labels')?.addEventListener('input', () => {
    if (selectedPosterTemplate.id !== 'custom') return;
    const raw = (el('custom-labels') as HTMLInputElement).value.replace(/\s/g, '');
    const circles = getCircleElements(customTemplate) as PosterCircleEl[];
    for (let i = 0; i < circles.length; i++) {
      circles[i].n = raw[i] != null && raw[i] !== '' ? raw[i] : String(i + 1);
    }
    customTemplate.elements = circles;
    selectedPosterTemplate = customTemplate;
    renderCustomEditor();
    syncCustomSlotLabelTexts();
    if (step === 2) rebuildSlotButtons();
  });

  el('custom-slot-list').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.custom-chip-del') as HTMLButtonElement | null;
    if (!btn?.dataset.idx) return;
    const idx = Number(btn.dataset.idx);
    const circles = getCircleElements(customTemplate);
    if (!Number.isFinite(idx) || idx < 0 || idx >= circles.length) return;
    circles.splice(idx, 1);
    customTemplate.elements = circles as PosterCircleEl[];
    refreshCustomTemplateOnCanvas(true);
  });

  el('slot-row').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('.slot-btn') as HTMLButtonElement | null;
    if (!btn || btn.dataset.slot == null) return;
    currentSlot = Number(btn.dataset.slot) || 0;
    el('slot-row').querySelectorAll('.slot-btn').forEach((x) => {
      x.classList.toggle('active', Number((x as HTMLElement).dataset.slot) === currentSlot);
    });
  });

  el('btn-open-warp').addEventListener('click', openWarpModal);
  el('warp-close').addEventListener('click', closeWarpModal);
  el('warp-ok').addEventListener('click', confirmWarp);

  ['warp-vx', 'warp-hy'].forEach((id) => {
    el(id).addEventListener('input', () => {
      readWarpSliders();
      const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
      renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
      paintWarpPreview();
    });
  });

  el('warp-modal').addEventListener('click', (e) => {
    if (e.target === el('warp-modal')) closeWarpModal();
  });

  let warpComposing = false;
  el('warp-char').addEventListener('compositionstart', () => {
    warpComposing = true;
  });
  el('warp-char').addEventListener('compositionend', () => {
    warpComposing = false;
    readWarpSliders();
    const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
    (el('warp-char') as HTMLInputElement).value = ch;
    renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
    paintWarpPreview();
  });
  el('warp-char').addEventListener('input', () => {
    if (warpComposing) return;
    readWarpSliders();
    const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
    if ((el('warp-char') as HTMLInputElement).value !== ch)
      (el('warp-char') as HTMLInputElement).value = ch;
    renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
    paintWarpPreview();
  });

  document.querySelectorAll('.warp-presets button').forEach((b) => {
    b.addEventListener('click', () => {
      const p = (b as HTMLButtonElement).dataset.p;
      if (p === 'rf') {
        (el('warp-vx') as HTMLInputElement).value = '30';
        (el('warp-hy') as HTMLInputElement).value = '50';
      } else if (p === 'us') {
        (el('warp-vx') as HTMLInputElement).value = '50';
        (el('warp-hy') as HTMLInputElement).value = '30';
      } else if (p === 'trap') {
        warpState.corners = {
          tl: { x: 0.2, y: 0.05 },
          tr: { x: 0.8, y: 0.05 },
          bl: { x: 0.02, y: 0.95 },
          br: { x: 0.98, y: 0.95 },
        };
      } else if (p === 'reset') {
        warpState.corners = defaultCorners();
        (el('warp-vx') as HTMLInputElement).value = '50';
        (el('warp-hy') as HTMLInputElement).value = '50';
        warpState.vx = 0.5;
        warpState.hy = 0.5;
      }
      readWarpSliders();
      const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
      renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
      paintWarpPreview();
    });
  });

  const repaintWarpWithFont = () => {
    const ch = (el('warp-char') as HTMLInputElement).value.trim().slice(-1) || '字';
    renderSourceText(srcCtx, ch, getSelectedWarpFont(), SRC);
    paintWarpPreview();
  };

  el('warp-font').addEventListener('change', () => {
    repaintWarpWithFont();
    if (document.fonts && document.fonts.ready) {
      void document.fonts.ready.then(repaintWarpWithFont);
    }
  });

  installWarpModalDrag(
    () => el('warp-stage') as HTMLElement,
    {
      onMoveCorner: (key, n) => {
        warpState.corners[key] = n;
        alignSlidersToState();
        paintWarpPreview();
      },
      onMoveAxisV: (vx) => {
        warpState.vx = vx;
        alignSlidersToState();
        paintWarpPreview();
      },
      onMoveAxisH: (hy) => {
        warpState.hy = hy;
        alignSlidersToState();
        paintWarpPreview();
      },
      onResetCorner: (key) => {
        warpState.corners[key] = { ...defaultCornerPoint(key) };
        alignSlidersToState();
        paintWarpPreview();
      },
      onResetAxisV: () => {
        warpState.vx = 0.5;
        alignSlidersToState();
        paintWarpPreview();
      },
      onResetAxisH: () => {
        warpState.hy = 0.5;
        alignSlidersToState();
        paintWarpPreview();
      },
    }
  );

  el('brush-color').addEventListener('input', () => {
    brushColor = (el('brush-color') as HTMLInputElement).value;
    updateBrush();
    updateTraceBrush();
    /** 「笔画」模式且有选中：实时把颜色应用到选中笔迹 */
    if (step === 3 && pathEditMode) applyColorToSelected(brushColor);
  });
  el('brush-size').addEventListener('input', () => {
    brushSize = Number((el('brush-size') as HTMLInputElement).value);
    updateBrush();
    updateTraceBrush();
    if (step === 3 && pathEditMode) applyWidthToSelected(brushSize);
  });

  setupBrushModal();

  el('btn-ref').addEventListener('click', () => {
    refVisible = !refVisible;
    el('ref-label').textContent = refVisible ? '开' : '关';
    applyRefOpacity();
    canvas.renderAll();
  });

  el('btn-step2-poster').addEventListener('click', () => {
    if (step !== 2) return;
    step2CanvasMode = 'poster';
    canvas.discardActiveObject();
    applyStepMode();
  });
  el('btn-step2-slot').addEventListener('click', () => {
    if (step !== 2) return;
    step2CanvasMode = 'slot';
    canvas.discardActiveObject();
    applyStepMode();
    toast('点红圈里的参考字即可拖动、缩放');
  });

  el('btn-path-edit').addEventListener('click', () => {
    if (step !== 3) return;
    pathEditMode = !pathEditMode;
    applyStepMode();
    syncEffectRowVisibility();
    if (!pathEditMode) canvas.discardActiveObject();
    toast(
      pathEditMode
        ? '编辑模式：点选笔画后用上方颜色 / 粗细 / 效果即时调整'
        : '已恢复自由写字'
    );
  });

  el('effect-row').addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('.effect-btn') as HTMLButtonElement | null;
    if (!t) return;
    const eff = t.dataset.effect as 'none' | 'neon' | 'emboss' | 'knockout';
    document.querySelectorAll('#effect-row .effect-btn').forEach((b) => b.classList.remove('active'));
    t.classList.add('active');
    applyEffectToSelected(eff);
  });

  el('btn-delete-stroke').addEventListener('click', () => {
    const objs = canvas.getActiveObjects();
    if (!objs.length) return;
    canvas.discardActiveObject();
    objs.forEach((o) => {
      const idx = drawHistory.indexOf(o);
      if (idx >= 0) drawHistory.splice(idx, 1);
      canvas.remove(o);
    });
    canvas.requestRenderAll();
    syncEffectRowState();
  });

  canvas.on('selection:created', syncEffectRowState);
  canvas.on('selection:updated', syncEffectRowState);
  canvas.on('selection:cleared', syncEffectRowState);

  el('btn-trace-big').addEventListener('click', () => {
    if (step !== 3) return;
    openTraceModal();
  });

  el('btn-preview-play').addEventListener('click', () => {
    if (step !== 3) return;
    void runPreview();
  });

  el('trace-close').addEventListener('click', () => {
    discardPendingTraceStrokes();
    closeTraceModal();
  });
  el('trace-exit-all').addEventListener('click', () => {
    flushCurrentTraceSlotToMain();
    closeTraceModal();
    toast('已合并当前字并退出');
  });
  el('trace-done-slot').addEventListener('click', () => advanceTraceAfterDone());
  el('trace-prev').addEventListener('click', () => {
    if (!traceModalOpen) return;
    discardPendingTraceStrokes();
    traceCanvas?.clear();
    traceCursor = Math.max(0, traceCursor - 1);
    renderTraceSlotGuide();
    updateTraceModalTitle();
  });
  el('trace-next').addEventListener('click', () => {
    if (!traceModalOpen) return;
    flushCurrentTraceSlotToMain();
    traceCursor = Math.min(traceSlotOrder.length - 1, traceCursor + 1);
    renderTraceSlotGuide();
    updateTraceModalTitle();
  });
  el('trace-modal').addEventListener('click', (e) => {
    if (e.target === el('trace-modal')) {
      discardPendingTraceStrokes();
      closeTraceModal();
    }
  });

  el('btn-undo').addEventListener('click', () => {
    const p = drawHistory.pop();
    if (p && canvas.getObjects().includes(p)) {
      canvas.remove(p);
      canvas.renderAll();
      toast('已撤回');
    } else toast('没有可撤回的笔迹');
  });

  refreshBrushButton();

  syncSlotsForTemplateChange(true);
  renderTplList();
  setStep(0);
}

try {
  init();
} catch (err) {
  console.error('[手写Live] init', err);
  el('step-hint').textContent =
    '初始化失败：' + (err instanceof Error ? err.message : String(err)) + '（请打开控制台查看）';
  el('step-hint').style.color = '#fca5a5';
}
