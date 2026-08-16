import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * `src/lib/webgl2/index.ts` is a barrel that re-exports the infrastructure layer
 * *and* the pass modules. A pass importing back through it makes the module
 * graph circular: loading the pass loads the barrel, which loads every other
 * pass before the constants they interpolate exist, and template literals read
 * `undefined` (TDZ). Pass modules must import the concrete sibling instead.
 */
const WEBGL2_BARREL_MESSAGE =
  "禁止在 src/lib/webgl2/ 内部从桶文件 './index' 导入：这会造成循环依赖，" +
  "pass 模块会在 GLSL 常量初始化之前被求值（TDZ），模板字面量读到 undefined。" +
  "请直接从具体模块导入，例如 './gl-program'、'./gl-texture'、'./gl-framebuffer'、" +
  "'./gl-geometry'、'./gl-state'、'./gl-uniform-buffer'、'./types'、'./shared-glsl'。";

export default tseslint.config(
  {
    ignores: ["dist/**", "dist-demo/**", "docs/screenshots/**", "tmp/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/lib/webgl2/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // Exact specifiers only. A bare "." or "./" here would be read as
              // a gitignore-style prefix and would ban every sibling import.
              group: ["./index", "./index.js", "./index.ts", "../webgl2/index"],
              message: WEBGL2_BARREL_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Node scripts that also embed browser-side callbacks (`page.evaluate`,
    // `addInitScript`). Both global sets are legitimately in scope here.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        window: "readonly",
      },
    },
  },
);
