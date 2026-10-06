// shaders.ts —— 全部 GLSL ES 3.00 着色器。
// 内部管线：线性 RGB + 预乘 alpha（RGBA8 纹理）。
// 输入纹理为 SRGB8_ALPHA8，采样时由硬件完成 sRGB -> 线性 解码，随后在着色器内预乘。

export const VS_FULLSCREEN = `#version 300 es
out vec2 v_uv;
void main() {
  // 无属性全屏三角形
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
`;

// 原样拷贝（反馈换页、显示纹理拷贝）
export const FS_COPY = HEAD + `
void main() { o = texture(u_tex, v_uv); }
`;

// 输入节点：硬件 sRGB 解码后做预乘
export const FS_INPUT = HEAD + `
void main() {
  vec4 c = texture(u_tex, v_uv);
  o = vec4(c.rgb * c.a, c.a);
}
`;

// 颜色矩阵：作用于预乘向量；RGB 偏移乘以 alpha 以保持预乘不变式
export const FS_MATRIX = HEAD + `
uniform mat4 u_m;
uniform vec4 u_off;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o = u_m * c + vec4(u_off.rgb * c.a, u_off.a);
}
`;

// 可分离高斯模糊（两个方向各一趟）
export const FS_BLUR = HEAD + `
uniform vec2 u_dir;      // (1/w,0) 或 (0,1/h)
uniform int u_radius;
uniform float u_w[33];
void main() {
  vec4 s = texture(u_tex, v_uv) * u_w[0];
  for (int i = 1; i <= 32; i++) {
    if (i > u_radius) break;
    vec2 d = u_dir * float(i);
    s += (texture(u_tex, v_uv + d) + texture(u_tex, v_uv - d)) * u_w[i];
  }
  o = s;
}
`;

// 混合：A=底，B=顶，全部在预乘空间
export const FS_BLEND = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform int u_mode;   // 0 over / 1 add / 2 multiply / 3 screen
uniform float u_f;
void main() {
  vec4 a = texture(u_a, v_uv);
  vec4 b = texture(u_b, v_uv);
  vec4 r;
  if (u_mode == 0) {                 // over：B 盖 A
    r = b + a * (1.0 - b.a);
  } else if (u_mode == 1) {          // add
    r = a + b;
  } else if (u_mode == 2) {          // multiply
    r = vec4(a.rgb * (1.0 - b.a) + b.rgb * (1.0 - a.a) + a.rgb * b.rgb,
             a.a + b.a * (1.0 - a.a));
  } else {                           // screen（预乘下简式）
    r = vec4(a.rgb + b.rgb - a.rgb * b.rgb,
             a.a + b.a * (1.0 - a.a));
  }
  o = mix(a, r, u_f);
}
`;

const ENCODE = `
vec3 lin2srgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec4 unpremult(vec4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  vec3 rgb = a > 1e-5 ? clamp(c.rgb / max(c.a, 1e-5), 0.0, 1.0) : vec3(0.0);
  return vec4(rgb, a);
}
`;

// 预览：线性预乘 -> sRGB 直出，棋盘格背景显示半透明
export const FS_DISPLAY = HEAD + ENCODE + `
uniform float u_cell;
void main() {
  vec4 c = unpremult(texture(u_tex, v_uv));
  vec2 g = floor(gl_FragCoord.xy / u_cell);
  float ck = mod(g.x + g.y, 2.0);
  vec3 bg = mix(vec3(0.26), vec3(0.42), ck);
  o = vec4(mix(bg, lin2srgb(c.rgb), c.a), 1.0);
}
`;

// 导出：线性预乘 -> 普通 sRGB（直出 alpha），供 readPixels 写 PNG
export const FS_EXPORT = HEAD + ENCODE + `
void main() {
  vec4 c = unpremult(texture(u_tex, v_uv));
  o = vec4(lin2srgb(c.rgb), c.a);
}
`;
