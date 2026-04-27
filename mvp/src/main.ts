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
  circledSlotLabel,
} from './posterTemplateFabric';
import { BRUSHES, applyBrush, postProcessPath, createNoisePattern } from './brushes';
import type { BrushId } from './brushes';

let step = 0;
let canvas: fabric.Canvas;
let bgImage: fabric.Image | null = null;
let templateGroup: fabric.Group | null = null;
let selectedPosterTemplate = POSTER_TEMPLATES[0];
let placement = defaultPlacementForTemplate(selectedPosterTemplate);
let slotUrls: (string | null)[] = [];
let refVisible = true;
/** 手写笔迹（含中空组等 fabric 对象） */
const drawHistory: fabric.Object[] = [];
let currentSlot = 0;
/** 槽位参考字 fabric.Image，与 slotUrls 同索引；从 templateGroup 解引用便于交互配置 */
let slotFabricImages: (fabric.Image | null)[] = [];
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

const warpState = {
  corners: defaultCorners(),
  vx: 0.5,
  hy: 0.5,
};

const el = (id: string) => document.getElementById(id)!;

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
}

function resizeCanvas() {
  const wrap = el('stage-wrap');
  const r = wrap.getBoundingClientRect();
  canvas.setDimensions({ width: Math.max(200, r.width), height: Math.max(200, r.height) });
  canvas.renderAll();
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
    ? '笔画模式：点选已写的笔迹，拖控制点调整。再点「笔画」恢复书写。'
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
      const movePoster = step === 1;
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

function applyRefOpacity() {
  if (!templateGroup) return;
  if (step !== 3) {
    templateGroup.set({ opacity: 1 });
    return;
  }
  if (refVisible) {
    templateGroup.set({ opacity: 0.48 });
  } else {
    templateGroup.set({ opacity: 0.14 });
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
  const cat = (el('tpl-category') as HTMLSelectElement).value;
  return POSTER_TEMPLATES.filter((t) => cat === 'all' || t.category === cat);
}

function renderTplList() {
  const list = el('tpl-list');
  list.innerHTML = '';
  filteredTemplates().forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tpl-btn' + (t.id === selectedPosterTemplate.id ? ' active' : '');
    btn.textContent = t.name;
    btn.dataset.tid = t.id;
    list.appendChild(btn);
  });
}

function syncSlotsForTemplateChange(clearUrls: boolean) {
  const n = getCircleElements(selectedPosterTemplate).length;
  if (clearUrls) slotUrls = new Array(n).fill(null);
  else {
    const next = new Array(n).fill(null);
    for (let i = 0; i < Math.min(n, slotUrls.length); i++) next[i] = slotUrls[i];
    slotUrls = next;
  }
  currentSlot = Math.min(currentSlot, Math.max(0, n - 1));
  if (step === 2) rebuildSlotButtons();
}

function ensureSlotLen() {
  const n = getCircleElements(selectedPosterTemplate).length;
  while (slotUrls.length < n) slotUrls.push(null);
  slotUrls.length = n;
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
    b.textContent = `字${circledSlotLabel(ce.n, i)}`;
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
  for (let i = 0; i < ellipses.length; i++) parts.push(ellipses[i], labels[i]);
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
      const objs: fabric.Object[] = [frame];
      for (let i = 0; i < ellipses.length; i++) {
        const im = imgs[i];
        if (im) {
          configureSlotFabricImage(im, i);
          slotFabricImages[i] = im;
          objs.push(im);
        }
        objs.push(ellipses[i], labels[i]);
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
  const circles = getCircleElements(selectedPosterTemplate);
  const lab = circledSlotLabel(circles[currentSlot]?.n, currentSlot);
  rebuildTemplateWithImages(() => {
    toast(`字${lab} 已更新`);
    closeWarpModal();
  });
}

/* ---------- 笔刷 ---------- */
let brushColor = '#1a1a1a';
let brushSize = 10;
let brushKind: BrushId = 'pen';

function updateBrush() {
  applyBrush(fabric, canvas, brushKind, brushColor, brushSize);
}

/* ---------- 「笔画」模式：选中笔画即时改色 / 粗细 / 效果 ---------- */
function isHollowGroup(o: fabric.Object): boolean {
  return !!(o as fabric.Object & { isHollow?: boolean }).isHollow;
}

function applyColorToOne(o: fabric.Object, color: string) {
  if (isHollowGroup(o)) {
    const sub = (o as fabric.Group)._objects?.[0];
    if (sub) sub.set({ stroke: color });
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
  if (isHollowGroup(o)) {
    const subs = (o as fabric.Group)._objects;
    if (subs && subs.length >= 2) {
      const outerW = w * 2.2;
      subs[0].set({ strokeWidth: outerW });
      subs[1].set({ strokeWidth: outerW * 0.55 });
    }
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
  applyBrush(fabric, traceCanvas, brushKind, brushColor, brushSize);
}

function populateBrushScroll() {
  const host = el('brush-scroll');
  host.innerHTML = '';
  BRUSHES.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brush-pill' + (b.id === brushKind ? ' active' : '');
    btn.dataset.brush = b.id;
    btn.textContent = b.short;
    btn.title = b.label;
    host.appendChild(btn);
  });
}

function setBrushKind(id: BrushId) {
  brushKind = id;
  populateBrushScroll();
  updateBrush();
  updateTraceBrush();
}

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

async function runExportPlayback(paths: fabric.Object[]) {
  const replay = (el('replay-mode') as HTMLSelectElement).value;
  const dur = paths.length > 10 ? 120 : 280;
  const pause = paths.length > 10 ? 12 : 36;
  if (replay === 'char') {
    const bucket = new Map<number, fabric.Object[]>();
    for (const p of paths) {
      const k = (p as fabric.Object & { __slotIndex?: number }).__slotIndex;
      const key = k != null ? k : 998;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(p);
    }
    const keys = [...bucket.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      const grp = bucket.get(k)!;
      await Promise.all(grp.map((o) => dashAnimateObject(o, dur)));
      await new Promise((r) => setTimeout(r, pause));
    }
    return;
  }
  for (const p of paths) {
    if (!canvas.getObjects().includes(p)) continue;
    await dashAnimateObject(p, dur);
    await new Promise((r) => setTimeout(r, pause));
  }
}

/* ---------- 导出视频 ---------- */
async function exportVideo() {
  if (drawHistory.length === 0) {
    toast('请先写几笔再导出');
    return;
  }
  el('export-mask').classList.remove('hidden');
  canvas.discardActiveObject();
  canvas.isDrawingMode = false;
  const tgSave = templateGroup ? templateGroup.opacity : 1;
  if (templateGroup) templateGroup.set({ opacity: 0 });
  const paths = drawHistory.filter((p) => canvas.getObjects().includes(p));
  paths.forEach((p) => p.set({ opacity: 0 }));
  canvas.renderAll();

  const sourceCanvas = canvas.lowerCanvasEl;
  const streamCanvas = document.createElement('canvas');
  streamCanvas.width = sourceCanvas.width;
  streamCanvas.height = sourceCanvas.height;
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

  await runExportPlayback(paths);

  anim = false;
  await new Promise((r) => setTimeout(r, 400));
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  await new Promise((r) => setTimeout(r, 200));

  if (mime && chunks.length) {
    const blob = new Blob(chunks, { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `手写Live_${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 500);
    toast('视频已保存到下载');
  } else {
    toast('本机不支持录制，请换 Chrome / Edge 试试');
  }

  paths.forEach((p) => p.set({ opacity: 1 }));
  if (templateGroup) templateGroup.set({ opacity: tgSave });
  el('export-mask').classList.add('hidden');
  applyStepMode();
  canvas.renderAll();
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
    p = postProcessPath(fabric, traceCanvas, p, brushKind, brushColor);
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
  const lab = circledSlotLabel(circles[slotIdx]?.n, slotIdx);
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
    },
    { passive: false }
  );

  resetBtn.addEventListener('click', () => {
    canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    canvas.requestRenderAll();
    resetBtn.classList.add('hidden');
  });
}

/* ---------- 初始化 ---------- */
function init() {
  canvas = new fabric.Canvas('main', {
    isDrawingMode: false,
    selection: true,
    preserveObjectStacking: true,
  });
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  setupCanvasZoomPan();

  canvas.on('path:created', (e: { path?: fabric.Object }) => {
    if (traceModalOpen) return;
    let p = e.path;
    if (!p) return;
    p = postProcessPath(fabric, canvas, p, brushKind, brushColor);
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
      setStep(2);
      return;
    }
    if (step === 2) {
      if (!slotUrls[0]) {
        toast('请先在第 3 步完成第一个槽位的参考字');
        return;
      }
      rebuildTemplateWithImages();
      setStep(3);
      return;
    }
    if (step === 3) {
      void exportVideo();
    }
  });

  el('tpl-category').addEventListener('change', () => {
    const items = filteredTemplates();
    if (!items.some((t) => t.id === selectedPosterTemplate.id)) {
      selectedPosterTemplate = items[0] || POSTER_TEMPLATES[0];
      placement = defaultPlacementForTemplate(selectedPosterTemplate);
      syncSlotsForTemplateChange(true);
      if (templateGroup && (step === 1 || step === 2)) createTemplateGroup(false);
    }
    renderTplList();
  });

  el('tpl-list').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('.tpl-btn') as HTMLButtonElement | null;
    if (!b?.dataset.tid) return;
    const t = POSTER_TEMPLATES.find((x) => x.id === b.dataset.tid);
    if (!t || t.id === selectedPosterTemplate.id) return;
    selectedPosterTemplate = t;
    placement = defaultPlacementForTemplate(selectedPosterTemplate);
    syncSlotsForTemplateChange(true);
    if (templateGroup && (step === 1 || step === 2)) createTemplateGroup(false);
    renderTplList();
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
        ? '笔画模式：点选笔画后用上方颜色 / 粗细 / 效果即时调整'
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

  populateBrushScroll();
  el('brush-scroll').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest('.brush-pill') as HTMLButtonElement | null;
    if (!b?.dataset.brush) return;
    setBrushKind(b.dataset.brush as BrushId);
  });

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
