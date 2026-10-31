import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { envForDetachedSpawn, findDshHome } from "./core.js";
import {
  cmdlineOf,
  dshHomeDir,
  killPid,
  listenerPids,
  looksLikeDshWeb,
  writeRecord,
} from "./web-reclaim.js";

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

/**
 * 杀掉「发起重启的那个进程」；再按端口兜底一次，清掉旧版本留下、没有 pid 记录的孤儿
 * （#197：只按 info.pid 杀时，上一轮 detached 起来的 server 永远没人管）。
 */
function killOldServer() {
  const pid = Number(info.pid);
  log(`killOldServer: oldPid=${pid}`);
  if (pid && pid !== process.pid) killPid(pid);
  // 按端口兜底：清掉上一轮 detached 起来、没有 pid 记录的孤儿（#197）
  for (const other of listenerPids(port)) {
    if (other === process.pid || other === pid) continue;
    if (!looksLikeDshWeb(cmdlineOf(other))) continue;
    log(`killOldServer: reclaiming orphan pid=${other} on :${port}`);
    killPid(other);
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
 * 踩过的坑（EPIPE）：原来用 stdio:["ignore","pipe","pipe"] 只为读那行带 token 的 URL，
 * helper 读完就 process.exit(0)，管道读端随之关闭；而 dsh web 会持续往 stdout 写日志，
 * 下一次写就是 EPIPE —— 现象是「页面刚打开、几秒后突然挂掉」，交接看着完全成功。
 * 落文件之后不依赖本进程存活，也顺带留下启动报错。
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

let opened = false;
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
// #197：记下这个后台 server 的 pid。下次 `dsh web` 启动时，注入到宿主 bin.js 的
// preflight 会先把它收掉，不会再撞 EADDRINUSE。
child.on("spawn", () => {
  try {
    writeRecord(dshHomeDir(), port, child.pid, { host, url: "" });
  } catch {
    /* 记录失败不影响重启 */
  }
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
        // #197：把带 token 的地址记进回收记录，下次 `dsh web` 启动时可以直接提示。
        try { writeRecord(dshHomeDir(), port, child.pid, { host, url }); } catch { /* ignore */ }
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
