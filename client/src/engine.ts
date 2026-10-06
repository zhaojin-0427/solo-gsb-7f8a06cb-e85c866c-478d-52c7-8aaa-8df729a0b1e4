// engine.ts —— WebGL2 求值引擎。
//
// 关键设计：
// - 纹理池：节点输出与临时纹理（模糊中间结果）按尺寸从池中取用，帧尾统一归还，
//   跨帧复用；移除节点 / 换修订时释放不再使用的纹理。
// - 反馈双缓冲：每个「上一帧」节点持有一份历史纹理。帧内所有 prev 节点只读历史；
//   帧尾把反馈源拷贝到一张新纹理并换页，旧纹理归还池中。因此同一帧内不存在
//   “先写后读”的依赖，结果与遍历顺序无关，且任何一次绘制都不会读写同一纹理。
// - 上下文丢失：每帧结束把历史纹理与显示纹理 readPixels 到 CPU 快照；恢复后
//   重建全部 GL 资源并从最近完成帧继续，帧号不回退、反馈不重复推进。

import { Graph, GraphNode, Validation, INPUT_PORTS, MAX_BLUR } from './graph.js';
import {
  VS_FULLSCREEN, FS_COPY, FS_INPUT, FS_MATRIX, FS_BLUR, FS_BLEND, FS_DISPLAY, FS_EXPORT,
} from './shaders.js';

interface Pooled { tex: WebGLTexture; w: number; h: number; }

interface Prog {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}

interface Plan {
  order: string[];
  feeds: Map<string, string | null>;
  nodeInputs: Map<string, (string | null)[]>;
  byId: Map<string, GraphNode>;
}

class TexturePool {
  private free = new Map<string, WebGLTexture[]>();
  inUse = 0;
  constructor(private gl: WebGL2RenderingContext) {}

  private key(w: number, h: number) { return `${w}x${h}`; }

  acquire(w: number, h: number): Pooled {
    const k = this.key(w, h);
    const list = this.free.get(k);
    let tex: WebGLTexture | undefined;
    if (list && list.length) {
      tex = list.pop()!;
    } else {
      const gl = this.gl;
      const t = gl.createTexture();
      if (!t) throw new Error('创建纹理失败');
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      tex = t;
    }
    this.inUse++;
    return { tex, w, h };
  }

  release(p: Pooled): void {
    this.inUse--;
    const k = this.key(p.w, p.h);
    let list = this.free.get(k);
    if (!list) { list = []; this.free.set(k, list); }
    list.push(p.tex);
  }

  get freeCount(): number {
    let n = 0;
    for (const l of this.free.values()) n += l.length;
    return n;
  }

  // 尺寸变化时调用：删除全部空闲纹理（在用纹理由持有方先行归还）
  clear(): void {
    for (const l of this.free.values()) for (const t of l) this.gl.deleteTexture(t);
    this.free.clear();
    this.inUse = 0;
  }

  // 上下文丢失：GL 对象已全部失效，直接丢弃引用
  dropAll(): void {
    this.free.clear();
    this.inUse = 0;
  }
}

export interface ExportedFrame { data: Uint8Array; width: number; height: number; }

export class Engine {
  private gl: WebGL2RenderingContext;
  private progs: Record<string, Prog> = {};
  private cur: Prog | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private transparentTex: WebGLTexture | null = null;
  private pool!: TexturePool;
  private loseExt: WEBGL_lose_context | null = null;

  lost = false;
  onStateChange: () => void = () => {};

  // —— 修订状态 ——
  private graph: Graph | null = null;
  private plan: Plan | null = null;
  private inputTextures = new Map<string, { tex: WebGLTexture | null; bmp: ImageBitmap }>();
  private histories = new Map<string, { tex: Pooled; cpu: Uint8Array | null }>();
  private displayTex: Pooled | null = null;
  private displayCpu: Uint8Array | null = null;

  frame = 0;      // 下一个要渲染的帧号
  lastFrame = -1; // 最近完成的帧号（导出/显示用它）

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.loseExt = gl.getExtension('WEBGL_lose_context');
    this.initGL();

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // 允许后续 restore
      this.lost = true;
      this.pool.dropAll();
      this.onStateChange();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.rebuild();
      this.onStateChange();
    });
  }

  // ---------------------------------------------------------------- GL 基础

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error(`着色器编译失败：${log}`);
    }
    return s;
  }

  private makeProg(fsSrc: string, uniforms: string[]): Prog {
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VS_FULLSCREEN);
    const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`着色器链接失败：${gl.getProgramInfoLog(prog)}`);
    }
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u };
  }

  private initGL(): void {
    const gl = this.gl;
    this.progs = {
      copy: this.makeProg(FS_COPY, ['u_tex']),
      input: this.makeProg(FS_INPUT, ['u_tex']),
      matrix: this.makeProg(FS_MATRIX, ['u_tex', 'u_m', 'u_off']),
      blur: this.makeProg(FS_BLUR, ['u_tex', 'u_dir', 'u_radius', 'u_w[0]']),
      blend: this.makeProg(FS_BLEND, ['u_a', 'u_b', 'u_mode', 'u_f']),
      display: this.makeProg(FS_DISPLAY, ['u_tex', 'u_cell']),
      export: this.makeProg(FS_EXPORT, ['u_tex']),
    };
    this.fbo = gl.createFramebuffer();
    // 1x1 全透明纹理：未连接输入的占位，只读
    this.transparentTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.transparentTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    this.pool = new TexturePool(gl);
  }

  private use(name: string): Prog {
    const p = this.progs[name];
    this.gl.useProgram(p.prog);
    this.cur = p;
    return p;
  }

  private bindTex(unit: number, tex: WebGLTexture, uni: string): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.cur!.u[uni], unit);
  }

  // 绘制到池纹理（禁止读写同一纹理：调用方保证源纹理不是 target；
  // 这里先清空采样单元的旧绑定，避免遗留绑定构成伪反馈环）
  private draw(target: Pooled, progName: string, setup: () => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    gl.viewport(0, 0, target.w, target.h);
    this.use(progName);
    for (let unit = 0; unit < 2; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    setup();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private clearTarget(target: Pooled): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  private readTex(p: Pooled): Uint8Array {
    const gl = this.gl;
    const buf = new Uint8Array(p.w * p.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, p.tex, 0);
    gl.readPixels(0, 0, p.w, p.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  private uploadImage(bmp: ImageBitmap): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // 翻转使纹理 v=0 对应图像底行；SRGB8_ALPHA8 采样时硬件解码到线性空间
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private uploadPixels(p: Pooled, data: Uint8Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, p.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, p.w, p.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  // ---------------------------------------------------------------- 修订切换

  // 完整候选已验证通过后调用：原子切换到新修订，帧号归零。
  // 释放旧修订独占、且新图不再使用的 GPU 资源（历史纹理、输入纹理、显示纹理）。
  setGraph(g: Graph, images: Map<string, ImageBitmap>, v: Validation): void {
    // 1) 反馈历史：新修订从第零帧开始，历史必须重置为透明
    if (!this.lost) for (const h of this.histories.values()) this.pool.release(h.tex);
    this.histories.clear();
    if (this.displayTex) {
      if (!this.lost) this.pool.release(this.displayTex);
      this.displayTex = null;
    }
    this.displayCpu = null;

    // 2) 输入纹理：同一位图复用，不再使用的删除
    const next = new Map<string, { tex: WebGLTexture | null; bmp: ImageBitmap }>();
    for (const n of g.nodes) {
      if (n.type !== 'input') continue;
      const bmp = images.get(n.id);
      if (!bmp) continue;
      const old = this.inputTextures.get(n.id);
      if (old && old.bmp === bmp) {
        next.set(n.id, old);
        this.inputTextures.delete(n.id);
      } else {
        next.set(n.id, { tex: this.lost ? null : this.uploadImage(bmp), bmp });
      }
    }
    if (!this.lost) {
      for (const old of this.inputTextures.values()) {
        if (old.tex) this.gl.deleteTexture(old.tex);
      }
    }
    this.inputTextures = next;

    // 3) 尺寸变化：纹理池整体作废（空闲纹理全部删除）
    const sizeChanged = !this.graph || this.graph.width !== g.width || this.graph.height !== g.height;
    this.canvas.width = g.width;
    this.canvas.height = g.height;
    if (sizeChanged && !this.lost) this.pool.clear();

    // 4) 新求值计划，帧号归零
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const nodeInputs = new Map<string, (string | null)[]>();
    for (const id of v.needed) {
      const n = byId.get(id)!;
      const arr: (string | null)[] = new Array(INPUT_PORTS[n.type].length).fill(null);
      for (const e of g.edges) {
        if (e.to === id && e.port >= 0 && e.port < arr.length) arr[e.port] = e.from;
      }
      nodeInputs.set(id, arr);
    }
    this.graph = g;
    this.plan = { order: v.order, feeds: v.feeds, nodeInputs, byId };
    this.frame = 0;
    this.lastFrame = -1;
  }

  hasPlan(): boolean { return this.plan !== null; }

  // ---------------------------------------------------------------- 帧求值

  runFrame(): void {
    if (this.lost || !this.plan || !this.graph) return;
    const gl = this.gl;
    const W = this.graph.width;
    const H = this.graph.height;
    const plan = this.plan;

    const acquired: Pooled[] = []; // 本帧从池中取的节点输出，帧尾统一归还
    const acq = (): Pooled => { const p = this.pool.acquire(W, H); acquired.push(p); return p; };
    const outputs = new Map<string, WebGLTexture>();
    const texOf = (id: string | null | undefined): WebGLTexture =>
      (id !== null && id !== undefined && outputs.get(id)) || this.transparentTex!;

    try {
      for (const id of plan.order) {
        const node = plan.byId.get(id)!;
        switch (node.type) {
          case 'input': {
            const p = acq();
            const img = this.inputTextures.get(id);
            if (img && img.tex) this.draw(p, 'input', () => this.bindTex(0, img.tex!, 'u_tex'));
            else this.clearTarget(p);
            outputs.set(id, p.tex);
            break;
          }
          case 'prev': {
            // 输出上一完整帧的历史纹理（只读，本帧不写）
            const h = this.histories.get(id);
            outputs.set(id, h ? h.tex.tex : this.transparentTex!);
            break;
          }
          case 'matrix': {
            const p = acq();
            const src = texOf(plan.nodeInputs.get(id)![0]);
            const m = node.params.matrix!;
            const cm = new Float32Array(16); // 行主序 UI -> 列主序 GLSL
            for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) cm[c * 4 + r] = m[r * 5 + c];
            this.draw(p, 'matrix', () => {
              this.bindTex(0, src, 'u_tex');
              gl.uniformMatrix4fv(this.cur!.u['u_m'], false, cm);
              gl.uniform4f(this.cur!.u['u_off'], m[4], m[9], m[14], m[19]);
            });
            outputs.set(id, p.tex);
            break;
          }
          case 'blur': {
            const src = texOf(plan.nodeInputs.get(id)![0]);
            const r = Math.max(0, Math.min(MAX_BLUR, Math.round(node.params.blur?.radius ?? 0)));
            const p = acq();
            if (r === 0) {
              this.draw(p, 'copy', () => this.bindTex(0, src, 'u_tex'));
            } else {
              const tmp = this.pool.acquire(W, H); // 中间纹理：用完立即归还复用
              const w = gaussWeights(r);
              this.draw(tmp, 'blur', () => {
                this.bindTex(0, src, 'u_tex');
                gl.uniform2f(this.cur!.u['u_dir'], 1 / W, 0);
                gl.uniform1i(this.cur!.u['u_radius'], r);
                gl.uniform1fv(this.cur!.u['u_w[0]'], w);
              });
              this.draw(p, 'blur', () => {
                this.bindTex(0, tmp.tex, 'u_tex');
                gl.uniform2f(this.cur!.u['u_dir'], 0, 1 / H);
                gl.uniform1i(this.cur!.u['u_radius'], r);
                gl.uniform1fv(this.cur!.u['u_w[0]'], w);
              });
              this.pool.release(tmp);
            }
            outputs.set(id, p.tex);
            break;
          }
          case 'blend': {
            const p = acq();
            const ins = plan.nodeInputs.get(id)!;
            const a = texOf(ins[0]);
            const b = texOf(ins[1]);
            const bp = node.params.blend!;
            this.draw(p, 'blend', () => {
              this.bindTex(0, a, 'u_a');
              this.bindTex(1, b, 'u_b');
              gl.uniform1i(this.cur!.u['u_mode'], bp.mode);
              gl.uniform1f(this.cur!.u['u_f'], bp.factor);
            });
            outputs.set(id, p.tex);
            break;
          }
        }
      }

      // —— 帧尾：反馈双缓冲换页。所有 prev 同时拿到“上一完整帧”的反馈源 ——
      for (const [pid, src] of plan.feeds) {
        const srcTex = texOf(src);
        const nh = this.pool.acquire(W, H);
        this.draw(nh, 'copy', () => this.bindTex(0, srcTex, 'u_tex'));
        const old = this.histories.get(pid);
        if (old) this.pool.release(old.tex);
        this.histories.set(pid, { tex: nh, cpu: this.readTex(nh) }); // CPU 快照供上下文恢复
      }

      // —— 显示纹理（暂停/导出/上下文恢复都读它）——
      const outTex = this.graph.outputId ? texOf(this.graph.outputId) : this.transparentTex!;
      const nd = this.pool.acquire(W, H);
      this.draw(nd, 'copy', () => this.bindTex(0, outTex, 'u_tex'));
      if (this.displayTex) this.pool.release(this.displayTex);
      this.displayTex = nd;
      this.displayCpu = this.readTex(nd);
    } finally {
      for (const p of acquired) this.pool.release(p);
    }

    this.lastFrame = this.frame;
    this.frame++;
  }

  // 把最近完成的帧画到画布（暂停时也持续调用）
  present(): void {
    if (this.lost) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (!this.displayTex) {
      gl.clearColor(0.1, 0.1, 0.12, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const p = this.use('display');
    this.bindTex(0, this.displayTex.tex, 'u_tex');
    gl.uniform1f(p.u['u_cell'], 8);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 导出当前显示帧：线性预乘 -> 普通 sRGB PNG 像素（顶行在前）
  exportFrame(): ExportedFrame | null {
    if (this.lost || !this.displayTex || !this.graph || this.lastFrame < 0) return null;
    const W = this.graph.width;
    const H = this.graph.height;
    const p = this.pool.acquire(W, H);
    this.draw(p, 'export', () => this.bindTex(0, this.displayTex!.tex, 'u_tex'));
    const raw = this.readTex(p);
    this.pool.release(p);
    const row = W * 4;
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) out.set(raw.subarray((H - 1 - y) * row, (H - y) * row), y * row);
    return { data: out, width: W, height: H };
  }

  // ---------------------------------------------------------------- 上下文丢失

  simulateLoss(): boolean {
    if (!this.loseExt) return false;
    this.loseExt.loseContext();
    return true;
  }

  restore(): void {
    this.loseExt?.restoreContext();
  }

  // 恢复后重建全部 GL 资源，从最近完成帧继续（帧号不动、反馈不重复推进）
  private rebuild(): void {
    this.initGL();
    for (const e of this.inputTextures.values()) e.tex = this.uploadImage(e.bmp);
    if (this.graph) {
      const W = this.graph.width;
      const H = this.graph.height;
      for (const h of this.histories.values()) {
        const p = this.pool.acquire(W, H);
        if (h.cpu) this.uploadPixels(p, h.cpu);
        else this.clearTarget(p);
        h.tex = p;
      }
      if (this.displayCpu) {
        const p = this.pool.acquire(W, H);
        this.uploadPixels(p, this.displayCpu);
        this.displayTex = p;
      }
    }
    this.lost = false;
  }

  // ---------------------------------------------------------------- 统计

  stats(): { poolFree: number; poolInUse: number; histories: number; inputs: number } {
    return {
      poolFree: this.pool.freeCount,
      poolInUse: this.pool.inUse,
      histories: this.histories.size,
      inputs: this.inputTextures.size,
    };
  }
}

function gaussWeights(r: number): Float32Array {
  const w = new Float32Array(33);
  const sigma = Math.max(r / 2, 1e-3);
  let sum = 0;
  for (let i = 0; i <= r; i++) {
    w[i] = Math.exp(-0.5 * (i / sigma) * (i / sigma));
    sum += i === 0 ? w[i] : 2 * w[i];
  }
  for (let i = 0; i <= r; i++) w[i] /= sum;
  return w;
}
