// CPU-side spectral ocean setup: cascade
// presets, the deterministic RNG, the JONSWAP/TMA initial spectrum, wave-vector
// table and Stockham twiddle table. The GPU consumes the returned Float32Arrays
// as-is (rgba32float textures), so nothing here may depend on a GPU API and the
// arithmetic order must never change -- the wave field is only reproducible
// while these stay bit-identical.

export const SPECTRAL_RESOLUTION = 128;
export const SPECTRAL_LOG_SIZE = 7;

// Runtime bounds for the two displacing cascades' tile sizes. The spectrum is
// regenerated on the CPU when either changes; shaders read the live values
// from atmosphere.zw, so no pipeline rebuild is involved.
export const LONG_SCALE_RANGE = [80, 480] as const;
export const MEDIUM_SCALE_RANGE = [24, 128] as const;

export const SPECTRAL_CASCADES = [
  { lengthScale: 240, cutoffLow: 0.024, cutoffHigh: 0.36, amplitudeScale: 0.45, choppiness: 1.18, secondaryScale: 0.22, seed: 0x51f15e },
  { lengthScale: 64, cutoffLow: 0.30, cutoffHigh: 1.42, amplitudeScale: 0.45, choppiness: 1.05, secondaryScale: 0.08, seed: 0x72a93b },
  // This cascade reaches decimetre-scale capillary-gravity waves. It shades
  // the interface only; carrying it into the mesh would alias and look ridged.
  { lengthScale: 12, cutoffLow: 1.22, cutoffHigh: 24.0, amplitudeScale: 0.82, choppiness: 0.40, secondaryScale: 0, seed: 0x19ce47 },
] as const;

/** One authored cascade preset, with literal (compile-time) field types. */
export type SpectralCascadePreset = (typeof SPECTRAL_CASCADES)[number];

/** A cascade preset whose tile size may have been overridden at runtime. */
export type SpectralCascadeConfig = Omit<SpectralCascadePreset, "lengthScale"> & { lengthScale: number };

/** The live tile sizes of the two runtime-adjustable cascades. */
export type CascadeScaleOptions = {
  readonly longCascadeScale: number;
  readonly mediumCascadeScale: number;
};

export type SpectralOceanData = {
  /** size*size RGBA: (h0(k).re, h0(k).im, h0(-k)*.re, h0(-k)*.im). */
  readonly initialSpectrum: Float32Array<ArrayBuffer>;
  /** size*size RGBA: (kx, 1/|k|, kz, omega); (0, 1, 0, 0) outside the cutoffs. */
  readonly waveData: Float32Array<ArrayBuffer>;
  /** SPECTRAL_LOG_SIZE*size RGBA: (cos, sin, firstIndex, secondIndex). */
  readonly twiddle: Float32Array<ArrayBuffer>;
};

/**
 * Tile size in metres of one cascade: cascades 0 and 1 follow the live
 * options, cascade 2 (and anything beyond) keeps its authored preset.
 */
export function resolveCascadeScale(index: number, options: CascadeScaleOptions): number {
  if (index === 0) return options.longCascadeScale;
  if (index === 1) return options.mediumCascadeScale;
  return SPECTRAL_CASCADES[index].lengthScale;
}

/** The authored preset for `index` with its tile size resolved from `options`. */
export function resolveCascadeConfig(index: number, options: CascadeScaleOptions): SpectralCascadeConfig {
  return { ...SPECTRAL_CASCADES[index], lengthScale: resolveCascadeScale(index, options) };
}

/** PCG-style 32-bit hash generator; the sequence must stay bit-identical. */
export function deterministicRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapAngle(value: number) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export function spectrumNormalisationFactor(spread: number) {
  const s2 = spread * spread;
  const s3 = s2 * spread;
  const s4 = s3 * spread;
  return spread < 5
    ? -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * spread + 0.163
    : -4.8e-8 * s4 + 1.07e-5 * s3 - 9.53e-4 * s2 + 5.9e-2 * spread + 0.393;
}

/**
 * Stockham autosort twiddle table: `logSize` rows of `size` RGBA texels holding
 * (cos, sin, firstIndex, secondIndex) for the forward half and the negated
 * pair for the mirrored half.
 */
export function buildSpectralTwiddleTable(size: number, logSize: number): Float32Array<ArrayBuffer> {
  const twiddle = new Float32Array(logSize * size * 4);
  for (let stage = 0; stage < logSize; stage += 1) {
    const block = size >> (stage + 1);
    for (let output = 0; output < size / 2; output += 1) {
      const first = (2 * block * Math.floor(output / block) + output % block) % size;
      const angle = -2 * Math.PI / size * Math.floor(output / block) * block;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const base = (stage * size + output) * 4;
      const opposite = (stage * size + output + size / 2) * 4;
      twiddle.set([cosine, sine, first, first + block], base);
      twiddle.set([-cosine, -sine, first, first + block], opposite);
    }
  }
  return twiddle;
}

export function buildSpectralOceanData(size: number, config: SpectralCascadeConfig): SpectralOceanData {
  const { lengthScale, cutoffLow, cutoffHigh, amplitudeScale, secondaryScale, seed } = config;
  const gravity = 9.81;
  const depth = 54;
  const windSpeed = 11.5;
  const fetch = 120_000;
  const windAngle = -0.48;
  const peakEnhancement = 3.3;
  const swell = 0.38;
  const deltaK = Math.PI * 2 / lengthScale;
  const alpha = 0.076 * Math.pow(gravity * fetch / (windSpeed * windSpeed), -0.22);
  const peakOmega = 22 * Math.pow(windSpeed * fetch / (gravity * gravity), -0.33);
  const initialK = new Float32Array(size * size * 2);
  const waveData = new Float32Array(size * size * 4);
  const random = deterministicRandom(seed);
  const gaussian = () => {
    const u = Math.max(random(), 1e-7);
    const v = random();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = Math.PI * 2 * v;
    return [radius * Math.cos(angle), radius * Math.sin(angle)] as const;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x - size / 2;
      const nz = y - size / 2;
      const kx = nx * deltaK;
      const kz = nz * deltaK;
      const kLength = Math.hypot(kx, kz);
      const pixel = y * size + x;
      const waveOffset = pixel * 4;
      if (kLength < cutoffLow || kLength > cutoffHigh) {
        waveData.set([0, 1, 0, 0], waveOffset);
        continue;
      }
      const kh = Math.min(kLength * depth, 20);
      const tanhKh = Math.tanh(kh);
      const omega = Math.sqrt(gravity * kLength * tanhKh);
      const sechSquared = 1 - tanhKh * tanhKh;
      const frequencyDerivative = gravity * (depth * kLength * sechSquared + tanhKh) / Math.max(omega * 2, 1e-5);
      const omegaH = omega * Math.sqrt(depth / gravity);
      const tma = omegaH <= 1 ? 0.5 * omegaH * omegaH : omegaH < 2 ? 1 - 0.5 * (2 - omegaH) * (2 - omegaH) : 1;
      const sigma = omega <= peakOmega ? 0.07 : 0.09;
      const peakDistance = (omega - peakOmega) / Math.max(sigma * peakOmega, 1e-5);
      const peakShape = Math.exp(-0.5 * peakDistance * peakDistance);
      const peakRatio = peakOmega / omega;
      const jonswap = tma * alpha * gravity * gravity / Math.pow(omega, 5)
        * Math.exp(-1.25 * Math.pow(peakRatio, 4)) * Math.pow(peakEnhancement, peakShape);
      const theta = wrapAngle(Math.atan2(kz, kx) - windAngle);
      const omegaRatio = omega / peakOmega;
      const spreadPower = ((omega > peakOmega ? 9.77 * Math.pow(omegaRatio, -2.5) : 6.97 * Math.pow(omegaRatio, 5))
        + 16 * Math.tanh(Math.min(omegaRatio, 20)) * swell * swell) * 0.58;
      const focusedDirection = spectrumNormalisationFactor(spreadPower) * Math.pow(Math.abs(Math.cos(theta * 0.5)), 2 * spreadPower);
      const broadDirection = 2 / Math.PI * Math.pow(Math.max(Math.cos(theta), 0), 2);
      const direction = focusedDirection * 0.68 + broadDirection * 0.32;
      const shortWaveFade = Math.exp(-0.00016 * kLength * kLength);
      let spectralDensity = jonswap * direction * shortWaveFade;
      if (secondaryScale > 0) {
        const swellWindSpeed = 8.4;
        const swellFetch = 310_000;
        const swellPeakOmega = 22 * Math.pow(swellWindSpeed * swellFetch / (gravity * gravity), -0.33);
        const swellAlpha = 0.076 * Math.pow(gravity * swellFetch / (swellWindSpeed * swellWindSpeed), -0.22);
        const swellSigma = omega <= swellPeakOmega ? 0.07 : 0.09;
        const swellPeakDistance = (omega - swellPeakOmega) / Math.max(swellSigma * swellPeakOmega, 1e-5);
        const swellPeakShape = Math.exp(-0.5 * swellPeakDistance * swellPeakDistance);
        const swellPeakRatio = swellPeakOmega / omega;
        const swellSpectrum = tma * swellAlpha * gravity * gravity / Math.pow(omega, 5)
          * Math.exp(-1.25 * Math.pow(swellPeakRatio, 4)) * Math.pow(2.6, swellPeakShape);
        const swellTheta = wrapAngle(Math.atan2(kz, kx) - (windAngle + 0.82));
        const swellRatio = omega / swellPeakOmega;
        const swellSpread = ((omega > swellPeakOmega ? 9.77 * Math.pow(swellRatio, -2.5) : 6.97 * Math.pow(swellRatio, 5)) + 9.0) * 0.72;
        const swellDirection = spectrumNormalisationFactor(swellSpread) * Math.pow(Math.abs(Math.cos(swellTheta * 0.5)), 2 * swellSpread);
        spectralDensity += swellSpectrum * swellDirection * shortWaveFade * secondaryScale;
      }
      const amplitude = Math.sqrt(Math.max(0, 2 * spectralDensity * Math.abs(frequencyDerivative) / kLength * deltaK * deltaK)) * amplitudeScale;
      const noise = gaussian();
      initialK[pixel * 2] = noise[0] * amplitude;
      initialK[pixel * 2 + 1] = noise[1] * amplitude;
      waveData.set([kx, 1 / kLength, kz, omega], waveOffset);
    }
  }
  const initialSpectrum = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixel = y * size + x;
      const mirror = ((size - y) % size) * size + ((size - x) % size);
      initialSpectrum.set([
        initialK[pixel * 2], initialK[pixel * 2 + 1],
        initialK[mirror * 2], -initialK[mirror * 2 + 1],
      ], pixel * 4);
    }
  }
  const twiddle = buildSpectralTwiddleTable(size, SPECTRAL_LOG_SIZE);
  return { initialSpectrum, waveData, twiddle };
}
