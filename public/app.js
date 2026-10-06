"use strict";
(() => {
  // src/graph.ts
  var SLOTS = {
    input: [],
    colormatrix: ["src"],
    blur: ["src"],
    prevframe: ["src"],
    blend: ["a", "b"]
  };
  var TYPE_LABEL = {
    input: "\u8F93\u5165\u56FE\u50CF",
    colormatrix: "\u989C\u8272\u77E9\u9635",
    blur: "\u9AD8\u65AF\u6A21\u7CCA",
    prevframe: "\u4E0A\u4E00\u5E27",
    blend: "\u6DF7\u5408"
  };
  var BLEND_MODES = ["over", "add", "mix", "multiply", "screen"];
  var BLEND_MODE_LABEL = {
    over: "\u8986\u76D6 over",
    add: "\u76F8\u52A0 add",
    mix: "\u63D2\u503C mix",
    multiply: "\u6B63\u7247\u53E0\u5E95 multiply",
    screen: "\u6EE4\u8272 screen"
  };
  var IDENTITY_MATRIX = [
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    1,
    0
  ];
  function cloneSpec(s) {
    return JSON.parse(JSON.stringify(s));
  }
  function validateGraph(spec2, hasImage) {
    const errors = [];
    const byId = /* @__PURE__ */ new Map();
    for (const n of spec2.nodes) {
      if (byId.has(n.id))
        errors.push({ nodeId: n.id, message: `\u8282\u70B9 id \u91CD\u590D\uFF1A${n.id}` });
      byId.set(n.id, n);
    }
    if (!Number.isInteger(spec2.width) || !Number.isInteger(spec2.height) || spec2.width < 16 || spec2.height < 16 || spec2.width > 2048 || spec2.height > 2048) {
      errors.push({ nodeId: null, message: `\u753B\u5E03\u5C3A\u5BF8\u975E\u6CD5\uFF1A${spec2.width}\xD7${spec2.height}\uFF08\u9700\u4E3A 16\u20132048 \u7684\u6574\u6570\uFF09` });
    }
    const feedbackSrcs = /* @__PURE__ */ new Set();
    for (const n of spec2.nodes) {
      for (const slot of SLOTS[n.type]) {
        const src = n.inputs[slot];
        if (!src) {
          errors.push({ nodeId: n.id, message: `\u8F93\u5165\u300C${slot}\u300D\u672A\u8FDE\u63A5` });
          continue;
        }
        if (!byId.has(src)) {
          errors.push({ nodeId: n.id, message: `\u8F93\u5165\u300C${slot}\u300D\u6307\u5411\u4E0D\u5B58\u5728\u7684\u8282\u70B9 ${src}` });
          continue;
        }
        if (n.type === "prevframe")
          feedbackSrcs.add(src);
      }
      switch (n.type) {
        case "input":
          if (!n.imageKey)
            errors.push({ nodeId: n.id, message: "\u5C1A\u672A\u9009\u62E9\u56FE\u50CF" });
          else if (!hasImage(n.imageKey))
            errors.push({ nodeId: n.id, message: "\u56FE\u50CF\u5C1A\u672A\u89E3\u7801\u5B8C\u6210" });
          break;
        case "colormatrix":
          if (!n.matrix || n.matrix.length !== 20 || n.matrix.some((v) => !Number.isFinite(v))) {
            errors.push({ nodeId: n.id, message: "\u989C\u8272\u77E9\u9635\u9700\u4E3A 20 \u4E2A\u6709\u9650\u6570\u503C\uFF084\xD75\uFF09" });
          }
          break;
        case "blur":
          if (n.radius === void 0 || !Number.isFinite(n.radius) || n.radius < 0 || n.radius > 32) {
            errors.push({ nodeId: n.id, message: "\u6A21\u7CCA\u534A\u5F84\u9700\u4E3A 0\u201332" });
          }
          break;
        case "blend":
          if (!n.mode || !BLEND_MODES.includes(n.mode)) {
            errors.push({ nodeId: n.id, message: "\u6DF7\u5408\u6A21\u5F0F\u975E\u6CD5" });
          }
          if (n.factor === void 0 || !Number.isFinite(n.factor) || n.factor < 0 || n.factor > 1) {
            errors.push({ nodeId: n.id, message: "\u6DF7\u5408\u7CFB\u6570\u9700\u4E3A 0\u20131" });
          }
          break;
        case "prevframe":
          break;
      }
    }
    if (!spec2.outputId) {
      errors.push({ nodeId: null, message: "\u672A\u6307\u5B9A\u8F93\u51FA\u8282\u70B9" });
    } else if (!byId.has(spec2.outputId)) {
      errors.push({ nodeId: null, message: `\u8F93\u51FA\u8282\u70B9 ${spec2.outputId} \u4E0D\u5B58\u5728` });
    }
    const indeg = /* @__PURE__ */ new Map();
    const adj = /* @__PURE__ */ new Map();
    for (const n of spec2.nodes)
      indeg.set(n.id, 0);
    for (const n of spec2.nodes) {
      if (n.type === "prevframe")
        continue;
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
    const queue = spec2.nodes.map((n) => n.id).filter((id) => indeg.get(id) === 0);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const m of adj.get(id) ?? []) {
        indeg.set(m, indeg.get(m) - 1);
        if (indeg.get(m) === 0)
          queue.push(m);
      }
    }
    if (order.length !== spec2.nodes.length) {
      const remaining = spec2.nodes.filter((n) => !order.includes(n.id)).map((n) => `${n.name}(${n.id})`);
      errors.push({
        nodeId: null,
        message: `\u68C0\u6D4B\u5230\u5FAA\u73AF\u4F9D\u8D56\uFF08\u975E\u300C\u4E0A\u4E00\u5E27\u300D\u8FB9\uFF09\uFF1A${remaining.join("\u3001")}\u3002\u540C\u4E00\u5E27\u7684\u4F9D\u8D56\u5FC5\u987B\u65E0\u73AF\uFF1B\u5982\u9700\u53CD\u9988\u8BF7\u4F7F\u7528\u300C\u4E0A\u4E00\u5E27\u300D\u8282\u70B9\u3002`
      });
    }
    return { ok: errors.length === 0, errors, order, feedbackSrcs };
  }

  // src/gpu.ts
  var VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos*0.5+0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`;
  var COMMON = `
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
  var FS_INPUT = COMMON + `
uniform sampler2D uTex;
void main(){
  vec4 c = texture(uTex, vUV);
  vec3 lin = srgbToLinear(clamp(c.rgb, 0.0, 1.0));
  fragColor = vec4(lin * c.a, c.a);
}
`;
  var FS_COPY = COMMON + `
uniform sampler2D uTex;
void main(){ fragColor = texture(uTex, vUV); }
`;
  var FS_MATRIX = COMMON + `
uniform sampler2D uTex;
uniform vec4 uRows[4];
uniform vec4 uOff;
void main(){
  vec4 c = texture(uTex, vUV);
  fragColor = vec4(dot(uRows[0], c), dot(uRows[1], c), dot(uRows[2], c), dot(uRows[3], c)) + uOff;
}
`;
  var FS_BLUR = COMMON + `
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
  var FS_BLEND = COMMON + `
uniform sampler2D uA;
uniform sampler2D uB;
uniform int uMode;
uniform float uFactor;
void main(){
  vec4 a = texture(uA, vUV);
  vec4 b = texture(uB, vUV);
  vec4 r;
  if (uMode == 0) {                 // over\uFF08\u9884\u4E58 source-over\uFF09
    r = a + b * (1.0 - a.a);
  } else if (uMode == 1) {          // add
    r = a + b;
  } else if (uMode == 2) {          // mix
    r = mix(b, a, uFactor);
  } else if (uMode == 3) {          // multiply\uFF08\u6309 source-over \u5408\u6210\uFF09
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
  var FS_FINAL = COMMON + `
uniform sampler2D uTex;
void main(){
  vec4 c = texture(uTex, vUV);
  vec3 straight = c.a > 1e-6 ? c.rgb / c.a : vec3(0.0);
  straight = clamp(straight, 0.0, 1.0);
  fragColor = vec4(linearToSrgb(straight), clamp(c.a, 0.0, 1.0));
}
`;
  var BLEND_MODE_INDEX = { over: 0, add: 1, mix: 2, multiply: 3, screen: 4 };
  function gaussWeights(r) {
    const w = new Float32Array(33);
    const sigma = Math.max(r * 0.5, 0.25);
    let sum = 1;
    w[0] = 1;
    for (let i = 1; i <= r; i++) {
      w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += 2 * w[i];
    }
    for (let i = 0; i <= r; i++)
      w[i] /= sum;
    return w;
  }
  var Engine = class {
    constructor(canvas2) {
      this.canvas = canvas2;
      this.useFloat = false;
      this.texCount = 0;
      this.fboCount = 0;
      this.progs = {};
      this.vao = null;
      this.uniCache = /* @__PURE__ */ new Map();
      const gl = canvas2.getContext("webgl2", {
        premultipliedAlpha: false,
        // 最终 pass 输出直出 alpha 的 sRGB
        alpha: true,
        antialias: false,
        preserveDrawingBuffer: false
      });
      if (!gl)
        throw new Error("WebGL2 \u4E0D\u53EF\u7528");
      this.gl = gl;
      this.createGLResources();
    }
    /** 初始化 / 上下文恢复后重建全部 GL 对象（程序、VAO）。 */
    createGLResources() {
      const gl = this.gl;
      this.useFloat = !!gl.getExtension("EXT_color_buffer_float");
      this.uniCache.clear();
      this.progs = {
        input: this.compile("input", FS_INPUT),
        copy: this.compile("copy", FS_COPY),
        matrix: this.compile("matrix", FS_MATRIX),
        blur: this.compile("blur", FS_BLUR),
        blend: this.compile("blend", FS_BLEND),
        final: this.compile("final", FS_FINAL)
      };
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      this.vao = vao;
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
    }
    loseContext() {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    restoreContext() {
      this.gl.getExtension("WEBGL_lose_context")?.restoreContext();
    }
    compile(name, fsSrc) {
      const gl = this.gl;
      const mk = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(`\u7740\u8272\u5668 ${name} \u7F16\u8BD1\u5931\u8D25: ${gl.getShaderInfoLog(s)}`);
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VS));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`\u7A0B\u5E8F ${name} \u94FE\u63A5\u5931\u8D25: ${gl.getProgramInfoLog(p)}`);
      }
      return p;
    }
    uni(p, n) {
      let m = this.uniCache.get(p);
      if (!m) {
        m = /* @__PURE__ */ new Map();
        this.uniCache.set(p, m);
      }
      if (!m.has(n))
        m.set(n, this.gl.getUniformLocation(p, n));
      return m.get(n);
    }
    allocRT(w, h2, forceByte = false) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      const useFloat = this.useFloat && !forceByte;
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        useFloat ? gl.RGBA16F : gl.RGBA8,
        w,
        h2,
        0,
        gl.RGBA,
        useFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
        null
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("\u5E27\u7F13\u51B2\u4E0D\u5B8C\u6574\uFF08\u65E0\u6CD5\u6E32\u67D3\u5230\u7EB9\u7406\uFF09");
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.texCount++;
      this.fboCount++;
      return { tex, fbo, w, h: h2 };
    }
    freeRT(rt) {
      const gl = this.gl;
      gl.deleteTexture(rt.tex);
      gl.deleteFramebuffer(rt.fbo);
      this.texCount--;
      this.fboCount--;
    }
    /** 为通过验证的候选图分配全部 GPU 资源。 */
    buildRevision(spec2, order, feedbackSrcs, rev, images2) {
      const gl = this.gl;
      const res = {
        rev,
        spec: spec2,
        order,
        nodeRT: /* @__PURE__ */ new Map(),
        imageTex: /* @__PURE__ */ new Map(),
        poolAll: [],
        poolFree: []
      };
      for (const n of spec2.nodes) {
        const pingpong = feedbackSrcs.has(n.id);
        const rts = pingpong ? [this.allocRT(spec2.width, spec2.height), this.allocRT(spec2.width, spec2.height)] : [this.allocRT(spec2.width, spec2.height)];
        res.nodeRT.set(n.id, { rts, pingpong });
      }
      for (const n of spec2.nodes) {
        if (n.type !== "input" || !n.imageKey || res.imageTex.has(n.imageKey))
          continue;
        const bmp = images2.get(n.imageKey);
        if (!bmp)
          continue;
        const t = gl.createTexture();
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
    disposeRevision(res) {
      for (const nrt of res.nodeRT.values())
        nrt.rts.forEach((rt) => this.freeRT(rt));
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
    acquire(res, w, h2) {
      const idx = res.poolFree.findIndex((rt2) => rt2.w === w && rt2.h === h2);
      if (idx >= 0)
        return res.poolFree.splice(idx, 1)[0];
      const rt = this.allocRT(w, h2);
      res.poolAll.push(rt);
      return rt;
    }
    release(res, rt) {
      res.poolFree.push(rt);
    }
    bindTex(unit, tex) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    pass(dst, prog, setup) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
      gl.viewport(0, 0, dst ? dst.w : this.canvas.width, dst ? dst.h : this.canvas.height);
      gl.useProgram(prog);
      gl.bindVertexArray(this.vao);
      setup();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    }
    runCopy(srcTex, dst) {
      const p = this.progs.copy;
      this.pass(dst, p, () => {
        this.bindTex(0, srcTex);
        this.gl.uniform1i(this.uni(p, "uTex"), 0);
      });
    }
    runBlur(res, srcTex, dst, radius) {
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
        this.gl.uniform1i(this.uni(p, "uTex"), 0);
        this.gl.uniform2f(this.uni(p, "uStep"), 1 / dst.w, 0);
        this.gl.uniform1fv(this.uni(p, "uW[0]"), w);
        this.gl.uniform1i(this.uni(p, "uR"), r);
      });
      this.pass(dst, p, () => {
        this.bindTex(0, tmp.tex);
        this.gl.uniform1i(this.uni(p, "uTex"), 0);
        this.gl.uniform2f(this.uni(p, "uStep"), 0, 1 / dst.h);
        this.gl.uniform1fv(this.uni(p, "uW[0]"), w);
        this.gl.uniform1i(this.uni(p, "uR"), r);
      });
      this.release(res, tmp);
    }
    /** 渲染一帧（frame 为帧序号，从 0 开始）。 */
    renderFrame(res, frame) {
      const gl = this.gl;
      const cur = frame & 1;
      const texOf = (id, prev) => {
        const nrt = res.nodeRT.get(id);
        return nrt.rts[nrt.pingpong ? prev ? 1 - cur : cur : 0].tex;
      };
      const dstOf = (id) => {
        const nrt = res.nodeRT.get(id);
        return nrt.rts[nrt.pingpong ? cur : 0];
      };
      const byId = new Map(res.spec.nodes.map((n) => [n.id, n]));
      for (const id of res.order) {
        const n = byId.get(id);
        const dst = dstOf(id);
        switch (n.type) {
          case "input": {
            const p = this.progs.input;
            this.pass(dst, p, () => {
              this.bindTex(0, res.imageTex.get(n.imageKey));
              gl.uniform1i(this.uni(p, "uTex"), 0);
            });
            break;
          }
          case "prevframe":
            this.runCopy(texOf(n.inputs.src, true), dst);
            break;
          case "colormatrix": {
            const m = n.matrix;
            const p = this.progs.matrix;
            this.pass(dst, p, () => {
              this.bindTex(0, texOf(n.inputs.src, false));
              gl.uniform1i(this.uni(p, "uTex"), 0);
              const rows = new Float32Array(16);
              rows.set(m.slice(0, 4), 0);
              rows.set(m.slice(5, 9), 4);
              rows.set(m.slice(10, 14), 8);
              rows.set(m.slice(15, 19), 12);
              gl.uniform4fv(this.uni(p, "uRows[0]"), rows);
              gl.uniform4f(this.uni(p, "uOff"), m[4], m[9], m[14], m[19]);
            });
            break;
          }
          case "blur":
            this.runBlur(res, texOf(n.inputs.src, false), dst, n.radius ?? 0);
            break;
          case "blend": {
            const p = this.progs.blend;
            this.pass(dst, p, () => {
              this.bindTex(0, texOf(n.inputs.a, false));
              this.bindTex(1, texOf(n.inputs.b, false));
              gl.uniform1i(this.uni(p, "uA"), 0);
              gl.uniform1i(this.uni(p, "uB"), 1);
              gl.uniform1i(this.uni(p, "uMode"), BLEND_MODE_INDEX[n.mode ?? "over"]);
              gl.uniform1f(this.uni(p, "uFactor"), n.factor ?? 1);
            });
            break;
          }
        }
      }
    }
    /** 把某张内部纹理经「线性->sRGB、去预乘」最终 pass 画到画布。 */
    display(tex) {
      const p = this.progs.final;
      this.pass(null, p, () => {
        this.bindTex(0, tex);
        this.gl.uniform1i(this.uni(p, "uTex"), 0);
      });
    }
    /** 同步导出：渲染最终 pass 到 RGBA8 目标并读回（直出 sRGB，与 PNG 格式一致）。 */
    exportPixels(tex, w, h2) {
      const rt = this.allocRT(w, h2, true);
      const p = this.progs.final;
      this.pass(rt, p, () => {
        this.bindTex(0, tex);
        this.gl.uniform1i(this.uni(p, "uTex"), 0);
      });
      const px = new Uint8Array(w * h2 * 4);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, rt.fbo);
      this.gl.readPixels(0, 0, w, h2, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      this.freeRT(rt);
      return px;
    }
  };

  // src/app.ts
  var canvas = document.getElementById("view");
  var engine;
  var spec;
  var applied = null;
  var lastValid = null;
  var lastValidation = null;
  var revCounter = 0;
  var completedFrames = 0;
  var running = false;
  var contextLost = false;
  var previewId = null;
  var idSeq = 0;
  var uploadSeq = 0;
  var images = /* @__PURE__ */ new Map();
  var uploadErrors = /* @__PURE__ */ new Map();
  var cardEls = /* @__PURE__ */ new Map();
  var slotEls = /* @__PURE__ */ new Map();
  var $ = (id) => document.getElementById(id);
  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === void 0 || v === null)
        continue;
      if (k === "class")
        el.className = String(v);
      else if (k.startsWith("on"))
        el.addEventListener(k.slice(2), v);
      else if (k === "value")
        el.value = String(v);
      else if (k === "checked")
        el.checked = Boolean(v);
      else
        el.setAttribute(k, String(v));
    }
    for (const c of children)
      el.append(c);
    return el;
  }
  function commitFromLastValid() {
    if (!lastValid)
      return;
    revCounter++;
    if (applied) {
      engine.disposeRevision(applied.res);
      console.info(`[gpu] \u5DF2\u91CA\u653E\u4FEE\u8BA2 #${applied.rev} \u7684\u8D44\u6E90`);
    }
    const res = engine.buildRevision(lastValid.spec, lastValid.order, lastValid.feedbackSrcs, revCounter, images);
    applied = { spec: cloneSpec(lastValid.spec), order: lastValid.order, feedbackSrcs: lastValid.feedbackSrcs, rev: revCounter, res };
    canvas.width = lastValid.spec.width;
    canvas.height = lastValid.spec.height;
    completedFrames = 0;
    advanceFrame();
    console.info(`[gpu] \u4FEE\u8BA2 #${revCounter} \u5DF2\u542F\u7528\uFF08\u5E27\u8BA1\u6570\u5F52\u96F6\uFF09`);
  }
  function tryApply() {
    const v = validateGraph(spec, (k) => images.has(k));
    lastValidation = v;
    if (v.ok) {
      lastValid = { spec: cloneSpec(spec), order: v.order, feedbackSrcs: v.feedbackSrcs };
      if (!contextLost)
        commitFromLastValid();
    }
    renderUI();
  }
  function currentFrameTex() {
    if (!applied || completedFrames === 0)
      return null;
    const id = previewId && applied.res.nodeRT.has(previewId) ? previewId : applied.spec.outputId;
    if (!id)
      return null;
    const nrt = applied.res.nodeRT.get(id);
    if (!nrt)
      return null;
    return nrt.rts[nrt.pingpong ? completedFrames - 1 & 1 : 0].tex;
  }
  function displayCurrent() {
    const tex = currentFrameTex();
    if (tex)
      engine.display(tex);
  }
  function advanceFrame() {
    if (!applied || contextLost)
      return;
    engine.renderFrame(applied.res, completedFrames);
    completedFrames++;
    displayCurrent();
    setStatus();
  }
  var lastTick = 0;
  function tick(t) {
    requestAnimationFrame(tick);
    if (!running || contextLost || !applied)
      return;
    if (t - lastTick >= 33) {
      lastTick = t;
      advanceFrame();
    }
  }
  function exportPNG() {
    if (!applied || contextLost || completedFrames === 0)
      return;
    const rev = applied.rev;
    const frame = completedFrames - 1;
    const { width: w, height: hgt } = applied.spec;
    const tex = currentFrameTex();
    if (!tex)
      return;
    const px = engine.exportPixels(tex, w, hgt);
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = hgt;
    const ctx = cv.getContext("2d");
    const img = ctx.createImageData(w, hgt);
    for (let y = 0; y < hgt; y++) {
      const src = (hgt - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    cv.toBlob((blob) => {
      if (!blob)
        return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `graph-r${rev}-f${frame}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5e3);
    }, "image/png");
  }
  function onContextLost(e) {
    e.preventDefault();
    contextLost = true;
    setStatus();
    renderUI();
  }
  function onContextRestored() {
    contextLost = false;
    engine.createGLResources();
    if (lastValid && (!applied || JSON.stringify(lastValid.spec) !== JSON.stringify(applied.spec))) {
      commitFromLastValid();
    } else if (applied) {
      applied.res = engine.buildRevision(applied.spec, applied.order, applied.feedbackSrcs, applied.rev, images);
      for (let f = 0; f < completedFrames; f++)
        engine.renderFrame(applied.res, f);
      displayCurrent();
      console.info(`[gpu] \u4E0A\u4E0B\u6587\u6062\u590D\uFF1A\u5DF2\u91CD\u653E ${completedFrames} \u5E27\uFF0C\u7EE7\u7EED\u4E8E\u5E27 #${completedFrames}`);
    }
    setStatus();
    renderUI();
  }
  function handleUpload(nodeId, file) {
    const seq = ++uploadSeq;
    uploadErrors.delete(nodeId);
    createImageBitmap(file).then((bmp) => {
      if (seq !== uploadSeq) {
        bmp.close();
        return;
      }
      const key = `img-${nodeId}`;
      images.get(key)?.close();
      images.set(key, bmp);
      const n = spec.nodes.find((x) => x.id === nodeId);
      if (n && n.type === "input")
        n.imageKey = key;
      tryApply();
    }).catch(() => {
      if (seq !== uploadSeq)
        return;
      uploadErrors.set(nodeId, "\u56FE\u50CF\u89E3\u7801\u5931\u8D25\uFF08\u8BF7\u9009\u62E9 PNG/JPEG \u7B49\u4F4D\u56FE\uFF09");
      renderUI();
    });
  }
  function exampleFeedbackSpec() {
    return {
      width: 512,
      height: 512,
      nodes: [
        { id: "n_in", type: "input", name: "\u8F93\u5165\u56FE\u50CF", inputs: {}, imageKey: "demo" },
        { id: "n_prev", type: "prevframe", name: "\u4E0A\u4E00\u5E27", inputs: { src: "n_mix" } },
        { id: "n_blur", type: "blur", name: "\u67D4\u5316", inputs: { src: "n_prev" }, radius: 6 },
        {
          id: "n_fade",
          type: "colormatrix",
          name: "\u8870\u51CF 0.94",
          inputs: { src: "n_blur" },
          matrix: [
            0.94,
            0,
            0,
            0,
            0,
            0,
            0.94,
            0,
            0,
            0,
            0,
            0,
            0.94,
            0,
            0,
            0,
            0,
            0,
            0.94,
            0
          ]
        },
        { id: "n_mix", type: "blend", name: "\u53E0\u52A0 over", inputs: { a: "n_in", b: "n_fade" }, mode: "over", factor: 1 }
      ],
      outputId: "n_mix"
    };
  }
  function exampleCycleSpec() {
    return {
      width: 512,
      height: 512,
      nodes: [
        { id: "c_a", type: "colormatrix", name: "A \u77E9\u9635", inputs: { src: "c_b" }, matrix: IDENTITY_MATRIX.slice() },
        { id: "c_b", type: "blend", name: "B \u6DF7\u5408", inputs: { a: "c_a", b: "c_a" }, mode: "over", factor: 1 }
      ],
      outputId: "c_a"
    };
  }
  async function makeDemoImage() {
    const c = new OffscreenCanvas(512, 512);
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0, "rgba(40,90,220,0.85)");
    g.addColorStop(1, "rgba(200,40,140,0.55)");
    x.fillStyle = g;
    x.fillRect(0, 0, 512, 512);
    const blobs = [
      [150, 160, 90, "rgba(255,220,80,0.75)"],
      [330, 200, 110, "rgba(80,255,190,0.6)"],
      [250, 360, 100, "rgba(255,255,255,0.5)"]
    ];
    for (const [cx, cy, r, col] of blobs) {
      const rg = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      rg.addColorStop(0, col);
      rg.addColorStop(1, "rgba(0,0,0,0)");
      x.fillStyle = rg;
      x.beginPath();
      x.arc(cx, cy, r, 0, Math.PI * 2);
      x.fill();
    }
    x.fillStyle = "rgba(255,255,255,0.9)";
    x.font = "bold 56px system-ui, sans-serif";
    x.fillText("DEMO", 160, 280);
    return createImageBitmap(c);
  }
  function setStatus() {
    const parts = [
      `\u4FEE\u8BA2 #${applied ? applied.rev : "\u2014"}`,
      `\u5E27 #${completedFrames > 0 ? completedFrames - 1 : "\u2014"}\uFF08\u4E0B\u4E00\u5E27 ${completedFrames}\uFF09`,
      running ? "\u8FD0\u884C\u4E2D" : "\u5DF2\u6682\u505C",
      engine && engine.useFloat ? "RGBA16F \u7EBF\u6027" : "RGBA8 \u7EBF\u6027\uFF08\u56DE\u9000\uFF09",
      engine ? `GPU \u7EB9\u7406 ${engine.texCount}` : ""
    ];
    if (contextLost)
      parts.push("\u26A0 \u4E0A\u4E0B\u6587\u5DF2\u4E22\u5931");
    $("status").textContent = parts.filter(Boolean).join(" \xB7 ");
    $("btnRun").textContent = running ? "\u6682\u505C" : "\u7EE7\u7EED";
  }
  function renderErrors() {
    const box = $("errors");
    box.innerHTML = "";
    const items = [];
    if (lastValidation && !lastValidation.ok) {
      for (const e of lastValidation.errors) {
        const name = e.nodeId ? spec.nodes.find((n) => n.id === e.nodeId)?.name ?? e.nodeId : "\u56FE";
        items.push(`[${name}] ${e.message}`);
      }
    }
    for (const [nodeId, msg] of uploadErrors) {
      const name = spec.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
      items.push(`[${name}] ${msg}`);
    }
    if (items.length === 0) {
      box.append(h("div", { class: "ok" }, ["\u2713 \u5019\u9009\u56FE\u6709\u6548\uFF0C\u5DF2\u4F5C\u4E3A\u5F53\u524D\u4FEE\u8BA2\u8FD0\u884C"]));
      return;
    }
    box.append(
      h("div", { class: "err-banner" }, [
        `\u2717 \u5019\u9009\u672A\u901A\u8FC7\u9A8C\u8BC1\uFF08${items.length} \u9879\uFF09\u2014\u2014\u5DF2\u4FDD\u7559\u4FEE\u8BA2 #${applied ? applied.rev : "\u2014"} \u7684\u53EF\u7528\u72B6\u6001`
      ])
    );
    for (const it of items)
      box.append(h("div", { class: "err-item" }, [it]));
  }
  function nodeErrors(id) {
    if (!lastValidation)
      return [];
    return lastValidation.errors.filter((e) => e.nodeId === id).map((e) => e.message);
  }
  function defaultNode(type) {
    const id = `n${++idSeq}`;
    switch (type) {
      case "input":
        return { id, type, name: "\u8F93\u5165\u56FE\u50CF", inputs: {}, imageKey: null };
      case "colormatrix":
        return { id, type, name: "\u989C\u8272\u77E9\u9635", inputs: { src: null }, matrix: IDENTITY_MATRIX.slice() };
      case "blur":
        return { id, type, name: "\u9AD8\u65AF\u6A21\u7CCA", inputs: { src: null }, radius: 4 };
      case "prevframe":
        return { id, type, name: "\u4E0A\u4E00\u5E27", inputs: { src: null } };
      case "blend":
        return { id, type, name: "\u6DF7\u5408", inputs: { a: null, b: null }, mode: "over", factor: 0.5 };
    }
  }
  function deleteNode(id) {
    spec.nodes = spec.nodes.filter((n) => n.id !== id);
    for (const n of spec.nodes) {
      for (const s of Object.keys(n.inputs)) {
        if (n.inputs[s] === id)
          n.inputs[s] = null;
      }
    }
    if (spec.outputId === id)
      spec.outputId = null;
    if (previewId === id)
      previewId = null;
    tryApply();
  }
  function slotSelect(node, slot) {
    const sel = h("select", {
      onchange: (e) => {
        node.inputs[slot] = e.target.value || null;
        tryApply();
      }
    });
    sel.append(h("option", { value: "" }, ["\uFF08\u672A\u8FDE\u63A5\uFF09"]));
    for (const other of spec.nodes) {
      if (other.id === node.id && node.type !== "prevframe")
        continue;
      const o = h("option", { value: other.id }, [`${other.name} (${other.id})`]);
      if (node.inputs[slot] === other.id)
        o.selected = true;
      sel.append(o);
    }
    return sel;
  }
  function nodeBody(node) {
    const body = h("div", { class: "card-body" });
    switch (node.type) {
      case "input": {
        const file = h("input", { type: "file", accept: "image/png,image/*" });
        file.addEventListener("change", () => {
          const f = file.files?.[0];
          if (f)
            handleUpload(node.id, f);
        });
        body.append(file);
        body.append(
          h("div", { class: "muted" }, [
            node.imageKey && images.has(node.imageKey) ? "\u5DF2\u52A0\u8F7D\u56FE\u50CF" : "\u672A\u52A0\u8F7D\u56FE\u50CF\uFF08\u5019\u9009\u5C06\u88AB\u62D2\u7EDD\uFF09"
          ])
        );
        const ue = uploadErrors.get(node.id);
        if (ue)
          body.append(h("div", { class: "err-item" }, [ue]));
        break;
      }
      case "colormatrix": {
        const grid = h("div", { class: "matrix" });
        const m = node.matrix;
        for (let i = 0; i < 20; i++) {
          if (i % 5 === 4)
            grid.append(h("span", { class: "plus" }, ["+"]));
          const inp = h("input", { type: "number", step: "0.05", value: String(m[i]), class: "mcell" });
          inp.addEventListener("change", () => {
            const v = parseFloat(inp.value);
            node.matrix[i] = Number.isFinite(v) ? v : 0;
            tryApply();
          });
          grid.append(inp);
        }
        body.append(grid);
        body.append(h("div", { class: "muted" }, ["\u884C\uFF1AR G B A +\u504F\u79FB\uFF08\u7EBF\u6027\u9884\u4E58\u7A7A\u95F4\uFF09"]));
        break;
      }
      case "blur": {
        const val = h("span", { class: "val" }, [String(node.radius ?? 0)]);
        const range = h("input", { type: "range", min: "0", max: "32", step: "1", value: String(node.radius ?? 0) });
        range.addEventListener("input", () => {
          val.textContent = range.value;
        });
        range.addEventListener("change", () => {
          node.radius = parseInt(range.value, 10);
          tryApply();
        });
        body.append(h("div", { class: "row" }, [h("label", {}, ["\u534A\u5F84"]), range, val]));
        break;
      }
      case "blend": {
        const sel = h("select", {
          onchange: (e) => {
            node.mode = e.target.value;
            tryApply();
          }
        });
        for (const md of BLEND_MODES) {
          const o = h("option", { value: md }, [BLEND_MODE_LABEL[md]]);
          if (node.mode === md)
            o.selected = true;
          sel.append(o);
        }
        const val = h("span", { class: "val" }, [String(node.factor ?? 0)]);
        const range = h("input", { type: "range", min: "0", max: "1", step: "0.01", value: String(node.factor ?? 0) });
        range.addEventListener("input", () => {
          val.textContent = range.value;
        });
        range.addEventListener("change", () => {
          node.factor = parseFloat(range.value);
          tryApply();
        });
        body.append(h("div", { class: "row" }, [h("label", {}, ["\u6A21\u5F0F"]), sel]));
        body.append(h("div", { class: "row" }, [h("label", {}, ["a \u5360\u6BD4"]), range, val]));
        break;
      }
      case "prevframe":
        body.append(h("div", { class: "muted" }, ["\u8F93\u51FA = \u8F93\u5165\u5728\u4E0A\u4E00\u5B8C\u6574\u5E27\u7684\u503C\uFF1B\u7B2C 0 \u5E27\u4E3A\u900F\u660E\u3002\u53CD\u9988\u8FB9\u4E0D\u53C2\u4E0E\u540C\u5E27\u73AF\u68C0\u6D4B\u3002"]));
        break;
    }
    return body;
  }
  function renderNodeList() {
    const list = $("nodeList");
    list.innerHTML = "";
    cardEls.clear();
    slotEls.clear();
    for (const node of spec.nodes) {
      const card = h("div", { class: "card" + (previewId === node.id ? " previewing" : "") });
      cardEls.set(node.id, card);
      const nameInp = h("input", { class: "name", value: node.name });
      nameInp.addEventListener("change", () => {
        node.name = nameInp.value;
        tryApply();
      });
      const outRadio = h("input", { type: "radio", name: "outputNode", checked: spec.outputId === node.id });
      outRadio.addEventListener("change", () => {
        spec.outputId = node.id;
        tryApply();
      });
      const head = h("div", { class: "card-head" }, [
        h("span", { class: `badge t-${node.type}` }, [TYPE_LABEL[node.type]]),
        nameInp,
        h("label", { class: "out" }, [outRadio, "\u8F93\u51FA"]),
        h("button", {
          class: "mini",
          title: "\u5728\u753B\u5E03\u4E2D\u9884\u89C8\u8BE5\u8282\u70B9",
          onclick: () => {
            previewId = node.id;
            displayCurrent();
            renderUI();
          }
        }, ["\u9884\u89C8"]),
        h("button", { class: "mini danger", title: "\u5220\u9664\u8282\u70B9", onclick: () => deleteNode(node.id) }, ["\xD7"])
      ]);
      card.append(head);
      card.append(nodeBody(node));
      const slots = SLOTS[node.type];
      if (slots.length) {
        const box = h("div", { class: "slots" });
        for (const slot of slots) {
          const row = h("div", { class: "slot" + (node.type === "prevframe" ? " feedback" : "") }, [
            h("span", { class: "slot-name" }, [node.type === "prevframe" ? `${slot}\uFF08\u4E0A\u4E00\u5E27\uFF09` : slot]),
            slotSelect(node, slot)
          ]);
          slotEls.set(`${node.id}:${slot}`, row);
          box.append(row);
        }
        card.append(box);
      }
      const errs = nodeErrors(node.id);
      if (errs.length) {
        const eb = h("div", { class: "node-errs" });
        for (const e of errs)
          eb.append(h("div", { class: "err-item" }, [e]));
        card.append(eb);
      }
      list.append(card);
    }
  }
  function drawEdges() {
    const svg = $("edges");
    const list = $("nodeList");
    svg.innerHTML = "";
    const w = list.offsetWidth;
    const hgt = list.offsetHeight;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(hgt));
    svg.style.width = `${w}px`;
    svg.style.height = `${hgt}px`;
    const NS = "http://www.w3.org/2000/svg";
    for (const node of spec.nodes) {
      for (const slot of SLOTS[node.type]) {
        const src = node.inputs[slot];
        if (!src)
          continue;
        const fromCard = cardEls.get(src);
        const toCard = cardEls.get(node.id);
        const toSlot = slotEls.get(`${node.id}:${slot}`);
        if (!fromCard || !toCard || !toSlot)
          continue;
        const x1 = fromCard.offsetLeft + fromCard.offsetWidth;
        const y1 = fromCard.offsetTop + fromCard.offsetHeight / 2;
        const x2 = toCard.offsetLeft;
        const y2 = toCard.offsetTop + toSlot.offsetTop + toSlot.offsetHeight / 2;
        const p = document.createElementNS(NS, "path");
        p.setAttribute("d", `M ${x1} ${y1} C ${x1 + 60} ${y1}, ${x2 - 60} ${y2}, ${x2} ${y2}`);
        p.setAttribute("class", "edge" + (node.type === "prevframe" ? " feedback" : ""));
        svg.append(p);
        const dot = document.createElementNS(NS, "circle");
        dot.setAttribute("cx", String(x2));
        dot.setAttribute("cy", String(y2));
        dot.setAttribute("r", "3");
        dot.setAttribute("class", "edge-dot" + (node.type === "prevframe" ? " feedback" : ""));
        svg.append(dot);
      }
    }
  }
  function renderUI() {
    setStatus();
    renderErrors();
    renderNodeList();
    requestAnimationFrame(drawEdges);
  }
  function wireToolbar() {
    $("btnRun").addEventListener("click", () => {
      running = !running;
      setStatus();
    });
    $("btnStep").addEventListener("click", () => {
      running = false;
      advanceFrame();
      setStatus();
    });
    $("btnExport").addEventListener("click", exportPNG);
    $("btnLoss").addEventListener("click", () => engine.loseContext());
    $("btnRestore").addEventListener("click", () => engine.restoreContext());
    $("btnExampleFeedback").addEventListener("click", () => {
      spec = exampleFeedbackSpec();
      previewId = null;
      tryApply();
    });
    $("btnExampleCycle").addEventListener("click", () => {
      spec = exampleCycleSpec();
      previewId = null;
      tryApply();
    });
    const wInp = $("sizeW");
    const hInp = $("sizeH");
    const onSize = () => {
      spec.width = parseInt(wInp.value, 10);
      spec.height = parseInt(hInp.value, 10);
      tryApply();
    };
    wInp.addEventListener("change", onSize);
    hInp.addEventListener("change", onSize);
    for (const btn of document.querySelectorAll("#addNode button")) {
      btn.addEventListener("click", () => {
        spec.nodes.push(defaultNode(btn.dataset.type));
        tryApply();
      });
    }
  }
  async function boot() {
    engine = new Engine(canvas);
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    images.set("demo", await makeDemoImage());
    spec = exampleFeedbackSpec();
    wireToolbar();
    $("sizeW").value = String(spec.width);
    $("sizeH").value = String(spec.height);
    tryApply();
    running = true;
    setStatus();
    requestAnimationFrame(tick);
  }
  boot().catch((e) => {
    $("errors").append(h("div", { class: "err-banner" }, [`\u521D\u59CB\u5316\u5931\u8D25\uFF1A${e instanceof Error ? e.message : String(e)}`]));
  });
})();
