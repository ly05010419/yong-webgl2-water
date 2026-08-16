// Shader program creation for the WebGL2 water fallback.
//
// `composeShaderSource` is a pure function (unit-tested in node) that builds
// the GLSL ES 3.00 preamble; `createGlProgram` compiles + links and turns
// driver logs into readable Chinese errors that carry the program label, the
// offending line and the surrounding source.

import { bindCachedProgram, forgetGlProgram } from "./gl-state-cache";
import type { GlProgram, GlShaderStage } from "./types";

/** `#define` values accepted by `composeShaderSource`. Numbers are stringified verbatim
 *  (`1` stays an int literal — pass `"1.0"` when the shader needs a float). */
export type ShaderDefines = Readonly<Record<string, string | number>>;

/** Options for `createGlProgram`. Sources are shader *bodies*: no `#version`, no precision lines. */
export interface GlProgramSource {
  readonly label: string;
  readonly vertexSource: string;
  readonly fragmentSource: string;
  readonly defines?: ShaderDefines;
}

/** First line of every composed shader. Must be the very first bytes of the source. */
export const GLSL_VERSION_LINE = "#version 300 es";

/**
 * Precision preamble emitted for both stages (docs/webgl2-port/spec-compute.md R19). Fragment
 * shaders have no default float precision in ES 3.00, and `sampler2D`
 * defaults to lowp everywhere; the Rusanov fluxes and 128×128 FFT need highp.
 */
export const GLSL_PRECISION_PREAMBLE = "precision highp float;\nprecision highp int;\nprecision highp sampler2D;";

const DEFINE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_DIRECTIVE_PATTERN = /^\s*#\s*version\b/m;
const LOG_LINE_PATTERN = /(?:ERROR|WARNING):\s*\d+:(\d+)/g;

function formatDefines(defines: ShaderDefines | undefined): readonly string[] {
  if (!defines) return [];
  return Object.entries(defines).map(([name, value]) => {
    if (!DEFINE_NAME_PATTERN.test(name)) {
      throw new Error(`着色器宏名称「${name}」不合法：只允许字母、数字与下划线，且不能以数字开头。`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`着色器宏「${name}」的值必须是有限数或字符串，收到 ${String(value)}。`);
    }
    return `#define ${name} ${String(value)}`;
  });
}

/**
 * Builds the final GLSL source: `#version 300 es` on line 1, then `#define`s,
 * then the highp precision preamble, then the body. Throws if the body already
 * carries a `#version` directive (it would no longer be on line 1).
 * The number of preamble lines is `preambleLineCount(defines)`.
 */
export function composeShaderSource(stage: GlShaderStage, body: string, defines?: ShaderDefines): string {
  if (VERSION_DIRECTIVE_PATTERN.test(body)) {
    throw new Error(`${stage} 着色器主体不得包含 #version 指令：createGlProgram 会自动加在第一行。`);
  }
  if (body.trim().length === 0) {
    throw new Error(`${stage} 着色器主体为空。`);
  }
  const lines = [GLSL_VERSION_LINE, ...formatDefines(defines), GLSL_PRECISION_PREAMBLE, `// stage: ${stage}`, body];
  return `${lines.join("\n")}\n`;
}

/** Lines the preamble occupies before the body starts (for mapping driver line numbers). */
export function preambleLineCount(defines?: ShaderDefines): number {
  return composeShaderSource("fragment", "void main() {}", defines).split("\n").indexOf("void main() {}");
}

function excerptAround(source: string, log: string): string {
  const lines = source.split("\n");
  const seen = new Set<number>();
  const excerpts: string[] = [];
  for (const match of log.matchAll(LOG_LINE_PATTERN)) {
    const line = Number.parseInt(match[1], 10);
    if (!Number.isFinite(line) || seen.has(line)) continue;
    seen.add(line);
    const start = Math.max(1, line - 2);
    const end = Math.min(lines.length, line + 2);
    const block: string[] = [];
    for (let index = start; index <= end; index += 1) {
      block.push(`${index === line ? ">" : " "} ${String(index).padStart(4, " ")} | ${lines[index - 1] ?? ""}`);
    }
    excerpts.push(block.join("\n"));
  }
  return excerpts.join("\n----\n");
}

function compileStage(gl: WebGL2RenderingContext, label: string, stage: GlShaderStage, source: string): WebGLShader {
  const shader = gl.createShader(stage === "vertex" ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
  if (!shader) throw new Error(`无法创建 ${stage} 着色器对象（${label}）。`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const compiled: unknown = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (compiled === true || gl.isContextLost()) return shader;
  const log = gl.getShaderInfoLog(shader) ?? "(驱动未返回日志)";
  gl.deleteShader(shader);
  const excerpt = excerptAround(source, log);
  throw new Error(
    `着色器编译失败（${label} · ${stage}）：\n${log.trim()}${excerpt ? `\n出错位置：\n${excerpt}` : ""}`,
  );
}

/**
 * Compiles and links a program from two shader bodies. Sources are composed
 * with `composeShaderSource`, so callers never write `#version` or precision.
 * Shaders are detached and deleted after linking; the program is returned frozen.
 */
export function createGlProgram(gl: WebGL2RenderingContext, source: GlProgramSource): GlProgram {
  const { label, defines } = source;
  const vertexSource = composeShaderSource("vertex", source.vertexSource, defines);
  const fragmentSource = composeShaderSource("fragment", source.fragmentSource, defines);
  const vertexShader = compileStage(gl, label, "vertex", vertexSource);
  let fragmentShader: WebGLShader;
  try {
    fragmentShader = compileStage(gl, label, "fragment", fragmentSource);
  } catch (error) {
    gl.deleteShader(vertexShader);
    throw error;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(`无法创建着色器程序对象（${label}）。`);
  }
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.detachShader(program, vertexShader);
  gl.detachShader(program, fragmentShader);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  const linked: unknown = gl.getProgramParameter(program, gl.LINK_STATUS);
  if (linked !== true && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(program) ?? "(驱动未返回日志)";
    gl.deleteProgram(program);
    throw new Error(`着色器链接失败（${label}）：\n${log.trim()}`);
  }
  return Object.freeze({ label, handle: program });
}

/**
 * Makes `program` current, skipping the call when it already is. Every pass
 * goes through this rather than `gl.useProgram`: the water pass alone issues
 * the same `useProgram` twice per frame (clipmap then crest patch), and the
 * atlas FFT re-selects one of four programs 17 times.
 */
export function bindGlProgram(gl: WebGL2RenderingContext, program: GlProgram): void {
  bindCachedProgram(gl, program.handle);
}

/** Deletes the program. Safe to call once; the frozen record becomes stale afterwards. */
export function deleteGlProgram(gl: WebGL2RenderingContext, program: GlProgram): void {
  gl.deleteProgram(program.handle);
  // A deleted program stays "current" until the next `useProgram`, so the cache
  // must forget it or the successor program's bind would be skipped.
  forgetGlProgram(gl, program.handle);
}

/**
 * Looks up uniform locations by name. Missing (or optimised-away) uniforms map
 * to `null` — that is not an error, but callers should not treat a `null`
 * location for something they rely on as success.
 */
export function uniformLocations<const Names extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: GlProgram,
  names: Names,
): Readonly<Record<Names[number], WebGLUniformLocation | null>> {
  const entries = names.map((name) => [name, gl.getUniformLocation(program.handle, name)] as const);
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<Names[number], WebGLUniformLocation | null>>;
}

/**
 * Binds a named `layout(std140) uniform Block { … }` to a UBO binding index.
 * Throws when the block is not active in the program (typo, or the shader never
 * reads it) or when `expectedByteLength` (e.g. 256 for WorldUniforms) does not
 * match the driver's std140 size — the two ways a UBO silently reads garbage.
 */
export function bindUniformBlock(
  gl: WebGL2RenderingContext,
  program: GlProgram,
  blockName: string,
  bindingIndex: number,
  expectedByteLength?: number,
): void {
  if (!Number.isInteger(bindingIndex) || bindingIndex < 0) {
    throw new Error(`UBO 绑定索引必须是非负整数（${program.label} · ${blockName} · 收到 ${bindingIndex}）。`);
  }
  const blockIndex = gl.getUniformBlockIndex(program.handle, blockName);
  if (blockIndex === gl.INVALID_INDEX) {
    throw new Error(`着色器程序「${program.label}」中不存在活动的 uniform block「${blockName}」（未声明或从未被读取）。`);
  }
  if (expectedByteLength !== undefined) {
    const actual: unknown = gl.getActiveUniformBlockParameter(program.handle, blockIndex, gl.UNIFORM_BLOCK_DATA_SIZE);
    if (actual !== expectedByteLength) {
      throw new Error(
        `uniform block「${blockName}」在程序「${program.label}」中的 std140 大小为 ${String(actual)} 字节，` +
          `与约定的 ${expectedByteLength} 字节不一致。请核对字段顺序与类型。`,
      );
    }
  }
  gl.uniformBlockBinding(program.handle, blockIndex, bindingIndex);
}

/**
 * Assigns texture units 0..n-1 to the given sampler uniforms *in array order*
 * and returns the name → unit map. Uniforms that the compiler optimised away
 * still reserve their unit so the mapping stays stable across shader variants.
 * Side effect: leaves `program` as the current program.
 */
export function assignSamplerUnits<const Names extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: GlProgram,
  samplerNames: Names,
): Readonly<Record<Names[number], number>> {
  const unique = new Set<string>(samplerNames);
  if (unique.size !== samplerNames.length) {
    throw new Error(`assignSamplerUnits 收到重复的采样器名称（${program.label}）：${samplerNames.join(", ")}`);
  }
  bindGlProgram(gl, program);
  const entries = samplerNames.map((name, unit) => {
    const location = gl.getUniformLocation(program.handle, name);
    if (location !== null) gl.uniform1i(location, unit);
    return [name, unit] as const;
  });
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<Names[number], number>>;
}
