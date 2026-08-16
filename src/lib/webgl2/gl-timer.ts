// GPU elapsed-time measurement on top of EXT_disjoint_timer_query_webgl2.
// Stands in for the WebGPU timestamp queries behind `gpuSimulationMeanMs` /
// `gpuRenderMeanMs`. The extension is disabled by default in most browsers, so
// the timer must degrade to no-ops and `poll()` must return `null`.

import type { ExtDisjointTimerQueryWebgl2, GpuTimer } from "./types";

const NANOSECONDS_PER_MILLISECOND = 1e6;
const MAX_PENDING_QUERIES = 16;

/** Frozen no-op timer for contexts without the extension. */
function createNullTimer(label: string): GpuTimer {
  return Object.freeze({
    label,
    supported: false,
    begin: () => undefined,
    end: () => undefined,
    poll: () => null,
    pending: () => 0,
    dispose: () => undefined,
  });
}

/**
 * Creates a timer. Only one `TIME_ELAPSED_EXT` query may be open at a time
 * per context, so two timers (simulation, render) must not overlap their
 * begin/end ranges — the engine's passes are sequential, which satisfies this.
 * Results are polled at most one per call, oldest first; a GPU "disjoint"
 * event discards every pending sample (the values would be meaningless).
 */
export function createGpuTimer(gl: WebGL2RenderingContext, extension: ExtDisjointTimerQueryWebgl2 | null, label: string): GpuTimer {
  if (!extension) return createNullTimer(label);
  // Encapsulated mutable state: the open query and the FIFO of finished-but-unread queries.
  const pendingQueries: WebGLQuery[] = [];
  let openQuery: WebGLQuery | null = null;

  const discardAll = () => {
    pendingQueries.splice(0).forEach((query) => gl.deleteQuery(query));
  };

  const begin = () => {
    if (openQuery !== null || pendingQueries.length >= MAX_PENDING_QUERIES) return;
    const query = gl.createQuery();
    if (!query) return;
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    openQuery = query;
  };

  const end = () => {
    if (openQuery === null) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    pendingQueries.push(openQuery);
    openQuery = null;
  };

  const poll = (): number | null => {
    const oldest = pendingQueries[0];
    if (!oldest) return null;
    const disjoint: unknown = gl.getParameter(extension.GPU_DISJOINT_EXT);
    if (disjoint === true) {
      discardAll();
      return null;
    }
    const available: unknown = gl.getQueryParameter(oldest, gl.QUERY_RESULT_AVAILABLE);
    if (available !== true) return null;
    const nanoseconds: unknown = gl.getQueryParameter(oldest, gl.QUERY_RESULT);
    pendingQueries.shift();
    gl.deleteQuery(oldest);
    if (typeof nanoseconds !== "number" || !Number.isFinite(nanoseconds)) return null;
    return nanoseconds / NANOSECONDS_PER_MILLISECOND;
  };

  const dispose = () => {
    if (openQuery !== null) {
      gl.endQuery(extension.TIME_ELAPSED_EXT);
      gl.deleteQuery(openQuery);
      openQuery = null;
    }
    discardAll();
  };

  return Object.freeze({ label, supported: true, begin, end, poll, pending: () => pendingQueries.length, dispose });
}
