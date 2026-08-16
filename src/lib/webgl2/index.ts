// Barrel over the whole WebGL2 layer of the Tethys water engine — the
// infrastructure helpers *and* the pass modules built on them.
//
// It exists for the tests and for external consumers who want one import path.
// It is NOT the internal import route: a pass module must import its concrete
// siblings ("./gl-program", "./shared-glsl", …), never "./index", because a
// pass reaching back through the barrel makes the module graph circular and
// evaluates the GLSL constants it interpolates before they are initialised.
// `eslint.config.mjs` turns that rule into a `no-restricted-imports` error for
// everything under `src/lib/webgl2/`. See docs/webgl2-port/contract.md.

export type {
  ExtDisjointTimerQueryWebgl2,
  GlFilter,
  GlFramebuffer,
  GlLimits,
  GlPass,
  GlProgram,
  GlSampler,
  GlShaderStage,
  GlTexture,
  GlTextureFormat,
  GlUniformBuffer,
  GlWrap,
  GpuTimer,
  PingPongTargets,
  WaterGlContext,
} from "./types";

export {
  GL_DEBUG_CHECKS_ENABLED,
  GL_FLOAT_TARGET_MESSAGE,
  GL_UNSUPPORTED_MESSAGE,
  WATER_GL_CONTEXT_ATTRIBUTES,
  checkGlError,
  createWaterGlContext,
  onContextLost,
  type ContextLostOptions,
} from "./gl-context";

export {
  GLSL_PRECISION_PREAMBLE,
  GLSL_VERSION_LINE,
  assignSamplerUnits,
  bindGlProgram,
  bindUniformBlock,
  composeShaderSource,
  createGlProgram,
  deleteGlProgram,
  preambleLineCount,
  uniformLocations,
  type GlProgramSource,
  type ShaderDefines,
} from "./gl-program";

export {
  bindTextureUnit,
  createGlSampler,
  createTexture2D,
  disposeSampler,
  disposeTexture,
  textureFormatInfo,
  unbindTextureUnit,
  unbindTextureUnits,
  uploadTexture2D,
  type CreateSamplerOptions,
  type CreateTexture2DOptions,
  type TextureFormatInfo,
  type UploadRegion,
} from "./gl-texture";

export {
  bindFramebufferForDraw,
  blitFramebuffer,
  clearFramebufferToZero,
  createGlFramebuffer,
  createPingPongTargets,
  deleteFramebufferHandle,
  disposeFramebuffer,
  unbindFramebuffer,
  type BlitMask,
  type BlitOptions,
  type CreateFramebufferOptions,
  type PingPongOptions,
} from "./gl-framebuffer";

export {
  FULLSCREEN_TRIANGLE_VERTEX_COUNT,
  FULLSCREEN_TRIANGLE_VERTEX_GLSL,
  bindVao,
  createEmptyVao,
  disposeVao,
  drawFullscreenTriangle,
  drawProcedural,
} from "./gl-geometry";

export {
  WORLD_UNIFORMS_BINDING,
  WORLD_UNIFORM_BYTES,
  bindUniformBufferBase,
  createUniformBuffer,
  disposeUniformBuffer,
  updateUniformBuffer,
} from "./gl-uniform-buffer";

export { createGpuTimer } from "./gl-timer";

export { createGlUnwindStack, type GlUnwindStack } from "./gl-unwind";

export {
  COMPUTE_STATE,
  OPAQUE_STATE,
  SKY_STATE,
  WATER_STATE,
  applyRenderState,
  type BlendPreset,
  type DepthCompare,
  type RenderStatePreset,
} from "./gl-state";

export {
  bindCachedDrawFramebuffer,
  bindCachedFramebuffer,
  bindCachedFramebufferForDraw,
  bindCachedReadFramebuffer,
  bindCachedProgram,
  bindCachedTextureUnit,
  forgetGlFramebuffer,
  forgetGlProgram,
  forgetGlSampler,
  forgetGlTexture,
  invalidateGlStateCache,
  invalidateRenderStateCache,
  isRenderStateCurrent,
  noteActiveUnitTextureBinding,
  noteRenderState,
  peekGlStateCache,
  takeGlStateCacheVerificationRequest,
  type AppliedRenderState,
  type GlStateCacheEntry,
} from "./gl-state-cache";

export {
  verifyFrameBoundary,
  verifyGlStateCache,
  verifyGlStateCacheAfterInvalidation,
} from "./gl-state-cache-verify";

export {
  AERIAL_GLSL,
  COLOR_GLSL,
  SKY_GLSL,
  TERRAIN_HEIGHT_GLSL,
  WORLD_SHADING_GLSL,
  WORLD_UNIFORMS_GLSL,
  WORLD_UNIFORM_FIELDS,
} from "./shared-glsl";

// Engine-assembly layer. With the barrel out of the internal import graph the
// order of these statements no longer affects evaluation: every pass module
// imports its dependencies directly, so ES module resolution already evaluates
// `shared-glsl` (and the rest) before whichever pass interpolates it. The
// grouping below is for readers — infrastructure first, then the passes.
export {
  TERRAIN_FIELD_TEXTURE_SIZE,
  createTerrainFieldPass,
  type TerrainFieldPass,
} from "./terrain-field-pass";

export {
  createSpectralCascadeSet,
  type SpectralCascadeSet,
  type SpectralCascadeSetOptions,
  type SpectralLayout,
} from "./spectral-cascades";

export {
  SIMULATION_PARAMS_BINDING,
  createWaterSimulationPass,
  createWaterSimulationProgram,
  type WaterSimulationPass,
  type WaterSimulationProgram,
  type WaterSimulationStepInput,
} from "./water-simulation-pass";

export { createBreakerEventPass, type BreakerEventPass, type BreakerEventStepInput } from "./breaker-event-pass";

export { createSkyPass, type SkyPass } from "./sky-pass";

export { createTerrainPass, terrainVertexCount, type TerrainDrawInput, type TerrainPass } from "./terrain-pass";

export {
  BREAKER_PATCH_VERTEX_COUNT,
  WATER_CLIPMAP_VERTEX_COUNT,
  createWaterPass,
  type WaterPass,
  type WaterPassDrawInput,
} from "./water-pass";

export {
  SCENE_CLEAR_COLOR,
  SCENE_CLEAR_DEPTH,
  createFrameTargets,
  type FrameTargets,
} from "./frame-targets";

export { createWaterGlResources, type WaterGlResources } from "./engine-resources";

export {
  cascadeFields,
  renderComposite,
  runComputePasses,
  type CascadeFields,
  type FramePassInput,
} from "./engine-frame";

// `buildWaterLabMetrics` lives in `src/lib/water-metrics.ts`: it is backend
// agnostic and both engines call it, so it is not re-exported from here.
