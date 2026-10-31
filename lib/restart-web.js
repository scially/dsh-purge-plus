import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { envForDetachedSpawn, findDshHome } from "./core.js";

/**
 * 重启交接器。
 *
 * 历史教训：这个 helper 以前是全静默的（stdio: "ignore"、没有任何落盘），
 * 一旦交接失败，用户只看到 dsh web 退出、再也不回来，日志里一个字都没有。
 * 现在全程写一份 restart.log，出问题能直接看到卡在哪一步。
 */

const LOG_MAX = 64 * 1024;

function logFile() {
  try {
    const home = findDshHome();
    const dir = path.join(home, "dsh-purge");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "restart.log");
  } catch {
    return path.join(os.tmpdir(), "dsh-purge-restart.log");
  }
}

const LOG_PATH = logFile();

function log(line) {
  const text = `${new Date().toISOString()} [helper:${process.pid}] ${line}\n`;
  try {
    // 超限就丢弃旧日志，别让它无限长。
    try {
      const st = fs.statSync(LOG_PATH);
      if (st.size > LOG_MAX) fs.writeFileSync(LOG_PATH, "");
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(LOG_PATH, text);
  } catch { /* 日志写不进去也不能影响重启 */ }
  try { process.stderr.write(text); } catch { /* ignore */ }
}

function finish(code, reason) {
  log(`exit(${code}) ${reason}`);
  process.exit(code);
}

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) finish(1, "no DSH_PURGE_RESTART payload");
log(`start; log=${LOG_PATH}`);

let info;
try {
  info = JSON.parse(encoded);
} catch (e) {
  finish(1, `payload not JSON: ${e && e.message}`);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";
log(`payload port=${port} host=${host} oldPid=${info.pid} openBrowser=${info.openBrowser} execPath=${info.execPath}`);
log(`argv=${JSON.stringify(info.argv)} cwd=${info.cwd}`);

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

function killOldServer() {
  const pid = Number(info.pid);
  if (!pid || pid === process.pid) {
    log(`killOldServer: skip (pid=${pid})`);
    return;
  }
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/F", "/T"], { windowsHide: true, stdio: "ignore" });
    log(`killOldServer: taskkill ${pid} status=${r.status} error=${r.error ? r.error.message : "-"}`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    log(`killOldServer: SIGTERM ${pid} ok`);
  } catch (e) {
    log(`killOldServer: SIGTERM ${pid} failed: ${e && e.message}`);
  }
}

function openBrowser(url) {
  if (!url) return;
  log(`openBrowser: ${url}`);
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    return;
  }
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
}

async function waitFree() {
  for (let i = 0; i < 40; i++) {
    if (await portFree()) {
      log(`waitFree: free after ${i} polls`);
      return true;
    }
    if (i === 8) killOldServer();
    await new Promise((r) => setTimeout(r, 120));
  }
  killOldServer();
  for (let i = 0; i < 40; i++) {
    if (await portFree()) {
      log(`waitFree: free after force-kill, ${i} polls`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

const ok = await waitFree();
if (!ok) finish(1, `port ${port} never freed`);

// 接着 stdout 里的新地址打开浏览器。旧页面的 token 在新进程里无效，只刷新会打不开。
let opened = false;
const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
log(`spawn new: pid=${child.pid} (execPath=${info.execPath})`);

child.on("error", (e) => {
  log(`spawn error: ${e && e.message}`);
  finish(1, "spawn failed");
});
child.on("exit", (code, sig) => {
  log(`new process exited early: code=${code} signal=${sig}`);
});

const wantBrowser = info.openBrowser !== false;
const takeUrl = (chunk) => {
  const text = String(chunk || "");
  if (opened) return;
  const match = text.match(/dsh web:\s+(https?:\/\/\S+)/);
  if (match) {
    opened = true;
    log(`new process reported url: ${match[1]}`);
    if (!wantBrowser) return;
    const url = match[1].replace(/[),.;]+$/, "");
    openBrowser(url);
    return;
  }
  // 没有 URL 也把新进程的头几行记下来，便于判断它是不是报错了
  const head = text.trim();
  if (head) log(`new stdout: ${head.slice(0, 400)}`);
};
child.stdout?.on("data", takeUrl);
child.stderr?.on("data", takeUrl);
child.unref();

if (wantBrowser) {
  const started = Date.now();
  let listening = false;
  while (!opened && Date.now() - started < 20000) {
    await new Promise((r) => setTimeout(r, 200));
    // 端口被占用 = 有进程在监听。这是判断"新进程到底起没起来"的唯一硬证据。
    if (!listening && !(await portFree())) {
      listening = true;
      log(`new process listening on ${port} at ${Date.now() - started}ms`);
    }
  }
  if (!listening && !(await portFree())) {
    listening = true;
    log(`new process listening on ${port}`);
  }
  if (!opened) log("no url line within 20s (new process may still be booting)");
  if (!listening) log(`CRITICAL: nothing listening on ${port} after 20s —— 新进程没起来或起在别的端口`);
} else {
  // 自愈 / settle 重启不弹浏览器，但同样要确认新进程真的接管了端口。
  // 以前这里只等 1.5s 就退，而 dsh web 实测要 7-8 秒才监听 —— helper 早退之后
  // 新进程起不来就彻底没人知道了。
  const started = Date.now();
  let listening = false;
  while (Date.now() - started < 15000) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await portFree())) {
      listening = true;
      break;
    }
  }
  log(listening
    ? `new process listening on ${port} at ${Date.now() - started}ms`
    : `CRITICAL: nothing listening on ${port} after 15s —— 新进程没起来，或起在了别的端口`);
}
finish(0, "handoff done");
