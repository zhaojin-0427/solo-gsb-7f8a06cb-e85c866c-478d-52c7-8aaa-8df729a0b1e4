// 图模型与候选验证。
// 关键约束：同一帧内的依赖必须无环；「上一帧」节点的输入边属于反馈边，
// 不参与环检测 —— 反馈在首帧读取透明图，之后读取上一完整帧。

export type NodeType = 'input' | 'colormatrix' | 'blur' | 'prevframe' | 'blend';
export type BlendMode = 'over' | 'add' | 'mix' | 'multiply' | 'screen';

export interface NodeSpec {
  id: string;
  type: NodeType;
  name: string;
  /** 输入槽 -> 源节点 id（null 表示未连接） */
  inputs: Record<string, string | null>;
  /** colormatrix: 4x5，行主序，每行 [r,g,b,a,offset] */
  matrix?: number[];
  /** blur: 0..32 */
  radius?: number;
  /** blend */
  mode?: BlendMode;
  factor?: number;
  /** input: 图像库键 */
  imageKey?: string | null;
}

export interface GraphSpec {
  width: number;
  height: number;
  nodes: NodeSpec[];
  outputId: string | null;
}

export interface ValidationError {
  nodeId: string | null;
  message: string;
}

export interface Validation {
  ok: boolean;
  errors: ValidationError[];
  /** 确定性拓扑序（仅当无环时完整） */
  order: string[];
  /** 被「上一帧」节点引用的源节点（需要双缓冲） */
  feedbackSrcs: Set<string>;
}

export const SLOTS: Record<NodeType, string[]> = {
  input: [],
  colormatrix: ['src'],
  blur: ['src'],
  prevframe: ['src'],
  blend: ['a', 'b'],
};

export const TYPE_LABEL: Record<NodeType, string> = {
  input: '输入图像',
  colormatrix: '颜色矩阵',
  blur: '高斯模糊',
  prevframe: '上一帧',
  blend: '混合',
};

export const BLEND_MODES: BlendMode[] = ['over', 'add', 'mix', 'multiply', 'screen'];

export const BLEND_MODE_LABEL: Record<BlendMode, string> = {
  over: '覆盖 over',
  add: '相加 add',
  mix: '插值 mix',
  multiply: '正片叠底 multiply',
  screen: '滤色 screen',
};

export const IDENTITY_MATRIX: number[] = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

export function cloneSpec(s: GraphSpec): GraphSpec {
  return JSON.parse(JSON.stringify(s)) as GraphSpec;
}

export function validateGraph(spec: GraphSpec, hasImage: (key: string) => boolean): Validation {
  const errors: ValidationError[] = [];
  const byId = new Map<string, NodeSpec>();
  for (const n of spec.nodes) {
    if (byId.has(n.id)) errors.push({ nodeId: n.id, message: `节点 id 重复：${n.id}` });
    byId.set(n.id, n);
  }

  if (
    !Number.isInteger(spec.width) || !Number.isInteger(spec.height) ||
    spec.width < 16 || spec.height < 16 || spec.width > 2048 || spec.height > 2048
  ) {
    errors.push({ nodeId: null, message: `画布尺寸非法：${spec.width}×${spec.height}（需为 16–2048 的整数）` });
  }

  const feedbackSrcs = new Set<string>();

  for (const n of spec.nodes) {
    for (const slot of SLOTS[n.type]) {
      const src = n.inputs[slot];
      if (!src) {
        errors.push({ nodeId: n.id, message: `输入「${slot}」未连接` });
        continue;
      }
      if (!byId.has(src)) {
        errors.push({ nodeId: n.id, message: `输入「${slot}」指向不存在的节点 ${src}` });
        continue;
      }
      if (n.type === 'prevframe') feedbackSrcs.add(src);
    }
    switch (n.type) {
      case 'input':
        if (!n.imageKey) errors.push({ nodeId: n.id, message: '尚未选择图像' });
        else if (!hasImage(n.imageKey)) errors.push({ nodeId: n.id, message: '图像尚未解码完成' });
        break;
      case 'colormatrix':
        if (!n.matrix || n.matrix.length !== 20 || n.matrix.some((v) => !Number.isFinite(v))) {
          errors.push({ nodeId: n.id, message: '颜色矩阵需为 20 个有限数值（4×5）' });
        }
        break;
      case 'blur':
        if (n.radius === undefined || !Number.isFinite(n.radius) || n.radius < 0 || n.radius > 32) {
          errors.push({ nodeId: n.id, message: '模糊半径需为 0–32' });
        }
        break;
      case 'blend':
        if (!n.mode || !BLEND_MODES.includes(n.mode)) {
          errors.push({ nodeId: n.id, message: '混合模式非法' });
        }
        if (n.factor === undefined || !Number.isFinite(n.factor) || n.factor < 0 || n.factor > 1) {
          errors.push({ nodeId: n.id, message: '混合系数需为 0–1' });
        }
        break;
      case 'prevframe':
        break;
    }
  }

  if (!spec.outputId) {
    errors.push({ nodeId: null, message: '未指定输出节点' });
  } else if (!byId.has(spec.outputId)) {
    errors.push({ nodeId: null, message: `输出节点 ${spec.outputId} 不存在` });
  }

  // 拓扑排序：仅使用非反馈边（跳过 prevframe 节点的输入边）。
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of spec.nodes) indeg.set(n.id, 0);
  for (const n of spec.nodes) {
    if (n.type === 'prevframe') continue; // 反馈边：允许成环
    for (const slot of SLOTS[n.type]) {
      const s = n.inputs[slot];
      if (s && byId.has(s)) {
        indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
        const list = adj.get(s) ?? [];
        list.push(n.id);
        adj.set(s, list);
      }
    }
  }
  const queue = spec.nodes.map((n) => n.id).filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const m of adj.get(id) ?? []) {
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length !== spec.nodes.length) {
    const remaining = spec.nodes.filter((n) => !order.includes(n.id)).map((n) => `${n.name}(${n.id})`);
    errors.push({
      nodeId: null,
      message: `检测到循环依赖（非「上一帧」边）：${remaining.join('、')}。同一帧的依赖必须无环；如需反馈请使用「上一帧」节点。`,
    });
  }

  return { ok: errors.length === 0, errors, order, feedbackSrcs };
}
