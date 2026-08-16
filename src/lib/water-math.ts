// Small column-major matrix / vector helpers and statistics.
// Everything returns fresh arrays; nothing mutates input.

export type Vec3 = [number, number, number];

/**
 * Which normalised-device depth range a projection matrix targets:
 * `"zero-to-one"` (WebGPU, Metal, D3D) or `"minus-one-to-one"` (OpenGL /
 * WebGL2). Both map the same eye-space z to the same window depth after the
 * respective viewport transform, so a scene depth-tests identically.
 */
export type ProjectionDepthRange = "zero-to-one" | "minus-one-to-one";

export function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Right-handed view matrix with a fixed +Y world up, column-major. */
export function lookAt(eye: Vec3, target: Vec3): Float32Array<ArrayBuffer> {
  const z = normalize([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalize(cross([0, 1, 0], z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

/**
 * Column-major perspective projection. The default `"zero-to-one"` range is
 * the WebGPU convention; `"minus-one-to-one"` produces the classic OpenGL
 * matrix whose depth, after the GL viewport transform, equals the WebGPU one.
 */
export function perspective(
  fovRadians: number,
  aspect: number,
  near: number,
  far: number,
  depthRange: ProjectionDepthRange = "zero-to-one",
): Float32Array<ArrayBuffer> {
  const f = 1 / Math.tan(fovRadians / 2);
  if (depthRange === "minus-one-to-one") {
    return new Float32Array([
      f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * near * far) / (near - far), 0,
    ]);
  }
  return new Float32Array([
    f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (near * far) / (near - far), 0,
  ]);
}

/** Column-major 4x4 product `left * right`. */
export function multiply(left: Float32Array<ArrayBuffer>, right: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const output = new Float32Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      output[column * 4 + row] = left[row] * right[column * 4] + left[4 + row] * right[column * 4 + 1] + left[8 + row] * right[column * 4 + 2] + left[12 + row] * right[column * 4 + 3];
    }
  }
  return output;
}

/** Nearest-rank percentile: sorts a copy and takes `floor(length * fraction)`. */
export function percentile(values: readonly number[], fraction: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function mean(values: readonly number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
