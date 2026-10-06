// editor.ts —— 节点图编辑器（DOM + SVG）。
// 编辑器直接修改“草稿图”，每次求值相关的修改后调用 hooks.onEdit()，
// 由外层把草稿作为完整候选去验证并原子提交。节点拖动只改坐标，不触发提交。

import {
  Graph, GraphNode, NodeType, Issue, INPUT_PORTS, NODE_LABEL, defaultParams, MAX_BLUR,
} from './graph.js';

export interface EditorHooks {
  onEdit(): void; // 草稿发生求值相关修改（结构 / 参数 / 输出选择）
  onUpload(nodeId: string, file: File): void;
}

const BLEND_MODES = ['over（正常）', 'add（相加）', 'multiply（相乘）', 'screen（滤色）'];

const MATRIX_PRESETS: Record<string, number[]> = {
  '恒等': [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
  '灰度': [
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0.2126, 0.7152, 0.0722, 0, 0,
    0, 0, 0, 1, 0,
  ],
  '反相': [-1, 0, 0, 0, 1, 0, -1, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, 1, 0],
  '褐色': [
    0.393, 0.769, 0.189, 0, 0,
    0.349, 0.686, 0.168, 0, 0,
    0.272, 0.534, 0.131, 0, 0,
    0, 0, 0, 1, 0,
  ],
  '半透明': [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0.5, 0],
  '渐隐 94%': [
    0.94, 0, 0, 0, 0,
    0, 0.94, 0, 0, 0,
    0, 0, 0.94, 0, 0,
    0, 0, 0, 0.94, 0,
  ],
};

type Drag =
  | { kind: 'node'; id: string; dx: number; dy: number }
  | { kind: 'connect'; from: string; removedEdge: boolean };

export class Editor {
  private draft: Graph | null = null;
  private errors: Issue[] = [];
  private warnings: Issue[] = [];
  private hasImage = new Set<string>();

  private canvasEl: HTMLElement;
  private svgEl: SVGSVGElement;
  private nodesEl: HTMLElement;

  private drag: Drag | null = null;
  private mouse = { x: 0, y: 0 };
  private selectedEdge: string | null = null;
  private seq = 1;

  constructor(root: HTMLElement, private hooks: EditorHooks) {
    root.innerHTML =
      '<div class="ed-canvas"><svg class="edges"></svg><div class="nodes"></div></div>';
    this.canvasEl = root.querySelector('.ed-canvas')!;
    this.svgEl = root.querySelector('svg.edges')!;
    this.nodesEl = root.querySelector('.nodes')!;

    document.addEventListener('pointermove', (e) => this.onMove(e));
    document.addEventListener('pointerup', (e) => this.onUp(e));
    document.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Delete' && this.selectedEdge && this.draft) {
        this.removeEdge(this.selectedEdge);
        this.selectedEdge = null;
        this.render();
        this.hooks.onEdit();
      }
    });
  }

  setGraph(g: Graph, hasImage: Set<string>): void {
    this.draft = g;
    this.hasImage = hasImage;
    this.selectedEdge = null;
    this.render();
  }

  setIssues(errors: Issue[], warnings: Issue[]): void {
    this.errors = errors;
    this.warnings = warnings;
    this.applyIssues();
  }

  addNode(type: NodeType): void {
    if (!this.draft) return;
    const id = this.newId('n');
    const k = this.draft.nodes.length;
    this.draft.nodes.push({
      id, type,
      x: 60 + (k * 40) % 420,
      y: 60 + (k * 60) % 360,
      params: defaultParams(type),
    });
    this.render();
    this.hooks.onEdit();
  }

  // ------------------------------------------------------------ 渲染

  private newId(prefix: string): string {
    let id = '';
    do {
      id = prefix + this.seq++;
    } while (
      this.draft!.nodes.some((n) => n.id === id) ||
      this.draft!.edges.some((e) => e.id === id)
    );
    return id;
  }

  private render(): void {
    if (!this.draft) return;
    this.nodesEl.innerHTML = '';
    for (const n of this.draft.nodes) this.nodesEl.appendChild(this.renderNode(n));
    this.renderEdges();
    this.applyIssues();
  }

  private renderNode(n: GraphNode): HTMLElement {
    const draft = this.draft!;
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = n.id;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    if (draft.outputId === n.id) el.classList.add('is-output');

    const head = document.createElement('div');
    head.className = 'nhead';
    const title = document.createElement('span');
    title.className = 'ntitle';
    title.textContent = `${NODE_LABEL[n.type]} `;
    const em = document.createElement('em');
    em.textContent = n.id;
    title.appendChild(em);
    const outBtn = document.createElement('button');
    outBtn.className = 'nout';
    outBtn.title = '设为输出节点';
    outBtn.textContent = draft.outputId === n.id ? '◉' : '◎';
    outBtn.addEventListener('click', () => {
      draft.outputId = n.id;
      this.render();
      this.hooks.onEdit();
    });
    const delBtn = document.createElement('button');
    delBtn.className = 'ndel';
    delBtn.title = '删除节点';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', () => {
      draft.nodes = draft.nodes.filter((x) => x.id !== n.id);
      draft.edges = draft.edges.filter((e) => e.from !== n.id && e.to !== n.id);
      if (draft.outputId === n.id) draft.outputId = null;
      this.render();
      this.hooks.onEdit();
    });
    head.append(title, outBtn, delBtn);
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).tagName === 'BUTTON') return;
      this.drag = { kind: 'node', id: n.id, dx: e.clientX - n.x, dy: e.clientY - n.y };
      e.preventDefault();
    });
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'nbody';

    // 输入端口
    INPUT_PORTS[n.type].forEach((label, i) => {
      const row = document.createElement('div');
      row.className = 'pin';
      const port = document.createElement('span');
      port.className = 'port in';
      port.dataset.node = n.id;
      port.dataset.port = String(i);
      port.title = `输入：${label}`;
      port.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        // 已连接的输入端口：抓起旧边重新连接
        const old = draft.edges.find((ed) => ed.to === n.id && ed.port === i);
        if (old) {
          draft.edges = draft.edges.filter((ed) => ed !== old);
          this.drag = { kind: 'connect', from: old.from, removedEdge: true };
          this.render();
        }
        e.preventDefault();
      });
      row.append(port, document.createTextNode(label));
      body.appendChild(row);
    });

    // 输出端口
    const pout = document.createElement('div');
    pout.className = 'pout';
    const oport = document.createElement('span');
    oport.className = 'port out';
    oport.dataset.node = n.id;
    oport.title = '输出（拖到左侧输入端口连线）';
    oport.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.drag = { kind: 'connect', from: n.id, removedEdge: false };
      e.preventDefault();
    });
    pout.append(document.createTextNode('输出'), oport);
    body.appendChild(pout);

    body.appendChild(this.renderParams(n));
    el.appendChild(body);
    return el;
  }

  private renderParams(n: GraphNode): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'params';
    const changed = () => { this.render(); this.hooks.onEdit(); };

    if (n.type === 'input') {
      const row = document.createElement('div');
      row.className = 'file-row';
      const btn = document.createElement('button');
      btn.textContent = '选择 PNG…';
      const file = document.createElement('input');
      file.type = 'file';
      file.accept = 'image/png,image/*';
      file.hidden = true;
      btn.addEventListener('click', () => file.click());
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (f) this.hooks.onUpload(n.id, f);
        file.value = '';
      });
      const state = document.createElement('span');
      state.className = 'fname';
      state.textContent = this.hasImage.has(n.id) ? '已加载图像' : '未加载（输出透明）';
      row.append(btn, file, state);
      wrap.appendChild(row);
    } else if (n.type === 'matrix') {
      const m = n.params.matrix!;
      const sel = document.createElement('select');
      for (const name of Object.keys(MATRIX_PRESETS)) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        n.params.matrix = [...MATRIX_PRESETS[sel.value]];
        changed();
      });
      wrap.appendChild(sel);
      const grid = document.createElement('div');
      grid.className = 'mgrid';
      for (let i = 0; i < 20; i++) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '0.05';
        inp.value = String(m[i]);
        if (i % 5 === 4) inp.classList.add('off');
        inp.addEventListener('change', () => {
          const v = parseFloat(inp.value);
          m[i] = Number.isFinite(v) ? v : 0;
          changed();
        });
        grid.appendChild(inp);
      }
      wrap.appendChild(grid);
    } else if (n.type === 'blur') {
      const row = document.createElement('div');
      row.className = 'slider-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = String(MAX_BLUR);
      range.step = '1';
      range.value = String(n.params.blur?.radius ?? 0);
      const val = document.createElement('span');
      val.textContent = `半径 ${range.value}`;
      range.addEventListener('input', () => {
        n.params.blur = { radius: parseInt(range.value, 10) };
        val.textContent = `半径 ${range.value}`;
      });
      range.addEventListener('change', () => this.hooks.onEdit());
      row.append(range, val);
      wrap.appendChild(row);
    } else if (n.type === 'blend') {
      const bp = n.params.blend!;
      const sel = document.createElement('select');
      BLEND_MODES.forEach((name, i) => {
        const o = document.createElement('option');
        o.value = String(i);
        o.textContent = name;
        sel.appendChild(o);
      });
      sel.value = String(bp.mode);
      sel.addEventListener('change', () => {
        n.params.blend = { mode: parseInt(sel.value, 10) as typeof bp.mode, factor: bp.factor };
        this.hooks.onEdit();
      });
      const row = document.createElement('div');
      row.className = 'slider-row';
      const range = document.createElement('input');
      range.type = 'range';
      range.min = '0';
      range.max = '1';
      range.step = '0.01';
      range.value = String(bp.factor);
      const val = document.createElement('span');
      val.textContent = `系数 ${bp.factor.toFixed(2)}`;
      range.addEventListener('input', () => {
        n.params.blend = { mode: bp.mode, factor: parseFloat(range.value) };
        val.textContent = `系数 ${parseFloat(range.value).toFixed(2)}`;
      });
      range.addEventListener('change', () => this.hooks.onEdit());
      row.append(range, val);
      wrap.append(sel, row);
    } else if (n.type === 'prev') {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = '输出 = 上一完整帧的反馈源；首帧为透明';
      wrap.appendChild(note);
    }
    return wrap;
  }

  private renderEdges(): void {
    if (!this.draft) return;
    this.svgEl.innerHTML = '';
    for (const e of this.draft.edges) {
      const a = this.portPos(e.from, 'out', 0);
      const b = this.portPos(e.to, 'in', e.port);
      if (!a || !b) continue;
      const p = this.edgePath(a, b);
      p.classList.add('edge');
      if (e.id === this.selectedEdge) p.classList.add('sel');
      p.addEventListener('click', () => {
        this.selectedEdge = e.id;
        this.renderEdges();
      });
      p.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        this.removeEdge(e.id);
        this.render();
        this.hooks.onEdit();
      });
      this.svgEl.appendChild(p);
    }
    if (this.drag?.kind === 'connect') {
      const a = this.portPos(this.drag.from, 'out', 0);
      if (a) {
        const p = this.edgePath(a, this.mouse);
        p.classList.add('edge', 'pending');
        this.svgEl.appendChild(p);
      }
    }
  }

  private edgePath(a: { x: number; y: number }, b: { x: number; y: number }): SVGPathElement {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    p.setAttribute('d', `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`);
    return p;
  }

  private portPos(nodeId: string, kind: 'in' | 'out', port: number): { x: number; y: number } | null {
    const sel = kind === 'in'
      ? `.port.in[data-node="${nodeId}"][data-port="${port}"]`
      : `.port.out[data-node="${nodeId}"]`;
    const el = this.nodesEl.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const rr = this.canvasEl.getBoundingClientRect();
    return { x: r.left + r.width / 2 - rr.left, y: r.top + r.height / 2 - rr.top };
  }

  private removeEdge(id: string): void {
    if (!this.draft) return;
    this.draft.edges = this.draft.edges.filter((e) => e.id !== id);
  }

  // ------------------------------------------------------------ 交互

  private onMove(e: PointerEvent): void {
    const rr = this.canvasEl.getBoundingClientRect();
    this.mouse = { x: e.clientX - rr.left, y: e.clientY - rr.top };
    if (!this.drag || !this.draft) return;
    if (this.drag.kind === 'node') {
      const n = this.draft.nodes.find((x) => x.id === (this.drag as { id: string }).id);
      if (!n) return;
      n.x = Math.max(0, e.clientX - this.drag.dx);
      n.y = Math.max(0, e.clientY - this.drag.dy);
      const el = this.nodesEl.querySelector<HTMLElement>(`.node[data-id="${n.id}"]`);
      if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
      this.renderEdges();
    } else {
      this.renderEdges();
    }
  }

  private onUp(e: PointerEvent): void {
    if (!this.drag || !this.draft) { this.drag = null; return; }
    const drag = this.drag;
    this.drag = null;
    if (drag.kind !== 'connect') return; // 节点拖动不影响求值，不提交
    const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null);
    const portEl = t?.closest?.('.port.in') as HTMLElement | null;
    if (portEl && portEl.dataset.node) {
      const to = portEl.dataset.node;
      const port = parseInt(portEl.dataset.port ?? '0', 10);
      // 同一输入端口只保留一条边（新的替换旧的）
      this.draft.edges = this.draft.edges.filter((ed) => !(ed.to === to && ed.port === port));
      this.draft.edges.push({ id: this.newId('e'), from: drag.from, to, port });
      this.render();
      this.hooks.onEdit();
    } else if (drag.removedEdge) {
      // 抓起旧边但放到了空白处 = 断开
      this.render();
      this.hooks.onEdit();
    } else {
      this.renderEdges();
    }
  }

  // ------------------------------------------------------------ 问题标记

  private applyIssues(): void {
    if (!this.draft) return;
    for (const el of Array.from(this.nodesEl.querySelectorAll('.node'))) {
      el.classList.remove('err', 'warn');
      const old = el.querySelector('.badge');
      if (old) old.remove();
    }
    const mark = (issues: Issue[], cls: string, icon: string) => {
      const byNode = new Map<string, string[]>();
      for (const it of issues) {
        if (!it.nodeId) continue;
        const arr = byNode.get(it.nodeId) ?? [];
        arr.push(it.message);
        byNode.set(it.nodeId, arr);
      }
      for (const [id, msgs] of byNode) {
        const el = this.nodesEl.querySelector<HTMLElement>(`.node[data-id="${id}"]`);
        if (!el) continue;
        el.classList.add(cls);
        const badge = document.createElement('div');
        badge.className = 'badge';
        badge.textContent = `${icon} ${msgs.length}`;
        badge.title = msgs.join('\n');
        el.appendChild(badge);
      }
    };
    mark(this.warnings, 'warn', '⚠');
    mark(this.errors, 'err', '⛔');
  }
}
