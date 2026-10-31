import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as core from "./core.js";

export function restartNote() {
  return "Restarting dsh web…";
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
 * @param {object} [request]
 * @param {unknown} [_ctx]
 * @param {{ openBrowser?: boolean }} [options]
 * settle / 自愈重启传 request=null → 默认不弹浏览器，避免关窗后仍被反复拉起新窗口（#59/#61）。
 */
export function scheduleRestart(request, _ctx, options = {}) {
  const openBrowser = options.openBrowser ?? (request != null);
  const helper = fileURLToPath(new URL("./restart-web.js", import.meta.url));
  // #197：前台进程 250ms 后就会退出，终端回到提示符，但 server 在后台跑。
  // 不把这句话打出来，用户会以为程序已经关掉，然后立刻再开一个 → EADDRINUSE。
  try {
    console.log(
      "[dsh-purge] restarting dsh web in the background; closing this window will NOT stop it. " +
        "The next `dsh web` reclaims it automatically.",
    );
  } catch {
    /* ignore */
  }
  spawnRestartHelper(helper, {
    kind: "web",
    execPath: process.execPath,
    argv: restartArgv(),
    cwd: process.cwd(),
    host: hostFromRequest(request),
    port: portFromRequest(request),
    pid: process.pid,
    openBrowser: openBrowser !== false,
  });
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
