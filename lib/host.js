import { adapterFor, detectSurface } from "./surface.js";
import * as desktop from "./desktop.js";
import * as web from "./web.js";

const ADAPTERS = {
  web,
  desktop,
};

export function currentSurface(input) {
  return detectSurface(input);
}

export function hostAdapter(kind = detectSurface()) {
  return ADAPTERS[adapterFor(kind)] || web;
}

export function scheduleRestart(request, ctx, options = {}) {
  return hostAdapter().scheduleRestart(request, ctx, options);
}

export function scheduleCleanupRestart(opts) {
  return hostAdapter().scheduleCleanupRestart(opts);
}

export function restartNote() {
  return hostAdapter().restartNote();
}

/**
 * 「请手动重启」的统一答复。web 适配器有完整实现（带端口命令）；
 * 桌面端不自动重启插件目录，沿用同一套文案即可。
 */
export function manualRestartPlan(port) {
  const adapter = hostAdapter();
  if (typeof adapter.manualRestartPlan === "function") return adapter.manualRestartPlan(port);
  return {
    restarting: false,
    needsManualRestart: true,
    clean: true,
    command: web.manualRestartCommand(port),
    note: adapter.restartNote(),
  };
}
