// 应用编排：编辑器状态、修订提交、帧循环、上下文丢失恢复、导出与 UI。
//
// 关键不变量：
// - 任何图/尺寸修改都先整体验证候选；通过则以新修订从第 0 帧启用，失败则保留旧修订继续运行。
// - 帧号 completedFrames 是唯一事实来源：暂停/单步/导出/恢复共用同一计数。
// - 异步回调（上传解码、导出 toBlob）携带序号/先同步取数，旧回调不得覆盖新结果。
// - 上下文丢失后：重建 GL 资源，确定性重放 0..completedFrames-1 帧以恢复反馈状态，
//   计数器不变 —— 反馈不会被重复推进。

import {
  BLEND_MODES,
  BLEND_MODE_LABEL,
  cloneSpec,
  GraphSpec,
  IDENTITY_MATRIX,
  NodeSpec,
  NodeType,
  SLOTS,
  TYPE_LABEL,
  validateGraph,
  Validation,
} from './graph';
import { Engine, RevisionRes } from './gpu';

// ---------------- 状态 ----------------
const canvas = document.getElementById('view') as HTMLCanvasElement;
let engine: Engine;

let spec: GraphSpec; // 编辑器中的候选图
let applied: {
  spec: GraphSpec;
  order: string[];
  feedbackSrcs: Set<string>;
  rev: number;
  res: RevisionRes;
} | null = null;
let lastValid: { spec: GraphSpec; order: string[]; feedbackSrcs: Set<string> } | null = null;
let lastValidation: Validation | null = null;
let revCounter = 0;
let completedFrames = 0;
let running = false;
let contextLost = false;
let previewId: string | null = null;
let idSeq = 0;
let uploadSeq = 0;
const images = new Map<string, ImageBitmap>();
const uploadErrors = new Map<string, string>();
const cardEls = new Map<string, HTMLElement>();
const slotEls = new Map<string, HTMLElement>();

const $ = (id: string) => document.getElementById(id)!;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value') (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) el.append(c);
  return el;
}

// ---------------- 修订提交 ----------------
function commitFromLastValid(): void {
  if (!lastValid) return;
  revCounter++;
  if (applied) {
    engine.disposeRevision(applied.res); // 释放旧修订（含被移除节点）的全部 GPU 资源
    console.info(`[gpu] 已释放修订 #${applied.rev} 的资源`);
  }
  const res = engine.buildRevision(lastValid.spec, lastValid.order, lastValid.feedbackSrcs, revCounter, images);
  applied = { spec: cloneSpec(lastValid.spec), order: lastValid.order, feedbackSrcs: lastValid.feedbackSrcs, rev: revCounter, res };
  canvas.width = lastValid.spec.width;
  canvas.height = lastValid.spec.height;
  completedFrames = 0;
  advanceFrame(); // 立即渲染第 0 帧
  console.info(`[gpu] 修订 #${revCounter} 已启用（帧计数归零）`);
}

function tryApply(): void {
  const v = validateGraph(spec, (k) => images.has(k));
  lastValidation = v;
  if (v.ok) {
    lastValid = { spec: cloneSpec(spec), order: v.order, feedbackSrcs: v.feedbackSrcs };
    if (!contextLost) commitFromLastValid();
  }
  renderUI();
}

// ---------------- 帧推进 ----------------
function currentFrameTex(): WebGLTexture | null {
  if (!applied || completedFrames === 0) return null;
  const id = previewId && applied.res.nodeRT.has(previewId) ? previewId : applied.spec.outputId;
  if (!id) return null;
  const nrt = applied.res.nodeRT.get(id);
  if (!nrt) return null;
  return nrt.rts[nrt.pingpong ? (completedFrames - 1) & 1 : 0].tex;
}

function displayCurrent(): void {
  const tex = currentFrameTex();
  if (tex) engine.display(tex);
}

function advanceFrame(): void {
  if (!applied || contextLost) return;
  engine.renderFrame(applied.res, completedFrames);
  completedFrames++;
  displayCurrent();
  setStatus();
}

let lastTick = 0;
function tick(t: number): void {
  requestAnimationFrame(tick);
  if (!running || contextLost || !applied) return;
  if (t - lastTick >= 33) {
    lastTick = t;
    advanceFrame();
  }
}

// ---------------- 导出（同步取数，异步仅做编码） ----------------
function exportPNG(): void {
  if (!applied || contextLost || completedFrames === 0) return;
  const rev = applied.rev;
  const frame = completedFrames - 1;
  const { width: w, height: hgt } = applied.spec;
  const tex = currentFrameTex();
  if (!tex) return;
  const px = engine.exportPixels(tex, w, hgt); // 同步完成，之后图如何变化都不影响本次导出
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = hgt;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, hgt);
  for (let y = 0; y < hgt; y++) {
    // readPixels 自底向上，翻转为 PNG 的自顶向下
    const src = (hgt - 1 - y) * w * 4;
    img.data.set(px.subarray(src, src + w * 4), y * w * 4);
  }
  ctx.putImageData(img, 0, 0);
  cv.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `graph-r${rev}-f${frame}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------------- 上下文丢失 / 恢复 ----------------
function onContextLost(e: Event): void {
  e.preventDefault();
  contextLost = true;
  setStatus();
  renderUI();
}

function onContextRestored(): void {
  contextLost = false;
  engine.createGLResources();
  if (lastValid && (!applied || JSON.stringify(lastValid.spec) !== JSON.stringify(applied.spec))) {
    // 丢失期间产生了新的有效候选：以新修订从第 0 帧启用
    commitFromLastValid();
  } else if (applied) {
    // 重建资源并确定性重放到最近完成帧；帧计数不变，反馈不重复推进
    applied.res = engine.buildRevision(applied.spec, applied.order, applied.feedbackSrcs, applied.rev, images);
    for (let f = 0; f < completedFrames; f++) engine.renderFrame(applied.res, f);
    displayCurrent();
    console.info(`[gpu] 上下文恢复：已重放 ${completedFrames} 帧，继续于帧 #${completedFrames}`);
  }
  setStatus();
  renderUI();
}

// ---------------- 上传（异步回调带序号，旧回调丢弃） ----------------
function handleUpload(nodeId: string, file: File): void {
  const seq = ++uploadSeq;
  uploadErrors.delete(nodeId);
  createImageBitmap(file)
    .then((bmp) => {
      if (seq !== uploadSeq) {
        bmp.close(); // 已有更新的上传在进行/完成，丢弃旧结果
        return;
      }
      const key = `img-${nodeId}`;
      images.get(key)?.close();
      images.set(key, bmp);
      const n = spec.nodes.find((x) => x.id === nodeId);
      if (n && n.type === 'input') n.imageKey = key; // 合并进当前候选，而非回滚到旧修订
      tryApply();
    })
    .catch(() => {
      if (seq !== uploadSeq) return;
      uploadErrors.set(nodeId, '图像解码失败（请选择 PNG/JPEG 等位图）');
      renderUI();
    });
}

// ---------------- 示例 ----------------
function exampleFeedbackSpec(): GraphSpec {
  return {
    width: 512,
    height: 512,
    nodes: [
      { id: 'n_in', type: 'input', name: '输入图像', inputs: {}, imageKey: 'demo' },
      { id: 'n_prev', type: 'prevframe', name: '上一帧', inputs: { src: 'n_mix' } },
      { id: 'n_blur', type: 'blur', name: '柔化', inputs: { src: 'n_prev' }, radius: 6 },
      {
        id: 'n_fade', type: 'colormatrix', name: '衰减 0.94', inputs: { src: 'n_blur' },
        matrix: [
          0.94, 0, 0, 0, 0,
          0, 0.94, 0, 0, 0,
          0, 0, 0.94, 0, 0,
          0, 0, 0, 0.94, 0,
        ],
      },
      { id: 'n_mix', type: 'blend', name: '叠加 over', inputs: { a: 'n_in', b: 'n_fade' }, mode: 'over', factor: 1 },
    ],
    outputId: 'n_mix',
  };
}

function exampleCycleSpec(): GraphSpec {
  return {
    width: 512,
    height: 512,
    nodes: [
      { id: 'c_a', type: 'colormatrix', name: 'A 矩阵', inputs: { src: 'c_b' }, matrix: IDENTITY_MATRIX.slice() },
      { id: 'c_b', type: 'blend', name: 'B 混合', inputs: { a: 'c_a', b: 'c_a' }, mode: 'over', factor: 1 },
    ],
    outputId: 'c_a',
  };
}

async function makeDemoImage(): Promise<ImageBitmap> {
  const c = new OffscreenCanvas(512, 512);
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, 512, 512);
  g.addColorStop(0, 'rgba(40,90,220,0.85)');
  g.addColorStop(1, 'rgba(200,40,140,0.55)');
  x.fillStyle = g;
  x.fillRect(0, 0, 512, 512);
  const blobs: [number, number, number, string][] = [
    [150, 160, 90, 'rgba(255,220,80,0.75)'],
    [330, 200, 110, 'rgba(80,255,190,0.6)'],
    [250, 360, 100, 'rgba(255,255,255,0.5)'],
  ];
  for (const [cx, cy, r, col] of blobs) {
    const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    rg.addColorStop(0, col);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = rg;
    x.beginPath();
    x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.font = 'bold 56px system-ui, sans-serif';
  x.fillText('DEMO', 160, 280);
  return createImageBitmap(c);
}

// ---------------- UI ----------------
function setStatus(): void {
  const parts = [
    `修订 #${applied ? applied.rev : '—'}`,
    `帧 #${completedFrames > 0 ? completedFrames - 1 : '—'}（下一帧 ${completedFrames}）`,
    running ? '运行中' : '已暂停',
    engine && engine.useFloat ? 'RGBA16F 线性' : 'RGBA8 线性（回退）',
    engine ? `GPU 纹理 ${engine.texCount}` : '',
  ];
  if (contextLost) parts.push('⚠ 上下文已丢失');
  $('status').textContent = parts.filter(Boolean).join(' · ');
  ($('btnRun') as HTMLButtonElement).textContent = running ? '暂停' : '继续';
}

function renderErrors(): void {
  const box = $('errors');
  box.innerHTML = '';
  const items: string[] = [];
  if (lastValidation && !lastValidation.ok) {
    for (const e of lastValidation.errors) {
      const name = e.nodeId ? (spec.nodes.find((n) => n.id === e.nodeId)?.name ?? e.nodeId) : '图';
      items.push(`[${name}] ${e.message}`);
    }
  }
  for (const [nodeId, msg] of uploadErrors) {
    const name = spec.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
    items.push(`[${name}] ${msg}`);
  }
  if (items.length === 0) {
    box.append(h('div', { class: 'ok' }, ['✓ 候选图有效，已作为当前修订运行']));
    return;
  }
  box.append(
    h('div', { class: 'err-banner' }, [
      `✗ 候选未通过验证（${items.length} 项）——已保留修订 #${applied ? applied.rev : '—'} 的可用状态`,
    ]),
  );
  for (const it of items) box.append(h('div', { class: 'err-item' }, [it]));
}

function nodeErrors(id: string): string[] {
  if (!lastValidation) return [];
  return lastValidation.errors.filter((e) => e.nodeId === id).map((e) => e.message);
}

function defaultNode(type: NodeType): NodeSpec {
  const id = `n${++idSeq}`;
  switch (type) {
    case 'input':
      return { id, type, name: '输入图像', inputs: {}, imageKey: null };
    case 'colormatrix':
      return { id, type, name: '颜色矩阵', inputs: { src: null }, matrix: IDENTITY_MATRIX.slice() };
    case 'blur':
      return { id, type, name: '高斯模糊', inputs: { src: null }, radius: 4 };
    case 'prevframe':
      return { id, type, name: '上一帧', inputs: { src: null } };
    case 'blend':
      return { id, type, name: '混合', inputs: { a: null, b: null }, mode: 'over', factor: 0.5 };
  }
}

function deleteNode(id: string): void {
  spec.nodes = spec.nodes.filter((n) => n.id !== id);
  for (const n of spec.nodes) {
    for (const s of Object.keys(n.inputs)) {
      if (n.inputs[s] === id) n.inputs[s] = null;
    }
  }
  if (spec.outputId === id) spec.outputId = null;
  if (previewId === id) previewId = null;
  tryApply();
}

function slotSelect(node: NodeSpec, slot: string): HTMLElement {
  const sel = h('select', {
    onchange: (e: Event) => {
      node.inputs[slot] = (e.target as HTMLSelectElement).value || null;
      tryApply();
    },
  });
  sel.append(h('option', { value: '' }, ['（未连接）']));
  for (const other of spec.nodes) {
    if (other.id === node.id && node.type !== 'prevframe') continue; // 普通槽禁止直连自身；反馈允许
    const o = h('option', { value: other.id }, [`${other.name} (${other.id})`]);
    if (node.inputs[slot] === other.id) o.selected = true;
    sel.append(o);
  }
  return sel;
}

function nodeBody(node: NodeSpec): HTMLElement {
  const body = h('div', { class: 'card-body' });
  switch (node.type) {
    case 'input': {
      const file = h('input', { type: 'file', accept: 'image/png,image/*' });
      file.addEventListener('change', () => {
        const f = file.files?.[0];
        if (f) handleUpload(node.id, f);
      });
      body.append(file);
      body.append(
        h('div', { class: 'muted' }, [
          node.imageKey && images.has(node.imageKey) ? '已加载图像' : '未加载图像（候选将被拒绝）',
        ]),
      );
      const ue = uploadErrors.get(node.id);
      if (ue) body.append(h('div', { class: 'err-item' }, [ue]));
      break;
    }
    case 'colormatrix': {
      const grid = h('div', { class: 'matrix' });
      const m = node.matrix!;
      for (let i = 0; i < 20; i++) {
        if (i % 5 === 4) grid.append(h('span', { class: 'plus' }, ['+']));
        const inp = h('input', { type: 'number', step: '0.05', value: String(m[i]), class: 'mcell' });
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          node.matrix![i] = Number.isFinite(v) ? v : 0;
          tryApply();
        });
        grid.append(inp);
      }
      body.append(grid);
      body.append(h('div', { class: 'muted' }, ['行：R G B A +偏移（线性预乘空间）']));
      break;
    }
    case 'blur': {
      const val = h('span', { class: 'val' }, [String(node.radius ?? 0)]);
      const range = h('input', { type: 'range', min: '0', max: '32', step: '1', value: String(node.radius ?? 0) });
      range.addEventListener('input', () => {
        val.textContent = (range as HTMLInputElement).value;
      });
      range.addEventListener('change', () => {
        node.radius = parseInt((range as HTMLInputElement).value, 10);
        tryApply();
      });
      body.append(h('div', { class: 'row' }, [h('label', {}, ['半径']), range, val]));
      break;
    }
    case 'blend': {
      const sel = h('select', {
        onchange: (e: Event) => {
          node.mode = (e.target as HTMLSelectElement).value as NodeSpec['mode'];
          tryApply();
        },
      });
      for (const md of BLEND_MODES) {
        const o = h('option', { value: md }, [BLEND_MODE_LABEL[md]]);
        if (node.mode === md) o.selected = true;
        sel.append(o);
      }
      const val = h('span', { class: 'val' }, [String(node.factor ?? 0)]);
      const range = h('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(node.factor ?? 0) });
      range.addEventListener('input', () => {
        val.textContent = (range as HTMLInputElement).value;
      });
      range.addEventListener('change', () => {
        node.factor = parseFloat((range as HTMLInputElement).value);
        tryApply();
      });
      body.append(h('div', { class: 'row' }, [h('label', {}, ['模式']), sel]));
      body.append(h('div', { class: 'row' }, [h('label', {}, ['a 占比']), range, val]));
      break;
    }
    case 'prevframe':
      body.append(h('div', { class: 'muted' }, ['输出 = 输入在上一完整帧的值；第 0 帧为透明。反馈边不参与同帧环检测。']));
      break;
  }
  return body;
}

function renderNodeList(): void {
  const list = $('nodeList');
  list.innerHTML = '';
  cardEls.clear();
  slotEls.clear();
  for (const node of spec.nodes) {
    const card = h('div', { class: 'card' + (previewId === node.id ? ' previewing' : '') });
    cardEls.set(node.id, card);

    const nameInp = h('input', { class: 'name', value: node.name });
    nameInp.addEventListener('change', () => {
      node.name = nameInp.value;
      tryApply();
    });
    const outRadio = h('input', { type: 'radio', name: 'outputNode', checked: spec.outputId === node.id });
    outRadio.addEventListener('change', () => {
      spec.outputId = node.id;
      tryApply();
    });
    const head = h('div', { class: 'card-head' }, [
      h('span', { class: `badge t-${node.type}` }, [TYPE_LABEL[node.type]]),
      nameInp,
      h('label', { class: 'out' }, [outRadio, '输出']),
      h('button', {
        class: 'mini', title: '在画布中预览该节点',
        onclick: () => {
          previewId = node.id;
          displayCurrent();
          renderUI();
        },
      }, ['预览']),
      h('button', { class: 'mini danger', title: '删除节点', onclick: () => deleteNode(node.id) }, ['×']),
    ]);
    card.append(head);
    card.append(nodeBody(node));

    const slots = SLOTS[node.type];
    if (slots.length) {
      const box = h('div', { class: 'slots' });
      for (const slot of slots) {
        const row = h('div', { class: 'slot' + (node.type === 'prevframe' ? ' feedback' : '') }, [
          h('span', { class: 'slot-name' }, [node.type === 'prevframe' ? `${slot}（上一帧）` : slot]),
          slotSelect(node, slot),
        ]);
        slotEls.set(`${node.id}:${slot}`, row);
        box.append(row);
      }
      card.append(box);
    }

    const errs = nodeErrors(node.id);
    if (errs.length) {
      const eb = h('div', { class: 'node-errs' });
      for (const e of errs) eb.append(h('div', { class: 'err-item' }, [e]));
      card.append(eb);
    }
    list.append(card);
  }
}

function drawEdges(): void {
  const svg = $('edges') as unknown as SVGSVGElement;
  const list = $('nodeList');
  svg.innerHTML = '';
  const w = list.offsetWidth;
  const hgt = list.offsetHeight;
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(hgt));
  svg.style.width = `${w}px`;
  svg.style.height = `${hgt}px`;
  const NS = 'http://www.w3.org/2000/svg';
  for (const node of spec.nodes) {
    for (const slot of SLOTS[node.type]) {
      const src = node.inputs[slot];
      if (!src) continue;
      const fromCard = cardEls.get(src);
      const toCard = cardEls.get(node.id);
      const toSlot = slotEls.get(`${node.id}:${slot}`);
      if (!fromCard || !toCard || !toSlot) continue;
      const x1 = fromCard.offsetLeft + fromCard.offsetWidth;
      const y1 = fromCard.offsetTop + fromCard.offsetHeight / 2;
      const x2 = toCard.offsetLeft;
      const y2 = toCard.offsetTop + toSlot.offsetTop + toSlot.offsetHeight / 2;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`);
      p.setAttribute('class', 'edge' + (node.type === 'prevframe' ? ' feedback' : ''));
      svg.append(p);
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('cx', String(x2));
      dot.setAttribute('cy', String(y2));
      dot.setAttribute('r', '3');
      dot.setAttribute('class', 'edge-dot' + (node.type === 'prevframe' ? ' feedback' : ''));
      svg.append(dot);
    }
  }
}

function renderUI(): void {
  setStatus();
  renderErrors();
  renderNodeList();
  requestAnimationFrame(drawEdges);
}

// ---------------- 启动 ----------------
function wireToolbar(): void {
  $('btnRun').addEventListener('click', () => {
    running = !running;
    setStatus();
  });
  $('btnStep').addEventListener('click', () => {
    running = false;
    advanceFrame();
    setStatus();
  });
  $('btnExport').addEventListener('click', exportPNG);
  $('btnLoss').addEventListener('click', () => engine.loseContext());
  $('btnRestore').addEventListener('click', () => engine.restoreContext());
  $('btnExampleFeedback').addEventListener('click', () => {
    spec = exampleFeedbackSpec();
    previewId = null;
    tryApply();
  });
  $('btnExampleCycle').addEventListener('click', () => {
    spec = exampleCycleSpec();
    previewId = null;
    tryApply();
  });
  const wInp = $('sizeW') as HTMLInputElement;
  const hInp = $('sizeH') as HTMLInputElement;
  const onSize = () => {
    spec.width = parseInt(wInp.value, 10);
    spec.height = parseInt(hInp.value, 10);
    tryApply();
  };
  wInp.addEventListener('change', onSize);
  hInp.addEventListener('change', onSize);
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#addNode button')) {
    btn.addEventListener('click', () => {
      spec.nodes.push(defaultNode(btn.dataset.type as NodeType));
      tryApply();
    });
  }
}

async function boot(): Promise<void> {
  engine = new Engine(canvas);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  images.set('demo', await makeDemoImage());
  spec = exampleFeedbackSpec();
  wireToolbar();
  ($('sizeW') as HTMLInputElement).value = String(spec.width);
  ($('sizeH') as HTMLInputElement).value = String(spec.height);
  tryApply();
  running = true;
  setStatus();
  requestAnimationFrame(tick);
}

boot().catch((e) => {
  $('errors').append(h('div', { class: 'err-banner' }, [`初始化失败：${e instanceof Error ? e.message : String(e)}`]));
});
