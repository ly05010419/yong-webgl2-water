# Third-party notices

This project is a WebGL2-only extraction of the Tethys water renderer from
[`inkwell-webgpu-water`](https://github.com/ly05010419/inkwell-webgpu-water)
(MIT, © James Addison, modifications © Yong Li). The engine's mathematics,
GLSL and per-frame ordering are carried over unchanged.

## Removed assets

The source project's demo also rendered a **Dutch Ship Medium** hull from
[Poly Haven](https://polyhaven.com/a/dutch_ship_medium) (CC0 1.0). This project
contains no hull rendering and ships no model, texture or glTF loader, so that
notice no longer applies here — it is recorded only so the provenance of the
removal is traceable.

## Design and implementation references

The renderer's clean-room design references and the upstream licenses of any
incorporated code are recorded in the source project's
[implementation source ledger](https://github.com/ly05010419/inkwell-webgpu-water/blob/main/docs/research-sources.md).

## Runtime dependencies

None. The published package has no dependencies; `vite`, `typescript`,
`vitest`, `eslint`, `tsup`, `@playwright/test`, `pixelmatch` and `pngjs` are
development-only.
