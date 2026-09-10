/* Bundle src/worker.js for Workers. Rapier's wasm-bindgen glue does `import * as wasm from "./x.wasm"` (ESM wasm
   integration), which workerd does not support; Workers want the .wasm imported as a WebAssembly.Module and
   instantiated synchronously. This plugin swaps that one glue file, and leaves the .wasm import for wrangler. */
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';

const rapierGlue = {
  name: 'rapier-wasm-glue',
  setup(b) {
    b.onLoad({ filter: /rapier_wasm3d\.js$/ }, () => ({
      contents: `
        import wasmModule from "./rapier_wasm3d_bg.wasm";
        import * as bg from "./rapier_wasm3d_bg.js";
        export * from "./rapier_wasm3d_bg.js";
        const instance = new WebAssembly.Instance(wasmModule, { "./rapier_wasm3d_bg.js": bg });
        bg.__wbg_set_wasm(instance.exports);
      `,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: ['src/worker.js'],
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  outfile: 'dist/worker.js',
  external: ['*.wasm'],
  plugins: [rapierGlue],
  logLevel: 'info',
});
copyFileSync('node_modules/@dimforge/rapier3d/rapier_wasm3d_bg.wasm', 'dist/rapier_wasm3d_bg.wasm');
