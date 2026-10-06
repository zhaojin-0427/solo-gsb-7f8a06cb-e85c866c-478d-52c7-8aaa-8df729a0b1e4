// engine.test.mjs —— 用伪 WebGL2 上下文在 Node 中驱动 Engine 的集成测试。
// 验证：帧计数、反馈双缓冲换页、纹理池平衡、修订资源释放、
//       上下文丢失/恢复不重复推进反馈、导出行翻转、同帧不读写同一纹理。
import assert from 'node:assert/strict';
import { validateGraph } from '../client/dist/graph.js';
import { Engine } from '../client/dist/engine.js';

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

// ------------------------------------------------------------ 伪 GL

const C = {
  VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
  FRAMEBUFFER: 5, COLOR_ATTACHMENT0: 6, TEXTURE_2D: 7, RGBA8: 8, RGBA: 9,
  UNSIGNED_BYTE: 10, TEXTURE_MIN_FILTER: 11, TEXTURE_MAG_FILTER: 12,
  TEXTURE_WRAP_S: 13, TEXTURE_WRAP_T: 14, LINEAR: 15, NEAREST: 16,
  CLAMP_TO_EDGE: 17, BLEND: 18, DEPTH_TEST: 19, TRIANGLES: 20, TEXTURE0: 21,
  UNPACK_FLIP_Y_WEBGL: 22, SRGB8_ALPHA8: 23, COLOR_BUFFER_BIT: 24,
};

class FakeGL {
  constructor() {
    this.texSeq = 0;
    this.readPixelsCount = 0;
    this.draws = 0;
    this.fboAttachment = null;
    this.boundTex = new Map(); // unit -> tex
    this.activeUnit = 0;
    this.deletedTextures = [];
    this.loseExt = {
      lost: false,
      loseContext: () => { this.loseExt.lost = true; },
      restoreContext: () => { this.loseExt.lost = false; },
    };
    Object.assign(this, C);
  }
  getExtension(name) { return name === 'WEBGL_lose_context' ? this.loseExt : null; }
  createShader() { return {}; }
  shaderSource() {}
  compileShader() {}
  getShaderParameter() { return true; }
  getShaderInfoLog() { return ''; }
  deleteShader() {}
  createProgram() { return {}; }
  attachShader() {}
  linkProgram() {}
  getProgramParameter() { return true; }
  getProgramInfoLog() { return ''; }
  getUniformLocation() { return {}; }
  createFramebuffer() { return { id: 'fbo' }; }
  bindFramebuffer(target, fbo) { if (!fbo) this.fboAttachment = null; }
  framebufferTexture2D(target, attach, texTarget, tex) { this.fboAttachment = tex; }
  createTexture() { return { id: ++this.texSeq }; }
  bindTexture(target, tex) { this.boundTex.set(this.activeUnit, tex); }
  texImage2D() {}
  texParameteri() {}
  pixelStorei() {}
  disable() {}
  useProgram() {}
  activeTexture(u) { this.activeUnit = u - C.TEXTURE0; }
  uniform1i() {}
  uniform1f() {}
  uniform2f() {}
  uniform4f() {}
  uniform1fv() {}
  uniformMatrix4fv() {}
  viewport() {}
  clearColor() {}
  clear() {}
  deleteTexture(tex) { this.deletedTextures.push(tex); }
  drawArrays() {
    this.draws++;
    // 不变量：一次绘制不得读写同一纹理
    for (const tex of this.boundTex.values()) {
      assert.notEqual(tex, this.fboAttachment, '同一次绘制读写了同一纹理！');
    }
  }
  readPixels(x, y, w, h, fmt, type, buf) {
    this.readPixelsCount++;
    // 每行填充行号，供导出翻转验证
    for (let row = 0; row < h; row++) {
      buf.fill(row & 0xff, row * w * 4, (row + 1) * w * 4);
    }
  }
}

function makeCanvas(gl) {
  const listeners = new Map();
  return {
    width: 512,
    height: 512,
    getContext: () => gl,
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type) => {
      const fn = listeners.get(type);
      if (fn) fn({ preventDefault: () => {} });
    },
  };
}

function feedbackGraph() {
  return {
    width: 64, height: 64, outputId: 'mix',
    nodes: [
      { id: 'img', type: 'input', x: 0, y: 0, params: {} },
      { id: 'mix', type: 'blend', x: 0, y: 0, params: { blend: { mode: 0, factor: 1 } } },
      { id: 'fade', type: 'matrix', x: 0, y: 0, params: { matrix: new Array(20).fill(0) } },
      { id: 'p', type: 'prev', x: 0, y: 0, params: {} },
    ],
    edges: [
      { id: 'e1', from: 'img', to: 'mix', port: 0 },
      { id: 'e2', from: 'fade', to: 'mix', port: 1 },
      { id: 'e3', from: 'mix', to: 'p', port: 0 },
      { id: 'e4', from: 'p', to: 'fade', port: 0 },
    ],
  };
}

function commit(engine, g, images = new Map()) {
  const v = validateGraph(g, { hasImage: (id) => images.has(id) });
  assert.ok(v.ok, JSON.stringify(v.errors));
  engine.setGraph(g, images, v);
}

console.log('engine 集成测试（伪 GL）');

t('新修订帧归零，逐帧推进', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  assert.equal(engine.frame, 0);
  assert.equal(engine.lastFrame, -1);
  engine.runFrame();
  assert.equal(engine.lastFrame, 0);
  assert.equal(engine.frame, 1);
  engine.runFrame();
  engine.runFrame();
  assert.equal(engine.lastFrame, 2);
  assert.equal(engine.frame, 3);
});

t('反馈双缓冲：历史纹理每帧换页，旧纹理归还池', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  engine.runFrame();
  const s1 = engine.stats();
  assert.equal(s1.histories, 1);
  // 在用 = 历史1 + 显示1；帧内临时纹理已全部归还
  assert.equal(s1.poolInUse, 2);
  const h1 = engine.histories.get('p').tex.tex;
  const freeBefore = s1.poolFree;
  engine.runFrame();
  const h2 = engine.histories.get('p').tex.tex;
  assert.notEqual(h1, h2, '历史纹理未换页');
  assert.equal(engine.stats().poolInUse, 2);
  assert.ok(engine.stats().poolFree >= freeBefore, '旧历史纹理未归还');
});

t('每帧对历史与显示做 CPU 快照（供上下文恢复）', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  engine.runFrame();
  assert.equal(gl.readPixelsCount, 2); // 1 历史 + 1 显示
});

t('新修订释放旧反馈历史并重置帧号', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  engine.runFrame();
  engine.runFrame();
  assert.equal(engine.stats().histories, 1);
  commit(engine, feedbackGraph()); // 同内容新修订
  assert.equal(engine.frame, 0);
  assert.equal(engine.lastFrame, -1);
  assert.equal(engine.stats().histories, 0);
  assert.equal(engine.stats().poolInUse, 0);
});

t('移除输入节点后其纹理被删除', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  const images = new Map([['img', {}]]);
  commit(engine, feedbackGraph(), images);
  assert.equal(engine.stats().inputs, 1);
  const g = feedbackGraph();
  g.nodes = g.nodes.filter((n) => n.id !== 'img');
  g.edges = g.edges.filter((e) => e.from !== 'img' && e.to !== 'img');
  commit(engine, g, new Map());
  assert.equal(engine.stats().inputs, 0);
  assert.ok(gl.deletedTextures.length >= 1, '未删除输入纹理');
});

t('尺寸变化清空纹理池', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  engine.runFrame();
  assert.ok(engine.stats().poolFree > 0);
  const g = feedbackGraph();
  g.width = 128;
  commit(engine, g);
  assert.equal(engine.stats().poolFree, 0);
});

t('上下文丢失后暂停推进，恢复后从最近完成帧继续且不重复推进反馈', () => {
  const gl = new FakeGL();
  const canvas = makeCanvas(gl);
  const engine = new Engine(canvas);
  commit(engine, feedbackGraph());
  engine.runFrame();
  engine.runFrame();
  engine.runFrame();
  assert.equal(engine.lastFrame, 2);
  const histBefore = engine.histories.get('p').cpu;
  assert.ok(histBefore, '缺少 CPU 快照');

  canvas.fire('webglcontextlost');
  assert.equal(engine.lost, true);
  engine.runFrame(); // 丢失期间不得推进
  assert.equal(engine.lastFrame, 2);
  assert.equal(engine.frame, 3);

  canvas.fire('webglcontextrestored');
  assert.equal(engine.lost, false);
  assert.equal(engine.frame, 3, '恢复改变了帧号');
  // 反馈历史从快照恢复，内容一致（未重复推进）
  assert.equal(engine.histories.get('p').cpu, histBefore);
  engine.runFrame();
  assert.equal(engine.lastFrame, 3);
  assert.equal(engine.frame, 4);
});

t('导出行翻转正确（GL 底行在前 -> PNG 顶行在前）', () => {
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  engine.runFrame();
  const f = engine.exportFrame();
  assert.ok(f);
  assert.equal(f.width, 64);
  assert.equal(f.height, 64);
  // 伪 readPixels 按行号填充：raw 第 y 行全为 y。翻转后第 0 行应为 63。
  assert.equal(f.data[0], 63);
  assert.equal(f.data[(64 * 64 - 1) * 4], 0);
});

t('整个过程中没有一次绘制读写同一纹理', () => {
  // FakeGL.drawArrays 内置断言，跑若干帧不抛错即通过
  const gl = new FakeGL();
  const engine = new Engine(makeCanvas(gl));
  commit(engine, feedbackGraph());
  for (let i = 0; i < 5; i++) engine.runFrame();
  engine.exportFrame();
  assert.ok(gl.draws > 0);
});

console.log(`\n${passed} 个测试通过${process.exitCode ? '，存在失败' : ''}`);
