import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LONG_SCALE_RANGE,
  MEDIUM_SCALE_RANGE,
  SPECTRAL_CASCADES,
  SPECTRAL_LOG_SIZE,
  SPECTRAL_RESOLUTION,
  buildSpectralOceanData,
  buildSpectralTwiddleTable,
  deterministicRandom,
  resolveCascadeConfig,
  resolveCascadeScale,
  spectrumNormalisationFactor,
  wrapAngle,
} from "../src/lib/spectral-ocean";

function sha256(data: Float32Array): string {
  return createHash("sha256").update(Buffer.from(data.buffer, data.byteOffset, data.byteLength)).digest("hex");
}

// Snapshots captured from the WebGPU engine before the CPU logic was extracted;
// they pin the wave field bit-for-bit across backends.
const GOLDEN = {
  rng: [0.515507175354287, 0.3269679215736687, 0.23086118162609637, 0.297087806975469, 0.2367711872793734, 0.6335670994594693],
  twiddle: "2712eda37a75e72b3fa8d4f2825a4e5332b2f776e4d5b26bed03e55eddb8e2cd",
  cascades: [
    { index: 0, lengthScale: 240, initialSpectrum: "eaa48e5842fcaab4488c408adf698d1a674b10e74af295dfab6d4978583d768c", waveData: "f506f0e7ed81a4fac6b3d19b7d57f8f15732800ad5448670236e6bc52b8714f1" },
    { index: 1, lengthScale: 64, initialSpectrum: "ecb5809ff86f12ae150ad6dbe7571bbb3a98551f66ec6c8c6a5987cb9282bc9a", waveData: "90e26a4303b1f97802887e57c722e307b5fdadb6f800f4470436ffc9c0a734dc" },
    { index: 2, lengthScale: 12, initialSpectrum: "0d392bf33a76f203103faa586699ea56790980d3f6e11d32ccc08fb9a7b88dc5", waveData: "51bb0137fda21a78093b06b72a0da41c881b9ab270d8b7902981cebb0a40169d" },
    { index: 0, lengthScale: 133, initialSpectrum: "98a225dc630bdf53810c5d8261e7dca9ff2921a28c71bc5ddc5295e52dcdfb36", waveData: "3ffdc4621c0dc4302b28fe4da121b13a968e0ef42b3aeeeb8dc820b226ab0564" },
    { index: 1, lengthScale: 37, initialSpectrum: "974bbe5f07bd5f7c859c636ce2a36575cea4e2034ba476f5c4fbf95d1b38c3c1", waveData: "15bc4843eec049710a87145553f70542300f2f20d31453cd920cc4f64c2380a2" },
  ],
} as const;

describe("deterministicRandom", () => {
  it("reproduces the same sequence for the same seed", () => {
    const a = deterministicRandom(0x51f15e);
    const b = deterministicRandom(0x51f15e);
    const first = Array.from({ length: 64 }, () => a());
    const second = Array.from({ length: 64 }, () => b());
    expect(first).toEqual(second);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("matches the golden opening values of the long cascade seed", () => {
    const random = deterministicRandom(SPECTRAL_CASCADES[0].seed);
    expect(Array.from({ length: GOLDEN.rng.length }, () => random())).toEqual(GOLDEN.rng);
  });

  it("differs between seeds", () => {
    expect(deterministicRandom(1)()).not.toBe(deterministicRandom(2)());
  });
});

describe("cascade presets and scale resolution", () => {
  it("keeps the authored presets and ranges", () => {
    expect(SPECTRAL_RESOLUTION).toBe(128);
    expect(SPECTRAL_LOG_SIZE).toBe(7);
    expect(SPECTRAL_CASCADES.map((cascade) => cascade.lengthScale)).toEqual([240, 64, 12]);
    expect(SPECTRAL_CASCADES.map((cascade) => cascade.choppiness)).toEqual([1.18, 1.05, 0.40]);
    expect(LONG_SCALE_RANGE).toEqual([80, 480]);
    expect(MEDIUM_SCALE_RANGE).toEqual([24, 128]);
  });

  it("resolves the two runtime cascades from options and pins the third", () => {
    const options = { longCascadeScale: 133, mediumCascadeScale: 37 };
    expect(resolveCascadeScale(0, options)).toBe(133);
    expect(resolveCascadeScale(1, options)).toBe(37);
    expect(resolveCascadeScale(2, options)).toBe(12);
    expect(resolveCascadeConfig(1, options)).toEqual({ ...SPECTRAL_CASCADES[1], lengthScale: 37 });
    expect(resolveCascadeConfig(2, options)).toEqual({ ...SPECTRAL_CASCADES[2] });
  });
});

describe("spectrum helpers", () => {
  it("wraps angles into (-pi, pi]", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI * 0.5, 12);
  });

  it("uses the two polynomial branches of the normalisation factor", () => {
    expect(spectrumNormalisationFactor(0)).toBeCloseTo(0.163, 12);
    expect(spectrumNormalisationFactor(4.999)).toBeGreaterThan(0);
    expect(spectrumNormalisationFactor(5)).toBeCloseTo(-4.8e-8 * 625 + 1.07e-5 * 125 - 9.53e-4 * 25 + 5.9e-2 * 5 + 0.393, 12);
  });
});

describe("buildSpectralTwiddleTable", () => {
  it("lays out cos/sin/index pairs per Stockham stage", () => {
    const twiddle = buildSpectralTwiddleTable(SPECTRAL_RESOLUTION, SPECTRAL_LOG_SIZE);
    expect(twiddle.length).toBe(SPECTRAL_LOG_SIZE * SPECTRAL_RESOLUTION * 4);
    // stage 0, output 0: block 64, angle -0 (so the sine carries the sign of zero)
    expect(Array.from(twiddle.subarray(0, 4))).toEqual([1, -0, 0, 64]);
    // its mirrored partner at output + size/2 negates the rotation
    expect(Array.from(twiddle.subarray(64 * 4, 64 * 4 + 4))).toEqual([-1, 0, 0, 64]);
    // last stage: block 1, output 3 -> first index 6, angle -2*pi*3/128
    const lastStage = (SPECTRAL_LOG_SIZE - 1) * SPECTRAL_RESOLUTION;
    const entry = Array.from(twiddle.subarray((lastStage + 3) * 4, (lastStage + 3) * 4 + 4));
    expect(entry[2]).toBe(6);
    expect(entry[3]).toBe(7);
    expect(entry[0]).toBeCloseTo(Math.cos(-2 * Math.PI / 128 * 3), 6);
    expect(entry[1]).toBeCloseTo(Math.sin(-2 * Math.PI / 128 * 3), 6);
    expect(sha256(twiddle)).toBe(GOLDEN.twiddle);
  });
});

describe("buildSpectralOceanData", () => {
  const options = { longCascadeScale: 240, mediumCascadeScale: 64 };

  it("returns the texture-sized arrays the GPU uploads", () => {
    const data = buildSpectralOceanData(SPECTRAL_RESOLUTION, resolveCascadeConfig(0, options));
    expect(data.initialSpectrum.length).toBe(SPECTRAL_RESOLUTION * SPECTRAL_RESOLUTION * 4);
    expect(data.waveData.length).toBe(SPECTRAL_RESOLUTION * SPECTRAL_RESOLUTION * 4);
    expect(data.twiddle.length).toBe(SPECTRAL_LOG_SIZE * SPECTRAL_RESOLUTION * 4);
    expect(data.twiddle).toEqual(buildSpectralTwiddleTable(SPECTRAL_RESOLUTION, SPECTRAL_LOG_SIZE));
  });

  it("is deterministic and matches the pre-extraction golden hashes", () => {
    for (const golden of GOLDEN.cascades) {
      const config = { ...SPECTRAL_CASCADES[golden.index], lengthScale: golden.lengthScale };
      const first = buildSpectralOceanData(SPECTRAL_RESOLUTION, config);
      const second = buildSpectralOceanData(SPECTRAL_RESOLUTION, config);
      expect(first.initialSpectrum).toEqual(second.initialSpectrum);
      expect(sha256(first.initialSpectrum)).toBe(golden.initialSpectrum);
      expect(sha256(first.waveData)).toBe(golden.waveData);
      expect(sha256(first.twiddle)).toBe(GOLDEN.twiddle);
    }
  });

  it("zeroes wave data outside the cutoff band and packs conjugate mirrors", () => {
    const size = SPECTRAL_RESOLUTION;
    const config = resolveCascadeConfig(1, options);
    const { initialSpectrum, waveData } = buildSpectralOceanData(size, config);
    const deltaK = Math.PI * 2 / config.lengthScale;
    let insideBand = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const k = Math.hypot((x - size / 2) * deltaK, (y - size / 2) * deltaK);
        const pixel = y * size + x;
        const wave = Array.from(waveData.subarray(pixel * 4, pixel * 4 + 4));
        if (k < config.cutoffLow || k > config.cutoffHigh) {
          expect(wave).toEqual([0, 1, 0, 0]);
          expect(initialSpectrum[pixel * 4]).toBe(0);
          expect(initialSpectrum[pixel * 4 + 1]).toBe(0);
        } else {
          insideBand += 1;
          expect(wave[1]).toBeCloseTo(1 / k, 5);
          expect(wave[3]).toBeGreaterThan(0);
        }
        const mirror = ((size - y) % size) * size + ((size - x) % size);
        expect(initialSpectrum[pixel * 4 + 2]).toBe(initialSpectrum[mirror * 4]);
        expect(initialSpectrum[pixel * 4 + 3]).toBe(-initialSpectrum[mirror * 4 + 1]);
      }
    }
    expect(insideBand).toBeGreaterThan(0);
    expect(insideBand).toBeLessThan(size * size);
  });

  it("does not mutate the cascade config", () => {
    const config = Object.freeze(resolveCascadeConfig(2, options));
    expect(() => buildSpectralOceanData(SPECTRAL_RESOLUTION, config)).not.toThrow();
    expect(config).toEqual({ ...SPECTRAL_CASCADES[2] });
  });
});
