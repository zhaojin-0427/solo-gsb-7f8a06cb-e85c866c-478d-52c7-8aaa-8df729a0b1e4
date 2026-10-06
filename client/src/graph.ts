// graph.ts —— 图数据结构与纯校验逻辑。
// 本文件不依赖 DOM / WebGL，可在 Node 中直接单元测试。
//
// 语义约定：
// - 同帧依赖必须无环。指向「上一帧」节点的边是跨帧反馈边，不参与同帧拓扑排序，
//   因此反馈环是合法的；不含「上一帧」节点的环会被拒绝。
// - 所有「上一帧」节点在同一帧内输出的是「上一完整帧」其反馈源的求值结果，
//   首帧输出透明。帧尾统一换页，因此结果与节点遍历顺序无关。

export type NodeType = 'input' | 'matrix' | 'blur' | 'blend' | 'prev';

export interface GraphNode {
  id: string;
  type: NodeType;
  x: number; // 编辑器坐标（不影响求值）
  y: number;
  params: NodeParams;
}

export interface NodeParams {
  matrix?: number[]; // 4x5 行主序：行=输出通道 RGBA，列 0..3=输入通道权重，列 4=偏移
  blur?: { radius: number };
  blend?: { mode: BlendMode; factor: number };
}

export const enum BlendMode {
  Over = 0,
  Add = 1,
  Multiply = 2,
  Screen = 3,
}

export interface Edge {
  id: string;
  from: string; // 源节点（输出端口唯一）
  to: string;   // 目标节点
  port: number; // 目标输入端口下标
}

export interface Graph {
  width: number;
  height: number;
  outputId: string | null; // 预览 / 导出所取的节点
  nodes: GraphNode[];
  edges: Edge[];
}

export const NODE_LABEL: Record<NodeType, string> = {
  input: '输入',
  matrix: '颜色矩阵',
  blur: '模糊',
  blend: '混合',
  prev: '上一帧',
};

export const INPUT_PORTS: Record<NodeType, string[]> = {
  input: [],
  matrix: ['输入'],
  blur: ['输入'],
  blend: ['A（底）', 'B（顶）'],
  prev: ['反馈源'],
};

export const MIN_SIZE = 16;
export const MAX_SIZE = 2048;
export const MAX_BLUR = 32;

export function defaultParams(t: NodeType): NodeParams {
  switch (t) {
    case 'matrix':
      // 恒等 4x5
      return { matrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0] };
    case 'blur':
      return { blur: { radius: 8 } };
    case 'blend':
      return { blend: { mode: BlendMode.Over, factor: 1 } };
    default:
      return {};
  }
}

export function emptyGraph(): Graph {
  return { width: 512, height: 512, outputId: null, nodes: [], edges: [] };
}

export interface Issue {
  nodeId?: string;
  message: string;
}

export interface Validation {
  ok: boolean;
  errors: Issue[];    // 阻断：候选被拒绝，保留旧修订
  warnings: Issue[];  // 非阻断：按透明处理等提示
  order: string[];    // 需要求值的节点的确定性拓扑序
  needed: Set<string>;
  feeds: Map<string, string | null>; // prev 节点 -> 反馈源节点 id（null=未连接）
}

export function validateGraph(
  g: Graph,
  opts?: { hasImage?: (id: string) => boolean },
): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const byId = new Map<string, GraphNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) errors.push({ nodeId: n.id, message: `节点 id 重复：${n.id}` });
    byId.set(n.id, n);
  }

  if (
    !Number.isInteger(g.width) || !Number.isInteger(g.height) ||
    g.width < MIN_SIZE || g.width > MAX_SIZE || g.height < MIN_SIZE || g.height > MAX_SIZE
  ) {
    errors.push({ message: `尺寸必须是 ${MIN_SIZE}..${MAX_SIZE} 的整数（当前 ${g.width}×${g.height}）` });
  }

  // 边合法性
  const portUsed = new Set<string>();
  for (const e of g.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from) { errors.push({ message: `边 ${e.id} 的起点节点不存在` }); continue; }
    if (!to) { errors.push({ message: `边 ${e.id} 的终点节点不存在` }); continue; }
    const ports = INPUT_PORTS[to.type].length;
    if (!Number.isInteger(e.port) || e.port < 0 || e.port >= ports) {
      errors.push({ nodeId: to.id, message: `边连接到不存在的输入端口 ${e.port}` });
      continue;
    }
    const key = `${e.to}:${e.port}`;
    if (portUsed.has(key)) errors.push({ nodeId: e.to, message: '同一输入端口连接了多条边' });
    portUsed.add(key);
  }

  // 同帧依赖图：排除指向「上一帧」节点的边（跨帧反馈不构成同帧依赖）
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of g.nodes) { adj.set(n.id, []); indeg.set(n.id, 0); }
  for (const e of g.edges) {
    const to = byId.get(e.to);
    if (!to || !byId.has(e.from)) continue;
    if (to.type === 'prev') continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  // Kahn 拓扑排序，ready 列表保持有序 => 遍历顺序确定，与编辑顺序无关
  const ready = g.nodes.map((n) => n.id).filter((id) => (indeg.get(id) ?? 0) === 0).sort();
  const topoAll: string[] = [];
  const indeg2 = new Map(indeg);
  while (ready.length) {
    const id = ready.shift()!;
    topoAll.push(id);
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg2.get(nxt) ?? 0) - 1;
      indeg2.set(nxt, d);
      if (d === 0) {
        const i = ready.findIndex((x) => x > nxt);
        if (i < 0) ready.push(nxt); else ready.splice(i, 0, nxt);
      }
    }
  }
  if (topoAll.length < g.nodes.length) {
    const cyc = g.nodes.map((n) => n.id).filter((id) => (indeg2.get(id) ?? 0) > 0);
    errors.push({
      nodeId: cyc[0],
      message: `存在同帧循环依赖（未经过「上一帧」节点）：${cyc.join('、')}。请断开环路，或在环中插入「上一帧」节点。`,
    });
  }

  // 需要求值的节点：输出节点的全部上游（含被需要的 prev 的反馈源上游，递归）
  const badj = new Map<string, string[]>();
  for (const n of g.nodes) badj.set(n.id, []);
  for (const e of g.edges) {
    if (byId.has(e.from) && byId.has(e.to)) badj.get(e.to)!.push(e.from);
  }
  const needed = new Set<string>();
  const stack: string[] = [];
  if (g.outputId) {
    if (!byId.has(g.outputId)) errors.push({ message: '指定的输出节点不存在' });
    else stack.push(g.outputId);
  } else {
    warnings.push({ message: '未选择输出节点：预览为透明，导出不可用' });
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (needed.has(id)) continue;
    needed.add(id);
    for (const up of badj.get(id) ?? []) stack.push(up);
  }

  // 反馈源表
  const feeds = new Map<string, string | null>();
  for (const id of needed) {
    const n = byId.get(id)!;
    if (n.type === 'prev') {
      const e = g.edges.find((ed) => ed.to === id && ed.port === 0);
      feeds.set(id, e ? e.from : null);
      if (!e) warnings.push({ nodeId: id, message: '「上一帧」未连接反馈源，输出恒为透明' });
    }
  }

  const order = topoAll.filter((id) => needed.has(id));

  // 非阻断警告
  if (opts?.hasImage) {
    for (const id of needed) {
      const n = byId.get(id)!;
      if (n.type === 'input' && !opts.hasImage(id)) {
        warnings.push({ nodeId: id, message: '未加载图像，输出透明' });
      }
    }
  }
  for (const id of needed) {
    const n = byId.get(id)!;
    const labels = INPUT_PORTS[n.type];
    for (let p = 0; p < labels.length; p++) {
      if (!g.edges.some((e) => e.to === id && e.port === p)) {
        warnings.push({ nodeId: id, message: `输入端口「${labels[p]}」未连接，按透明处理` });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, order, needed, feeds };
}
