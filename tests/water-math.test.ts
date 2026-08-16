import { describe, expect, it } from "vitest";

import { cross, dot, lookAt, mean, multiply, normalize, percentile, perspective, type Vec3 } from "../src/lib/water-math";

/** Applies a column-major 4x4 matrix to a point and returns clip-space xyzw. */
function transform(matrix: Float32Array, point: [number, number, number, number]) {
  return [0, 1, 2, 3].map((row) => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row] * point[3]);
}

describe("vector helpers", () => {
  it("normalises and leaves the zero vector finite", () => {
    expect(normalize([3, 0, 4])).toEqual([0.6, 0, 0.8]);
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("computes cross and dot products with the right handedness", () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    expect(cross([0, 1, 0], [1, 0, 0])).toEqual([0, 0, -1]);
    expect(dot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it("returns fresh arrays instead of mutating inputs", () => {
    const input: Vec3 = [2, 0, 0];
    const output = normalize(input);
    expect(output).not.toBe(input);
    expect(input).toEqual([2, 0, 0]);
  });
});

describe("lookAt", () => {
  it("looks down -Z from +Z with a pure translation", () => {
    const view = lookAt([0, 0, 5], [0, 0, 0]);
    expect(Array.from(view)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0, -0, -5, 1]);
    expect(transform(view, [0, 0, 0, 1])).toEqual([0, 0, -5, 1]);
  });

  it("keeps world up pointing up in view space", () => {
    const view = lookAt([10, 3, -7], [0, 1.4, -22]);
    const up = transform(view, [0, 1, 0, 0]);
    expect(up[1]).toBeGreaterThan(0.9);
  });
});

describe("perspective", () => {
  const fov = 52 * Math.PI / 180;

  it("defaults to the WebGPU zero-to-one depth layout", () => {
    const near = 0.12;
    const far = 50000;
    const matrix = perspective(fov, 16 / 9, near, far);
    expect(matrix).toEqual(perspective(fov, 16 / 9, near, far, "zero-to-one"));
    const f = 1 / Math.tan(fov / 2);
    expect(matrix[0]).toBeCloseTo(f / (16 / 9), 6);
    expect(matrix[5]).toBeCloseTo(f, 6);
    expect(matrix[10]).toBeCloseTo(far / (near - far), 6);
    expect(matrix[11]).toBe(-1);
    expect(matrix[14]).toBeCloseTo(near * far / (near - far), 4);
    expect(matrix[15]).toBe(0);
  });

  it("produces the classic OpenGL entries for minus-one-to-one", () => {
    const near = 0.12;
    const far = 50000;
    const matrix = perspective(fov, 16 / 9, near, far, "minus-one-to-one");
    expect(matrix[10]).toBeCloseTo((far + near) / (near - far), 6);
    expect(matrix[14]).toBeCloseTo(2 * far * near / (near - far), 4);
    expect(matrix[11]).toBe(-1);
    // x/y scaling is shared between the two conventions
    const reference = perspective(fov, 16 / 9, near, far);
    expect(matrix[0]).toBe(reference[0]);
    expect(matrix[5]).toBe(reference[5]);
  });

  it("maps every eye-space depth to the same window depth in both conventions", () => {
    const cases: Array<[number, number]> = [[0.12, 50000], [0.1, 100], [1, 1000]];
    for (const [near, far] of cases) {
      const webgpu = perspective(fov, 1.5, near, far, "zero-to-one");
      const gl = perspective(fov, 1.5, near, far, "minus-one-to-one");
      for (const distance of [near, near * 1.5, 0.7, 5, 30, 250, far * 0.5, far]) {
        const clipWebGpu = transform(webgpu, [0.3, -0.2, -distance, 1]);
        const clipGl = transform(gl, [0.3, -0.2, -distance, 1]);
        const windowWebGpu = clipWebGpu[2] / clipWebGpu[3];
        const windowGl = (clipGl[2] / clipGl[3]) * 0.5 + 0.5;
        const expected = far * (distance - near) / (distance * (far - near));
        expect(windowWebGpu).toBeCloseTo(expected, 5);
        expect(windowGl).toBeCloseTo(expected, 5);
        expect(windowGl).toBeCloseTo(windowWebGpu, 5);
        // x/y are unaffected by the depth convention
        expect(clipGl[0]).toBeCloseTo(clipWebGpu[0], 6);
        expect(clipGl[1]).toBeCloseTo(clipWebGpu[1], 6);
      }
    }
  });

  it("puts the near plane at 0 and the far plane at 1 in window depth", () => {
    const near = 0.12;
    const far = 50000;
    const gl = perspective(fov, 1, near, far, "minus-one-to-one");
    const nearClip = transform(gl, [0, 0, -near, 1]);
    const farClip = transform(gl, [0, 0, -far, 1]);
    expect(nearClip[2] / nearClip[3]).toBeCloseTo(-1, 5);
    expect(farClip[2] / farClip[3]).toBeCloseTo(1, 5);
  });
});

describe("multiply", () => {
  const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  it("treats the identity as neutral", () => {
    const matrix = lookAt([1, 2, 3], [0, 0, 0]);
    expect(multiply(identity, matrix)).toEqual(matrix);
    expect(multiply(matrix, identity)).toEqual(matrix);
  });

  it("composes column-major transforms left to right", () => {
    const translate = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    const scale = new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
    // (translate * scale) applies the scale first, then the translation.
    expect(transform(multiply(translate, scale), [1, 1, 1, 1])).toEqual([7, 9, 11, 1]);
    expect(transform(multiply(scale, translate), [1, 1, 1, 1])).toEqual([12, 21, 32, 1]);
  });
});

describe("statistics", () => {
  const frameTimes = [16, 17, 33, 16.5, 12, 70, 16];

  it("computes the mean and nearest-rank percentiles used by the metrics", () => {
    expect(mean(frameTimes)).toBeCloseTo(25.785714285714285, 12);
    expect(percentile(frameTimes, 0.95)).toBe(70);
    expect(percentile(frameTimes, 0.99)).toBe(70);
    expect(percentile(frameTimes, 0.5)).toBe(16.5);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
  });

  it("returns 0 for empty inputs and does not reorder the input", () => {
    expect(mean([])).toBe(0);
    expect(percentile([], 0.95)).toBe(0);
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});
