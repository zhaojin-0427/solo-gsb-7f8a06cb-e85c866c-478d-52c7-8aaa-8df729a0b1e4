// examples.ts —— 内置示例图与程序化演示图像（不依赖任何外部图像服务）。

import { Graph, GraphNode, Edge, BlendMode } from './graph.js';

function n(id: string, type: GraphNode['type'], x: number, y: number, params: GraphNode['params'] = {}): GraphNode {
  return { id, type, x, y, params };
}

function e(id: string, from: string, to: string, port: number): Edge {
  return { id, from, to, port };
}

export interface Example {
  graph: Graph;
  imageNodeId?: string; // 需要生成演示图像的输入节点
}

// 基础链：输入 -> 模糊 -> 颜色矩阵（灰度）
export function basicExample(): Example {
  return {
    imageNodeId: 'img',
    graph: {
      width: 512, height: 512, outputId: 'mx',
      nodes: [
        n('img', 'input', 40, 220),
        n('bl', 'blur', 280, 220, { blur: { radius: 6 } }),
        n('mx', 'matrix', 500, 220, {
          matrix: [
            0.2126, 0.7152, 0.0722, 0, 0,
            0.2126, 0.7152, 0.0722, 0, 0,
            0.2126, 0.7152, 0.0722, 0, 0,
            0, 0, 0, 1, 0,
          ],
        }),
      ],
      edges: [e('e1', 'img', 'bl', 0), e('e2', 'bl', 'mx', 0)],
    },
  };
}

// 半透明反馈：输入(半透明) 与 渐隐的上一帧 做 over 合成，形成累积残影。
// 环 img -> blend -> prev -> matrix -> blend 经过「上一帧」节点，是合法反馈。
export function feedbackExample(): Example {
  return {
    imageNodeId: 'img',
    graph: {
      width: 512, height: 512, outputId: 'mix',
      nodes: [
        n('img', 'input', 40, 220),
        n('mix', 'blend', 300, 200, { blend: { mode: BlendMode.Over, factor: 1 } }),
        n('fade', 'matrix', 540, 60, {
          matrix: [
            0.94, 0, 0, 0, 0.004,
            0, 0.94, 0, 0, 0.004,
            0, 0, 0.94, 0, 0.004,
            0, 0, 0, 0.94, 0,
          ],
        }),
        n('prev', 'prev', 540, 320),
      ],
      edges: [
        e('e1', 'img', 'mix', 0),
        e('e2', 'fade', 'mix', 1),
        e('e3', 'mix', 'prev', 0),
        e('e4', 'prev', 'fade', 0),
      ],
    },
  };
}

// 循环拒绝：x -> y -> x 不经过「上一帧」，候选会被验证拒绝，旧修订继续运行。
export function cycleExample(): Example {
  return {
    graph: {
      width: 512, height: 512, outputId: 'x',
      nodes: [
        n('x', 'matrix', 220, 160),
        n('y', 'blur', 460, 160, { blur: { radius: 8 } }),
      ],
      edges: [e('e1', 'x', 'y', 0), e('e2', 'y', 'x', 0)],
    },
  };
}

// 程序化生成半透明演示图（alpha≈0.5 的形状 + 标注），无需任何外部资源
export async function makeDemoImage(): Promise<ImageBitmap> {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, S, S);

  x.fillStyle = 'rgba(255,70,60,0.5)';
  x.beginPath();
  x.arc(180, 210, 110, 0, Math.PI * 2);
  x.fill();

  x.fillStyle = 'rgba(60,220,120,0.5)';
  x.fillRect(250, 130, 180, 180);

  x.fillStyle = 'rgba(80,130,255,0.5)';
  x.beginPath();
  x.moveTo(256, 90);
  x.lineTo(380, 330);
  x.lineTo(132, 330);
  x.closePath();
  x.fill();

  x.fillStyle = 'rgba(255,220,80,0.9)';
  x.beginPath();
  x.arc(390, 380, 46, 0, Math.PI * 2);
  x.fill();

  x.fillStyle = 'rgba(255,255,255,0.85)';
  x.font = '26px system-ui, sans-serif';
  x.fillText('α=0.5 半透明演示图', 116, 468);

  return createImageBitmap(c);
}
