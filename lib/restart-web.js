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

/**
 * 新进程的 stdout/stderr 必须落到文件，不能挂 pipe。
 *
 * 踩过的坑：原来用 stdio:["ignore","pipe","pipe"] 读 URL，helper 读完就 process.exit(0)，
 * 管道读端随之关闭；而 dsh web 会持续往 stdout 写日志，下一次写就是 EPIPE ——
 * 表现是「页面刚打开、过了几秒突然挂掉」，交接看起来完全成功，其实新进程随后就死了。
 *
 * 落文件之后：不依赖本进程存活，也顺带留下启动失败的原始报错。
 */
const WEB_OUT = path.join(path.dirname(LOG_PATH), "web-stdout.log");
try {
  // 长期运行会累积，启动前超限就清空。
  if (fs.existsSync(WEB_OUT) && fs.statSync(WEB_OUT).size > 5 * 1024 * 1024) {
    fs.writeFileSync(WEB_OUT, "");
  }
} catch { /* ignore */ }

let outFd = null;
try { outFd = fs.openSync(WEB_OUT, "a"); } catch { outFd = null; }
// 从当前文件末尾开始扫，避免读到上一次启动留下的 URL。
let scanPos = 0;
try { scanPos = fs.existsSync(WEB_OUT) ? fs.statSync(WEB_OUT).size : 0; } catch { scanPos = 0; }

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: ["ignore", outFd ?? "ignore", outFd ?? "ignore"],
  cwd: info.cwd || process.cwd(),
  env: envForDetachedSpawn(),
  windowsHide: true,
  shell: false,
});
// 子进程已持有自己的 fd 副本，父进程这份可以关掉。
if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
log(`spawn new: pid=${child.pid} (execPath=${info.execPath}) stdout -> ${outFd === null ? "ignore" : WEB_OUT}`);

child.on("error", (e) => {
  log(`spawn error: ${e && e.message}`);
  finish(1, "spawn failed");
});
child.on("exit", (code, sig) => {
  log(`new process exited early: code=${code} signal=${sig}`);
});
child.unref();

/** 增量读日志文件，找 dsh web 打印的带 token 地址。 */
function scanUrl() {
  try {
    if (!fs.existsSync(WEB_OUT)) return null;
    const size = fs.statSync(WEB_OUT).size;
    if (size <= scanPos) return null;
    const fd = fs.openSync(WEB_OUT, "r");
    const buf = Buffer.alloc(size - scanPos);
    try { fs.readSync(fd, buf, 0, buf.length, scanPos); } finally { fs.closeSync(fd); }
    scanPos = size;
    const match = String(buf).match(/dsh web:\s+(https?:\/\/\S+)/);
    return match ? match[1].replace(/[),.;]+$/, "") : null;
  } catch {
    return null;
  }
}

const wantBrowser = info.openBrowser !== false;
let opened = false;

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
    if (listening && !opened) {
      const url = scanUrl();
      if (url) {
        opened = true;
        log(`new process reported url: ${url}`);
        openBrowser(url);
      }
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
