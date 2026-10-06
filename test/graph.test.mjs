// graph.test.mjs —— 图校验纯逻辑的单元测试（先运行 npm run build）
import assert from 'node:assert/strict';
import {
  validateGraph, emptyGraph, defaultParams,
} from '../client/dist/graph.js';

const BLEND_OVER = 0; // BlendMode.Over（const enum 在编译后被擦除）

let passed = 0;
function t(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

function node(id, type, params = defaultParams(type)) {
  return { id, type, x: 0, y: 0, params };
}
function edge(id, from, to, port = 0) {
  return { id, from, to, port };
}
function graph(partial) {
  return { width: 512, height: 512, outputId: null, nodes: [], edges: [], ...partial };
}

console.log('graph 校验逻辑测试');

t('空图合法（带警告）', () => {
  const v = validateGraph(emptyGraph());
  assert.equal(v.ok, true);
  assert.ok(v.warnings.length > 0); // 未选择输出节点
});

t('简单链拓扑序正确', () => {
  const g = graph({
    outputId: 'c',
    nodes: [node('a', 'input'), node('b', 'blur'), node('c', 'matrix')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, true);
  assert.deepEqual(v.order, ['a', 'b', 'c']);
  assert.deepEqual([...v.needed].sort(), ['a', 'b', 'c']);
});

t('同帧环被拒绝（x->y->x）', () => {
  const g = graph({
    outputId: 'x',
    nodes: [node('x', 'matrix'), node('y', 'blur')],
    edges: [edge('e1', 'x', 'y'), edge('e2', 'y', 'x')],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes('循环')));
});

t('经过「上一帧」的环是合法反馈', () => {
  const g = graph({
    outputId: 'mix',
    nodes: [
      node('img', 'input'),
      node('mix', 'blend', { blend: { mode: BLEND_OVER, factor: 1 } }),
      node('fade', 'matrix'),
      node('p', 'prev'),
    ],
    edges: [
      edge('e1', 'img', 'mix', 0),
      edge('e2', 'fade', 'mix', 1),
      edge('e3', 'mix', 'p', 0),
      edge('e4', 'p', 'fade', 0),
    ],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.feeds.get('p'), 'mix');
  // prev 是同帧源点，必须先于其消费者
  assert.ok(v.order.indexOf('p') < v.order.indexOf('fade'));
  assert.ok(v.order.indexOf('fade') < v.order.indexOf('mix'));
});

t('反馈源链即使不在输出上游也被求值', () => {
  // prev 的反馈源是孤立的输入节点，但必须被求值以更新历史
  const g = graph({
    outputId: 'out',
    nodes: [
      node('src', 'input'),
      node('p', 'prev'),
      node('out', 'matrix'),
    ],
    edges: [edge('e1', 'src', 'p', 0), edge('e2', 'p', 'out', 0)],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, true);
  assert.ok(v.needed.has('src'));
  assert.ok(v.order.includes('src'));
});

t('不可达的环同样被拒绝', () => {
  const g = graph({
    outputId: 'out',
    nodes: [node('out', 'matrix'), node('a', 'matrix'), node('b', 'matrix')],
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, false);
});

t('自环被拒绝', () => {
  const g = graph({
    outputId: 'a',
    nodes: [node('a', 'matrix')],
    edges: [edge('e1', 'a', 'a')],
  });
  assert.equal(validateGraph(g).ok, false);
});

t('非法尺寸被拒绝', () => {
  const g = graph({ width: 8, height: 512 });
  const v = validateGraph(g);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes('尺寸')));
});

t('同一输入端口多条边被拒绝', () => {
  const g = graph({
    outputId: 'c',
    nodes: [node('a', 'input'), node('b', 'input'), node('c', 'blur')],
    edges: [edge('e1', 'a', 'c', 0), edge('e2', 'b', 'c', 0)],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, false);
});

t('悬空边被拒绝', () => {
  const g = graph({
    outputId: 'a',
    nodes: [node('a', 'matrix')],
    edges: [edge('e1', 'ghost', 'a', 0)],
  });
  assert.equal(validateGraph(g).ok, false);
});

t('未连接输入产生警告但不阻断', () => {
  const g = graph({
    outputId: 'b',
    nodes: [node('a', 'input'), node('b', 'blend')],
    edges: [edge('e1', 'a', 'b', 0)],
  });
  const v = validateGraph(g, { hasImage: () => true });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.nodeId === 'b' && w.message.includes('未连接')));
});

t('未加载图像的输入节点产生警告', () => {
  const g = graph({
    outputId: 'a',
    nodes: [node('a', 'input')],
    edges: [],
  });
  const v = validateGraph(g, { hasImage: () => false });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.nodeId === 'a' && w.message.includes('未加载')));
});

t('拓扑序确定（与节点声明顺序无关）', () => {
  const mk = (nodes) => graph({
    outputId: 'c',
    nodes,
    edges: [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')],
  });
  const v1 = validateGraph(mk([node('a', 'input'), node('b', 'blur'), node('c', 'matrix')]));
  const v2 = validateGraph(mk([node('c', 'matrix'), node('b', 'blur'), node('a', 'input')]));
  assert.deepEqual(v1.order, v2.order);
});

t('prev 未连接反馈源：警告且 feeds 为 null', () => {
  const g = graph({
    outputId: 'p',
    nodes: [node('p', 'prev')],
    edges: [],
  });
  const v = validateGraph(g);
  assert.equal(v.ok, true);
  assert.equal(v.feeds.get('p'), null);
  assert.ok(v.warnings.some((w) => w.message.includes('反馈源')));
});

console.log(`\n${passed} 个测试通过${process.exitCode ? '，存在失败' : ''}`);
