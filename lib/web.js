import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

/**
 * 重启这件事**不再由插件代劳**。
 *
 * 历史：`scheduleRestart` 以前会 detached 拉起 `lib/restart-web.js`，由它杀掉旧 server、
 * 在同端口起新的。这条链在 Windows 上踩过的坑一个比一个难查：
 *
 *   - EPIPE：helper 挂 pipe 读 URL，读完退出，新进程下一次写 stdout 就崩；
 *   - 端口假空闲：`connect` 被 RST 时误判「端口空了」，新进程 EADDRINUSE 秒退；
 *   - 假成功：旧进程还占着端口 200ms，helper 看到「有人监听」就报交接完成，
 *     旧进程随后退出 —— 用户看到的是服务凭空消失，只能手动 `dsh web`；
 *   - helper 自己也可能死在半路，死在杀完旧进程之后，端口上什么都不剩。
 *
 * 结论（2026-11-03）：不再自动重启。补丁照样写进宿主，插件只负责把「现在必须重启」
 * 这件事说清楚（`restartNote()` + `command`），由用户自己关掉再执行 `dsh web`。
 * 这条路没有任何进程交接，也就不存在交接失败。
 */

/** 面向用户的重启说明。 */
export function restartNote() {
  return "补丁已写入宿主。请手动重启：关掉正在运行 dsh web 的窗口，重新执行 dsh web。";
}

/** 用户要在终端里敲的命令（带上当前端口，避免多实例时起错地方）。 */
export function manualRestartCommand(port) {
  const p = Number(port) || Number(process.env.PORT) || 3080;
  return `dsh web --port ${p}`;
}

/** 统一的重启答复：restarting 恒为 false —— 插件不会再自己重启。 */
export function manualRestartPlan(port) {
  const p = Number(port) || Number(process.env.PORT) || 3080;
  return {
    restarting: false,
    needsManualRestart: true,
    clean: true,
    command: manualRestartCommand(p),
    note: restartNote(),
  };
}

export function portFromRequest(request) {
  const host = String(request?.headers?.host || "");
  const m = host.match(/:(\d+)$/);
  if (m) return Number(m[1]);
  return Number(process.env.PORT) || 3080;
}

export function hostFromRequest(request) {
  const hostHeader = String(request?.headers?.host || "127.0.0.1");
  return hostHeader.replace(/:\d+$/, "") || "127.0.0.1";
}

export function restartArgv({
  argv = process.argv,
  findBinRoot = core.findDshBinRoot,
} = {}) {
  const root = findBinRoot();
  const binJs = root ? path.join(root, "lib", "bin.js") : null;
  if (binJs && fs.existsSync(binJs)) {
    const rest = argv.slice(2).filter((arg) => arg !== "--no-open");
    if (!rest.includes("web") && !rest.includes("desktop")) {
      const port = Number(process.env.PORT) || 3080;
      rest.unshift("web", "--port", String(port));
    }
    rest.push("--no-open");
    return [binJs, ...rest];
  }
  const next = argv.slice(1).filter((arg) => arg !== "--no-open");
  if (next[0] && /\.(cmd|bat)$/i.test(next[0])) {
    const dir = path.dirname(next[0]);
    const candidates = [
      path.resolve(dir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      path.resolve(dir, "..", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    ];
    const hit = candidates.find((p) => fs.existsSync(p));
    if (hit) next[0] = hit;
  }
  next.push("--no-open");
  return next;
}

/** 重启全过程留痕：helper 是 detached + stdio ignore 起的，它自己的输出在父进程这边看不到。 */
function restartLogPath() {
  try {
    const home = core.findDshHome();
    const dir = path.join(home, "dsh-purge");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "restart.log");
  } catch {
    return path.join(os.tmpdir(), "dsh-purge-restart.log");
  }
}

function appendRestartLog(tag, line) {
  try {
    const fp = restartLogPath();
    try {
      if (fs.statSync(fp).size > 64 * 1024) fs.writeFileSync(fp, "");
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(fp, `${new Date().toISOString()} [${tag}:${process.pid}] ${line}\n`);
  } catch { /* 日志写不进去也不能影响重启 */ }
}

function spawnRestartHelper(helper, payload, exitAfter = 250) {
  try {
    core.silenceCmdFlash();
  } catch {}
  appendRestartLog("host", `restart requested; helper=${helper} payload=${JSON.stringify(payload)}`);
  appendRestartLog("host", `cwd=${process.cwd()} execPath=${process.execPath}`);
  let child;
  try {
    child = spawn(process.execPath, [helper], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      env: {
        ...core.envForDetachedSpawn(),
        DSH_PURGE_RESTART: JSON.stringify(payload),
      },
    });
  } catch (e) {
    appendRestartLog("host", `spawn helper THREW: ${e && e.message} —— 不会重启`);
    throw e;
  }
  // spawn 失败不会抛异常，而是异步发 error 事件；pid 为空同样说明没起来。
  if (!child.pid) {
    appendRestartLog("host", "spawn helper returned no pid —— 不会重启");
  } else {
    appendRestartLog("host", `helper spawned pid=${child.pid}`);
  }
  child.on("error", (e) => {
    appendRestartLog("host", `helper spawn error: ${e && e.message}`);
  });
  child.on("exit", (code, sig) => {
    appendRestartLog("host", `helper exit code=${code} signal=${sig}`);
  });
  child.unref();
  appendRestartLog("host", `exiting self in ${exitAfter}ms`);
  setTimeout(() => process.exit(0), exitAfter);
}

/**
 * 重启申请：只登记 + 给用户一句明确的话，**不 spawn 任何进程**。
 *
 * 返回值里的 `needsManualRestart` / `command` 会一路透到接口与面板，
 * 前端据此弹「请手动重启」而不是等一个不会发生的重连。
 *
 * @param {object} [request]
 * @param {unknown} [_ctx]
 * @param {{ openBrowser?: boolean }} [_options] 保留签名，自动重启已不再使用。
 */
export function scheduleRestart(request, _ctx, _options = {}) {
  const port = portFromRequest(request);
  const plan = manualRestartPlan(port);
  try {
    appendRestartLog("host", `manual restart required; command=${plan.command}`);
  } catch { /* 日志失败不影响答复 */ }
  try {
    console.log(`[dsh-purge] ${plan.note}\n[dsh-purge] ${plan.command}`);
  } catch {
    /* ignore */
  }
  return plan;
}

export function scheduleCleanupRestart({ request, restartArgv: argv, cleanup = [] } = {}) {
  const src = fileURLToPath(new URL("./uninstall-restart.js", import.meta.url));
  const dest = path.join(os.tmpdir(), `dsh-purge-uninst-${process.pid}.mjs`);
  fs.copyFileSync(src, dest);
  spawnRestartHelper(dest, {
    kind: "web",
    execPath: process.execPath,
    argv: argv || restartArgv(),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port: portFromRequest(request),
    cleanup,
    helper: dest,
    openBrowser: request != null,
  }, 400);
}
