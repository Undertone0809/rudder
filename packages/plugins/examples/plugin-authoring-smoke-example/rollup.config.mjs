import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import { fileURLToPath } from "node:url";
import { createPluginBundlerPresets } from "../../sdk/dist/bundlers.js";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const localPackageAliases = new Map([
  ["@rudderhq/plugin-sdk", fileURLToPath(new URL("../../sdk/dist/index.js", import.meta.url))],
  ["@rudderhq/shared", fileURLToPath(new URL("../../../shared/dist/index.js", import.meta.url))],
]);

function localWorkspacePackageResolver() {
  return {
    name: "local-workspace-package-resolver",
    resolveId(source) {
      return localPackageAliases.get(source) ?? null;
    },
  };
}

function withPlugins(config) {
  if (!config) return null;
  return {
    ...config,
    plugins: [
      localWorkspacePackageResolver(),
      nodeResolve({
        extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      }),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
        outDir: config.output.dir,
      }),
    ],
  };
}

export default [
  withPlugins(presets.rollup.manifest),
  withPlugins(presets.rollup.worker),
  withPlugins(presets.rollup.ui),
].filter(Boolean);
