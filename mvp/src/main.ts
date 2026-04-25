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

let step = 0;
let canvas: fabric.Canvas;
let bgImage: fabric.Image | null = null;
let templateGroup: fabric.Group | null = null;
let selectedPosterTemplate = POSTER_TEMPLATES[0];
let placement = defaultPlacementForTemplate(selectedPosterTemplate);
let slotUrls: (string | null)[] = [];
let refVisible = true;
const drawHistory: fabric.Path[] = [];
let currentSlot = 0;

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
    '第 3 步 · 邪修字',
    '第 4 步 · 描字与导出',
  ];
  const hints = [
    '用作成片最底层。可跳过，用浅色底。',
    '选分类与模板；红框与椭圆位置与 Poster 一致。拖动到要写字的区域。',
    '按槽位切换圆圈，输入一字后调邪修；字会落在该椭圆圆心附近。',
    '打开参考层可看见浅粉字与红圈；写完点「导出视频」。',
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
}

function applyStepMode() {
  canvas.selection = step === 1 || step === 2;
  canvas.isDrawingMode = step === 3;
  if (step === 3) updateBrush();
  if (templateGroup) {
    templateGroup.selectable = step === 1 || step === 2;
    templateGroup.evented = step === 1 || step === 2;
  }
  // 第 1 步不画画：必须关掉上层 canvas 命中，否则会挡住底部「下一步」
  const pe = step === 0 ? 'none' : 'auto';
  if (canvas.upperCanvasEl) (canvas.upperCanvasEl as HTMLCanvasElement).style.pointerEvents = pe;
  if (canvas.lowerCanvasEl) (canvas.lowerCanvasEl as HTMLCanvasElement).style.pointerEvents = pe;
  applyRefOpacity();
  canvas.renderAll();
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

function createTemplateGroup(preserveTransform = false) {
  if (!canvas) return;
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
  canvas.remove(templateGroup);

  const cw = canvas.width!;
  const ch = canvas.height!;
  const { gw, gh } = placementBoxPx(placement, cw, ch);
  const { frame, ellipses, labels, centers } = buildPosterTemplateParts(selectedPosterTemplate, gw, gh);
  ensureSlotLen();

  Promise.all(centers.map((c, i) => loadImageForSlot(slotUrls[i] ?? null, c, transparentPixel()))).then(
    (imgs) => {
      const objs: fabric.Object[] = [frame];
      for (let i = 0; i < ellipses.length; i++) {
        const im = imgs[i];
        if (im) objs.push(im);
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
let brushKind: 'pen' | 'chubby' | 'pencil' = 'pen';

function updateBrush() {
  const b = new fabric.PencilBrush(canvas);
  b.color = brushColor;
  if (brushKind === 'pen') {
    b.width = brushSize;
    b.decimate = 14;
  } else if (brushKind === 'chubby') {
    b.width = brushSize * 2.6;
    b.decimate = 22;
  } else {
    b.width = brushSize * 0.85;
    b.decimate = 4;
  }
  canvas.freeDrawingBrush = b;
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

  const dur = paths.length > 10 ? 120 : 280;
  const pause = paths.length > 10 ? 12 : 36;

  for (const p of paths) {
    if (!canvas.getObjects().includes(p)) continue;
    await new Promise<void>((resolve) => {
      p.set({ opacity: 1 });
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
            setTimeout(resolve, pause);
          },
        }
      );
    });
  }

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

/* ---------- 初始化 ---------- */
function init() {
  canvas = new fabric.Canvas('main', {
    isDrawingMode: false,
    selection: true,
    preserveObjectStacking: true,
  });
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  canvas.on('path:created', (e: { path?: fabric.Path }) => {
    const p = e.path;
    if (p) drawHistory.push(p);
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
        toast('请先完成第一个写字槽（邪修）');
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

  document.querySelectorAll('#panel-3 .chip').forEach((c) => {
    c.addEventListener('click', () => {
      document.querySelectorAll('#panel-3 .chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      brushKind = (c as HTMLElement).dataset.brush as typeof brushKind;
      updateBrush();
    });
  });
  el('brush-color').addEventListener('input', () => {
    brushColor = (el('brush-color') as HTMLInputElement).value;
    updateBrush();
  });
  el('brush-size').addEventListener('input', () => {
    brushSize = Number((el('brush-size') as HTMLInputElement).value);
    updateBrush();
  });

  el('btn-ref').addEventListener('click', () => {
    refVisible = !refVisible;
    el('ref-label').textContent = refVisible ? '开' : '关';
    applyRefOpacity();
    canvas.renderAll();
  });

  el('btn-undo').addEventListener('click', () => {
    const p = drawHistory.pop();
    if (p && canvas.getObjects().includes(p)) {
      canvas.remove(p);
      canvas.renderAll();
      toast('已撤回');
    } else toast('没有可撤回的笔迹');
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
