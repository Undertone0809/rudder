import fs from "node:fs/promises";
import Module from "node:module";
import path from "node:path";

const enabled = process.env.RUDDER_APP_BUILDER_NEXT_COMPAT === "1";
const configModuleSuffix = "/next/dist/server/config.js";
const declarationsModuleSuffix = "/next/dist/lib/typescript/writeAppTypeDeclarations.js";
const wrappedConfigModules = new WeakMap();
const wrappedDeclarationModules = new WeakMap();

function normalizedModulePath(modulePath) {
  return String(modulePath).replaceAll("\\", "/");
}

function addNodeSchemeExternal(webpackConfig, context) {
  if (!context?.isServer || !webpackConfig) return webpackConfig;
  const external = ({ request }, callback) => {
    if (request?.startsWith("node:")) {
      callback(null, `commonjs ${request}`);
      return;
    }
    callback();
  };
  if (Array.isArray(webpackConfig.externals)) {
    webpackConfig.externals.push(external);
  } else if (webpackConfig.externals) {
    webpackConfig.externals = [webpackConfig.externals, external];
  } else {
    webpackConfig.externals = [external];
  }
  return webpackConfig;
}

function wrapWebpackConfig(config) {
  if (!config || typeof config !== "object") return config;
  const userWebpack = config.webpack;
  config.webpack = (webpackConfig, context) => {
    const configured = typeof userWebpack === "function"
      ? userWebpack(webpackConfig, context)
      : webpackConfig;
    if (configured && typeof configured.then === "function") {
      return configured.then((result) => addNodeSchemeExternal(result ?? webpackConfig, context));
    }
    return addNodeSchemeExternal(configured ?? webpackConfig, context);
  };
  return config;
}

function wrapConfigModule(moduleExports) {
  if (!moduleExports || (typeof moduleExports !== "object" && typeof moduleExports !== "function")) {
    return moduleExports;
  }
  const cached = wrappedConfigModules.get(moduleExports);
  if (cached) return cached;
  const loaders = new Map();
  const wrapped = new Proxy(moduleExports, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property !== "default" && property !== "loadConfig") || typeof value !== "function") {
        return value;
      }
      if (!loaders.has(value)) {
        loaders.set(value, async (...args) => wrapWebpackConfig(await value(...args)));
      }
      return loaders.get(value);
    },
  });
  wrappedConfigModules.set(moduleExports, wrapped);
  return wrapped;
}

function wrapDeclarationModule(moduleExports) {
  if (!moduleExports || typeof moduleExports !== "object") return moduleExports;
  const cached = wrappedDeclarationModules.get(moduleExports);
  if (cached) return cached;
  const original = moduleExports.writeAppTypeDeclarations;
  if (typeof original !== "function") return moduleExports;
  const wrapped = new Proxy(moduleExports, {
    get(target, property, receiver) {
      if (property !== "writeAppTypeDeclarations") {
        return Reflect.get(target, property, receiver);
      }
      return async (options) => {
        try {
          await fs.access(path.join(options.baseDir, "next-env.d.ts"));
          return;
        } catch {
          return original(options);
        }
      };
    },
  });
  wrappedDeclarationModules.set(moduleExports, wrapped);
  return wrapped;
}

if (enabled) {
  const originalLoad = Module._load;
  Module._load = function rudderAppBuilderLoad(request, parent, isMain) {
    const loaded = originalLoad.call(this, request, parent, isMain);
    let resolved;
    try {
      resolved = normalizedModulePath(Module._resolveFilename(request, parent, isMain));
    } catch {
      return loaded;
    }
    if (resolved.endsWith(configModuleSuffix)) return wrapConfigModule(loaded);
    if (resolved.endsWith(declarationsModuleSuffix)) return wrapDeclarationModule(loaded);
    return loaded;
  };
}
