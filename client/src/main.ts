// main.ts —— 应用装配：草稿编辑 -> 完整候选验证 -> 原子提交新修订（帧归零）。
// 失败时保留旧修订继续运行；旧修订的异步上传/导出回调不会覆盖新结果。

import { Graph, emptyGraph, validateGraph, NodeType } from './graph.js';
import { Engine } from './engine.js';
import { Editor } from './editor.js';
import * as Examples from './examples.js';

function $<T extends HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el as T;
}

// ------------------------------------------------------------ 状态

let engine: Engine | null = null;
let editor: Editor;
let draft: Graph = emptyGraph();
let active: Graph | null = null;   // 正在运行的修订对应的图
let revision = 0;                  // 当前修订号（每次成功提交 +1）
let running = true;
const images = new Map<string, ImageBitmap>(); // nodeId -> CPU 位图（上传后一直持有）
const uploadTokens = new Map<string, number>();
let draftEpoch = 0; // 草稿被整体替换（示例/放弃草稿）时 +1，用于作废旧异步回调

// ------------------------------------------------------------ 提交

// 把草稿作为完整候选验证；成功则原子启用新修订并从第零帧开始，失败保留旧修订。
function commitDraft(): boolean {
  if (!engine) return false;
  const candidate: Graph = structuredClone(draft);
  const v = validateGraph(candidate, { hasImage: (id) => images.has(id) });
  editor.setIssues(v.errors, v.warnings);
  showErrors(v.ok ? [] : v.errors.map((e) => e.message));
  if (!v.ok) {
    setStatus(`候选被拒绝，旧修订 r${revision} 继续运行（帧 ${engine.lastFrame}）`);
    return false;
  }
  try {
    engine.setGraph(candidate, images, v);
  } catch (err) {
    showErrors([`GPU 资源分配失败：${String(err)}`]);
    setStatus(`新修订启用失败，旧修订 r${revision} 继续运行`);
    return false;
  }
  active = candidate;
  revision++;
  // 释放不再属于任何节点的 CPU 位图
  for (const [id, bmp] of images) {
    if (!candidate.nodes.some((n) => n.id === id)) {
      bmp.close();
      images.delete(id);
    }
  }
  setStatus(`修订 r${revision} 已启用，从第 0 帧开始`);
  return true;
}

// ------------------------------------------------------------ 上传（异步回调防护）

async function onUpload(nodeId: string, file: File): Promise<void> {
  const tok = (uploadTokens.get(nodeId) ?? 0) + 1;
  uploadTokens.set(nodeId, tok);
  const epoch = draftEpoch;
  setStatus(`解码图像 ${file.name} …`);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    try {
      bmp = await createImageBitmap(file);
    } catch {
      setStatus(`图像解码失败：${file.name}`);
      return;
    }
  }
  // 旧修订的异步回调不得覆盖新结果：
  // 1) 同一节点已有更新的上传；2) 草稿已被整体替换；3) 节点已不在草稿中
  if (uploadTokens.get(nodeId) !== tok || epoch !== draftEpoch ||
      !draft.nodes.some((n) => n.id === nodeId)) {
    bmp.close();
    setStatus('已丢弃过期的上传结果');
    return;
  }
  images.get(nodeId)?.close();
  images.set(nodeId, bmp);
  commitDraft();
}

// ------------------------------------------------------------ 导出（同步捕获像素）

function doExport(): void {
  if (!engine) return;
  const f = engine.exportFrame(); // 像素在此刻同步捕获，不受后续修订影响
  if (!f) {
    setStatus('没有可导出的帧（请先让至少一帧完成，并选择输出节点）');
    return;
  }
  const frameNo = engine.lastFrame;
  const rev = revision;
  const c = document.createElement('canvas');
  c.width = f.width;
  c.height = f.height;
  c.getContext('2d')!.putImageData(
    new ImageData(new Uint8ClampedArray(f.data.buffer), f.width, f.height), 0, 0,
  );
  c.toBlob((b) => {
    if (!b) return;
    // 该回调只下载自己捕获的快照，不读写任何当前状态
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `frame-${String(frameNo).padStart(4, '0')}-r${rev}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(`已导出第 ${frameNo} 帧（修订 r${rev}，sRGB PNG）`);
  }, 'image/png');
}

// ------------------------------------------------------------ 示例

async function loadExample(kind: 'basic' | 'feedback' | 'cycle'): Promise<void> {
  const ex = kind === 'basic' ? Examples.basicExample()
    : kind === 'feedback' ? Examples.feedbackExample()
    : Examples.cycleExample();
  const myEpoch = ++draftEpoch;
  draft = ex.graph;
  $<HTMLInputElement>('#in-w').value = String(draft.width);
  $<HTMLInputElement>('#in-h').value = String(draft.height);
  // 清理不再属于草稿的位图
  for (const [id, bmp] of images) {
    if (!draft.nodes.some((n) => n.id === id)) { bmp.close(); images.delete(id); }
  }
  editor.setGraph(draft, new Set(images.keys()));
  commitDraft(); // 先提交结构（循环示例会在这里被拒绝，旧修订继续运行）
  if (ex.imageNodeId) {
    try {
      const bmp = await Examples.makeDemoImage();
      if (myEpoch !== draftEpoch) { bmp.close(); return; } // 已被更新的替换作废
      images.get(ex.imageNodeId)?.close();
      images.set(ex.imageNodeId, bmp);
      editor.setGraph(draft, new Set(images.keys()));
      commitDraft(); // 图像就绪，再启用一个修订
    } catch {
      setStatus('演示图像生成失败');
    }
  }
}

// ------------------------------------------------------------ UI 辅助

function setStatus(msg: string): void {
  $('#status-line').textContent = msg;
}

function showErrors(msgs: string[]): void {
  const bar = $('#error-bar');
  if (!msgs.length) {
    bar.hidden = true;
    bar.textContent = '';
  } else {
    bar.hidden = false;
    bar.textContent = `⛔ ${msgs.join('；')}`;
  }
}

function updateHud(): void {
  if (!engine) return;
  const s = engine.stats();
  $('#st-state').textContent = engine.lost ? '⚠ 上下文丢失' : running ? '▶ 运行中' : '⏸ 已暂停';
  $('#st-frame').textContent = `帧 ${engine.lastFrame < 0 ? '—' : engine.lastFrame}`;
  $('#st-rev').textContent = `修订 r${revision}`;
  $('#st-pool').textContent =
    `纹理池 在用${s.poolInUse}/空闲${s.poolFree} · 反馈${s.histories} · 输入${s.inputs}`;
}

function updateLostUI(): void {
  $('#lost-banner').hidden = !engine?.lost;
  updateHud();
}

// ------------------------------------------------------------ 启动

function main(): void {
  const canvas = $<HTMLCanvasElement>('#preview');
  try {
    engine = new Engine(canvas);
  } catch (err) {
    const fatal = $('#fatal');
    fatal.hidden = false;
    fatal.textContent = `无法初始化 WebGL2：${String(err)}`;
    return;
  }
  engine.onStateChange = updateLostUI;

  editor = new Editor($('#editor'), {
    onEdit: () => commitDraft(),
    onUpload: (id, file) => { void onUpload(id, file); },
  });
  editor.setGraph(draft, new Set());

  // 节点面板
  document.querySelectorAll<HTMLButtonElement>('#palette [data-add]').forEach((b) => {
    b.addEventListener('click', () => editor.addNode(b.dataset.add as NodeType));
  });

  // 播放控制：暂停 / 单步 / 导出 / 恢复运行，共用同一帧编号
  const playBtn = $<HTMLButtonElement>('#btn-play');
  playBtn.addEventListener('click', () => {
    running = !running;
    playBtn.textContent = running ? '暂停' : '继续';
    setStatus(running ? `从第 ${engine!.frame} 帧继续运行` : `暂停在第 ${engine!.lastFrame} 帧`);
  });
  $('#btn-step').addEventListener('click', () => {
    if (running) {
      running = false;
      playBtn.textContent = '继续';
    }
    if (!engine!.lost) {
      engine!.runFrame();
      setStatus(`单步：已渲染第 ${engine!.lastFrame} 帧`);
    }
  });
  $('#btn-export').addEventListener('click', doExport);

  // 尺寸：作为候选的一部分验证，成功后从第零帧启用新修订
  const wIn = $<HTMLInputElement>('#in-w');
  const hIn = $<HTMLInputElement>('#in-h');
  const applySize = () => {
    const w = parseInt(wIn.value, 10);
    const h = parseInt(hIn.value, 10);
    if (w === draft.width && h === draft.height) return; // 未变化不触发新修订
    draft.width = w;
    draft.height = h;
    commitDraft();
  };
  wIn.addEventListener('change', applySize);
  hIn.addEventListener('change', applySize);

  // 上下文丢失模拟
  $('#btn-lose').addEventListener('click', () => {
    if (!engine!.simulateLoss()) setStatus('当前环境不支持 WEBGL_lose_context 扩展');
  });
  $('#btn-restore').addEventListener('click', () => engine!.restore());

  // 示例
  $('#ex-basic').addEventListener('click', () => { void loadExample('basic'); });
  $('#ex-feedback').addEventListener('click', () => { void loadExample('feedback'); });
  $('#ex-cycle').addEventListener('click', () => { void loadExample('cycle'); });

  // 放弃草稿：回到活动修订的内容（不触发新修订）
  $('#btn-revert').addEventListener('click', () => {
    draft = active ? structuredClone(active) : emptyGraph();
    draftEpoch++;
    wIn.value = String(draft.width);
    hIn.value = String(draft.height);
    editor.setGraph(draft, new Set(images.keys()));
    const v = validateGraph(draft, { hasImage: (id) => images.has(id) });
    editor.setIssues(v.errors, v.warnings);
    showErrors([]);
    setStatus(`已放弃草稿更改，回到修订 r${revision}`);
  });

  // 主循环
  const loop = () => {
    requestAnimationFrame(loop);
    if (!engine) return;
    if (running && !engine.lost) {
      try {
        engine.runFrame();
      } catch (err) {
        running = false;
        playBtn.textContent = '继续';
        showErrors([`渲染出错，已暂停：${String(err)}`]);
      }
    }
    engine.present();
    updateHud();
  };
  loop();

  // 初始加载半透明反馈示例，立即可见反馈累积效果
  void loadExample('feedback');
}

main();
