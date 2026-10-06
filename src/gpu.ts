// WebGL2 渲染引擎。
// 内部一律使用线性 RGB + 预乘 alpha（优先 RGBA16F，退回 RGBA8）。
// 反馈双缓冲：被「上一帧」引用的节点持有 ping/pong 两张纹理，
// 渲染第 N 帧时只写 tex[N%2]、只读 tex[(N-1)%2]，因此同一次绘制绝不读写同一纹理，
// 且所有反馈读取的都是上一完整帧，与节点遍历顺序无关。
// 模糊等中间结果来自纹理池（复用），修订销毁时统一释放。

import { GraphSpec } from './graph';

export interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export interface NodeRT {
  rts: RT[];
  pingpong: boolean;
}

export interface RevisionRes {
  rev: number;
  spec: GraphSpec;
  order: string[];
  nodeRT: Map<string, NodeRT>;
  imageTex: Map<string, WebGLTexture>;
  poolAll: RT[];
  poolFree: RT[];
}

const VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const COMMON = `
precision highp float;
in vec2 vUV;
out vec4 fragColor;
vec3 srgbToLinear(vec3 c){
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c){
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0/2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}
`;

// 输入：sRGB 直出 alpha -> 线性 + 预乘
const FS_INPUT = COMMON + `
uniform sampler2D uTex;
void main(){
  vec4 c = texture(uTex, vUV);
  vec3 lin = srgbToLinear(clamp(c.rgb, 0.0, 1.0));
  fragColor = vec4(lin * c.a, c.a);
}
`;

const FS_COPY = COMMON + `
uniform sampler2D uTex;
void main(){ fragColor = texture(uTex, vUV); }
`;

const FS_MATRIX = COMMON + `
uniform sampler2D uTex;
uniform vec4 uRows[4];
uniform vec4 uOff;
void main(){
  vec4 c = texture(uTex, vUV);
  fragColor = vec4(dot(uRows[0], c), dot(uRows[1], c), dot(uRows[2], c), dot(uRows[3], c)) + uOff;
}
`;

const FS_BLUR = COMMON + `
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uW[33];
uniform int uR;
void main(){
  vec4 acc = texture(uTex, vUV) * uW[0];
  for (int i = 1; i <= 32; i++){
    if (i > uR) break;
    acc += (texture(uTex, vUV + uStep * float(i)) + texture(uTex, vUV - uStep * float(i))) * uW[i];
  }
  fragColor = acc;
}
`;

const FS_BLEND = COMMON + `
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uMode;
uniform float uFactor;
void main(){
  vec4 a = texture(uA, vUV);
  vec4 b = texture(uB, vUV);
  vec4 r;
  if (uMode == 0) {                 // over（预乘 source-over）
    r = a + b * (1.0 - a.a);
  } else if (uMode == 1) {          // add
    r = a + b;
  } else if (uMode == 2) {          // mix
    r = mix(b, a, uFactor);
  } else if (uMode == 3) {          // multiply（按 source-over 合成）
    vec3 sa = a.a > 1e-6 ? a.rgb / a.a : vec3(0.0);
    vec3 sb = b.a > 1e-6 ? b.rgb / b.a : vec3(0.0);
    float ao = a.a + b.a * (1.0 - a.a);
    vec3 co = a.rgb * (1.0 - b.a) + b.rgb * (1.0 - a.a) + sa * sb * (a.a * b.a);
    r = vec4(co, ao);
  } else {                          // screen
    r = a + b - a * b;
  }
  fragColor = r;
}
`;

// 输出：线性预乘 -> 直出 alpha 的 sRGB（用于显示与 PNG 导出）
const FS_FINAL = COMMON + `
uniform sampler2D uTex;
void main(){
  vec4 c = texture(uTex, vUV);
  vec3 straight = c.a > 1e-6 ? c.rgb / c.a : vec3(0.0);
  straight = clamp(straight, 0.0, 1.0);
  fragColor = vec4(linearToSrgb(straight), clamp(c.a, 0.0, 1.0));
}
`;

type ProgName = 'input' | 'copy' | 'matrix' | 'blur' | 'blend' | 'final';

const BLEND_MODE_INDEX: Record<string, number> = { over: 0, add: 1, mix: 2, multiply: 3, screen: 4 };

function gaussWeights(r: number): Float32Array {
  const w = new Float32Array(33);
  const sigma = Math.max(r * 0.5, 0.25);
  let sum = 1;
  w[0] = 1;
  for (let i = 1; i <= r; i++) {
    w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += 2 * w[i];
  }
  for (let i = 0; i <= r; i++) w[i] /= sum;
  return w;
}

export class Engine {
  gl!: WebGL2RenderingContext;
  useFloat = false;
  texCount = 0;
  fboCount = 0;
  private progs = {} as Record<ProgName, WebGLProgram>;
  private vao: WebGLVertexArrayObject | null = null;
  private uniCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false, // 最终 pass 输出直出 alpha 的 sRGB
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.createGLResources();
  }

  /** 初始化 / 上下文恢复后重建全部 GL 对象（程序、VAO）。 */
  createGLResources(): void {
    const gl = this.gl;
    this.useFloat = !!gl.getExtension('EXT_color_buffer_float');
    this.uniCache.clear();
    this.progs = {
      input: this.compile('input', FS_INPUT),
      copy: this.compile('copy', FS_COPY),
      matrix: this.compile('matrix', FS_MATRIX),
      blur: this.compile('blur', FS_BLUR),
      blend: this.compile('blend', FS_BLEND),
      final: this.compile('final', FS_FINAL),
    };
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
    gl.disable(gl.BLEND); // 所有合成在着色器内显式完成
    gl.disable(gl.DEPTH_TEST);
  }

  loseContext(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  restoreContext(): void {
    this.gl.getExtension('WEBGL_lose_context')?.restoreContext();
  }

  private compile(name: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`着色器 ${name} 编译失败: ${gl.getShaderInfoLog(s)}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`程序 ${name} 链接失败: ${gl.getProgramInfoLog(p)}`);
    }
    return p;
  }

  private uni(p: WebGLProgram, n: string): WebGLUniformLocation | null {
    let m = this.uniCache.get(p);
    if (!m) {
      m = new Map();
      this.uniCache.set(p, m);
    }
    if (!m.has(n)) m.set(n, this.gl.getUniformLocation(p, n));
    return m.get(n)!;
  }

  private allocRT(w: number, h: number, forceByte = false): RT {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const useFloat = this.useFloat && !forceByte;
    gl.texImage2D(
      gl.TEXTURE_2D, 0,
      useFloat ? gl.RGBA16F : gl.RGBA8,
      w, h, 0, gl.RGBA,
      useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('帧缓冲不完整（无法渲染到纹理）');
    }
    // 初始化为透明黑：保证「上一帧」在第 0 帧读到透明图
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.texCount++;
    this.fboCount++;
    return { tex, fbo, w, h };
  }

  private freeRT(rt: RT): void {
    const gl = this.gl;
    gl.deleteTexture(rt.tex);
    gl.deleteFramebuffer(rt.fbo);
    this.texCount--;
    this.fboCount--;
  }

  /** 为通过验证的候选图分配全部 GPU 资源。 */
  buildRevision(
    spec: GraphSpec,
    order: string[],
    feedbackSrcs: Set<string>,
    rev: number,
    images: Map<string, ImageBitmap>,
  ): RevisionRes {
    const gl = this.gl;
    const res: RevisionRes = {
      rev,
      spec,
      order,
      nodeRT: new Map(),
      imageTex: new Map(),
      poolAll: [],
      poolFree: [],
    };
    for (const n of spec.nodes) {
      const pingpong = feedbackSrcs.has(n.id);
      const rts = pingpong
        ? [this.allocRT(spec.width, spec.height), this.allocRT(spec.width, spec.height)]
        : [this.allocRT(spec.width, spec.height)];
      res.nodeRT.set(n.id, { rts, pingpong });
    }
    for (const n of spec.nodes) {
      if (n.type !== 'input' || !n.imageKey || res.imageTex.has(n.imageKey)) continue;
      const bmp = images.get(n.imageKey);
      if (!bmp) continue;
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.texCount++;
      res.imageTex.set(n.imageKey, t);
    }
    return res;
  }

  /** 释放修订占用的全部 GPU 资源（节点移除 / 图被替换时调用）。 */
  disposeRevision(res: RevisionRes): void {
    for (const nrt of res.nodeRT.values()) nrt.rts.forEach((rt) => this.freeRT(rt));
    for (const t of res.imageTex.values()) {
      this.gl.deleteTexture(t);
      this.texCount--;
    }
    res.poolAll.forEach((rt) => this.freeRT(rt));
    res.nodeRT.clear();
    res.imageTex.clear();
    res.poolAll = [];
    res.poolFree = [];
  }

  private acquire(res: RevisionRes, w: number, h: number): RT {
    const idx = res.poolFree.findIndex((rt) => rt.w === w && rt.h === h);
    if (idx >= 0) return res.poolFree.splice(idx, 1)[0];
    const rt = this.allocRT(w, h);
    res.poolAll.push(rt);
    return rt;
  }

  private release(res: RevisionRes, rt: RT): void {
    res.poolFree.push(rt);
  }

  private bindTex(unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private pass(dst: RT | null, prog: WebGLProgram, setup: () => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, dst ? dst.w : this.canvas.width, dst ? dst.h : this.canvas.height);
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    setup();
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private runCopy(srcTex: WebGLTexture, dst: RT): void {
    const p = this.progs.copy;
    this.pass(dst, p, () => {
      this.bindTex(0, srcTex);
      this.gl.uniform1i(this.uni(p, 'uTex'), 0);
    });
  }

  private runBlur(res: RevisionRes, srcTex: WebGLTexture, dst: RT, radius: number): void {
    const r = Math.round(radius);
    if (r <= 0) {
      this.runCopy(srcTex, dst);
      return;
    }
    const tmp = this.acquire(res, dst.w, dst.h);
    const w = gaussWeights(r);
    const p = this.progs.blur;
    this.pass(tmp, p, () => {
      this.bindTex(0, srcTex);
      this.gl.uniform1i(this.uni(p, 'uTex'), 0);
      this.gl.uniform2f(this.uni(p, 'uStep'), 1 / dst.w, 0);
      this.gl.uniform1fv(this.uni(p, 'uW[0]'), w);
      this.gl.uniform1i(this.uni(p, 'uR'), r);
    });
    this.pass(dst, p, () => {
      this.bindTex(0, tmp.tex);
      this.gl.uniform1i(this.uni(p, 'uTex'), 0);
      this.gl.uniform2f(this.uni(p, 'uStep'), 0, 1 / dst.h);
      this.gl.uniform1fv(this.uni(p, 'uW[0]'), w);
      this.gl.uniform1i(this.uni(p, 'uR'), r);
    });
    this.release(res, tmp);
  }

  /** 渲染一帧（frame 为帧序号，从 0 开始）。 */
  renderFrame(res: RevisionRes, frame: number): void {
    const gl = this.gl;
    const cur = frame & 1;
    const texOf = (id: string, prev: boolean): WebGLTexture => {
      const nrt = res.nodeRT.get(id)!;
      return nrt.rts[nrt.pingpong ? (prev ? 1 - cur : cur) : 0].tex;
    };
    const dstOf = (id: string): RT => {
      const nrt = res.nodeRT.get(id)!;
      return nrt.rts[nrt.pingpong ? cur : 0];
    };
    const byId = new Map(res.spec.nodes.map((n) => [n.id, n]));
    for (const id of res.order) {
      const n = byId.get(id)!;
      const dst = dstOf(id);
      switch (n.type) {
        case 'input': {
          const p = this.progs.input;
          this.pass(dst, p, () => {
            this.bindTex(0, res.imageTex.get(n.imageKey!)!);
            gl.uniform1i(this.uni(p, 'uTex'), 0);
          });
          break;
        }
        case 'prevframe':
          // 读上一完整帧：源节点的 ping 纹理；首帧为初始化时的透明黑
          this.runCopy(texOf(n.inputs.src!, true), dst);
          break;
        case 'colormatrix': {
          const m = n.matrix!;
          const p = this.progs.matrix;
          this.pass(dst, p, () => {
            this.bindTex(0, texOf(n.inputs.src!, false));
            gl.uniform1i(this.uni(p, 'uTex'), 0);
            const rows = new Float32Array(16);
            rows.set(m.slice(0, 4), 0);
            rows.set(m.slice(5, 9), 4);
            rows.set(m.slice(10, 14), 8);
            rows.set(m.slice(15, 19), 12);
            gl.uniform4fv(this.uni(p, 'uRows[0]'), rows);
            gl.uniform4f(this.uni(p, 'uOff'), m[4], m[9], m[14], m[19]);
          });
          break;
        }
        case 'blur':
          this.runBlur(res, texOf(n.inputs.src!, false), dst, n.radius ?? 0);
          break;
        case 'blend': {
          const p = this.progs.blend;
          this.pass(dst, p, () => {
            this.bindTex(0, texOf(n.inputs.a!, false));
            this.bindTex(1, texOf(n.inputs.b!, false));
            gl.uniform1i(this.uni(p, 'uA'), 0);
            gl.uniform1i(this.uni(p, 'uB'), 1);
            gl.uniform1i(this.uni(p, 'uMode'), BLEND_MODE_INDEX[n.mode ?? 'over']);
            gl.uniform1f(this.uni(p, 'uFactor'), n.factor ?? 1);
          });
          break;
        }
      }
    }
  }

  /** 把某张内部纹理经「线性->sRGB、去预乘」最终 pass 画到画布。 */
  display(tex: WebGLTexture): void {
    const p = this.progs.final;
    this.pass(null, p, () => {
      this.bindTex(0, tex);
      this.gl.uniform1i(this.uni(p, 'uTex'), 0);
    });
  }

  /** 同步导出：渲染最终 pass 到 RGBA8 目标并读回（直出 sRGB，与 PNG 格式一致）。 */
  exportPixels(tex: WebGLTexture, w: number, h: number): Uint8Array {
    const rt = this.allocRT(w, h, true);
    const p = this.progs.final;
    this.pass(rt, p, () => {
      this.bindTex(0, tex);
      this.gl.uniform1i(this.uni(p, 'uTex'), 0);
    });
    const px = new Uint8Array(w * h * 4);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, rt.fbo);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.freeRT(rt);
    return px;
  }
}
