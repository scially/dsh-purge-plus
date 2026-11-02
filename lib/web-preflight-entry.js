// [dsh-purge] web preflight — 由 lib/bin-preflight.js 复制到宿主 lib 并 import 到 bin.js 顶部。
//
// 目的：dsh-purge 的「应用 → 自动重启」用 detached 子进程接管 server，父进程随即退出，
// 关窗/关终端都杀不到那个子进程；下一次 `dsh web` 会在 webserver 插件绑端口时撞
// EADDRINUSE，而 0.2.x 把 required 插件激活失败当 fatal，宿主直接起不来（issue #197）。
//
// 这里在 Cordis 激活之前做一次回收：先查 $DSH_HOME/dsh-purge/web-server-<port>.json，
// 记录失效时再按端口兜底；只杀命令行命中 `@deepseek-ai/dsh/lib/bin.js … web` 的进程。
// 只处理 `dsh web`，其它子命令零开销。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DSH_BIN = /@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js/;
const WEB_ARG = /(^|[\s"'])web([\s"']|$)/;

function run(file, args) {
  try {
    const r = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    return r && r.status === 0 ? String(r.stdout || "") : "";
  } catch {
    return "";
  }
}

function cmdlineOf(pid) {
  if (process.platform === "win32") {
    return run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
    ]).trim();
  }
  return run("ps", ["-p", String(pid), "-o", "command="]).trim();
}

function isDshWeb(cmd) {
  return DSH_BIN.test(cmd) && WEB_ARG.test(cmd);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid) {
  if (!pid || pid === process.pid) return false;
  if (process.platform === "win32") {
    const r = spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
    return !r.error && r.status === 0;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function listeningPids(port) {
  if (process.platform === "win32") {
    const out = run("netstat", ["-ano"]);
    const pids = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[2]) === port) pids.push(Number(m[3]));
    }
    return [...new Set(pids)];
  }
  const out = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const viaLsof = [...new Set(out.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (viaLsof.length > 0) return viaLsof;
  /* 只有 ss 没有 lsof 的精简镜像：以前直接返回空，回收逻辑静默失效。 */
  const pids = [];
  for (const line of run("ss", ["-ltnp"]).split(/\r?\n/)) {
    if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
  }
  return [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * 这次调用到底会不会真的绑定端口、起一个 web server？
 * 以前只看 argv 里有没有 "web"，于是 `dsh plugin --profile web add …`（装插件）、
 * `dsh web --dump-config`（导配置）、`dsh web --help` 都会先把正在跑的 3080 杀掉：
 * 「装完插件/看一眼配置，页面就挂了」的根源就在这里。只有真要起服务才回收。
 */
const DUMP_FLAGS = ["--dump-config", "--dump-default-config", "--dump-config-schema"];

function profileArg(argv) {
  const i = argv.indexOf("--profile");
  if (i > -1) return String(argv[i + 1] || "");
  const eq = argv.find((a) => a.startsWith("--profile="));
  return eq ? eq.slice("--profile=".length) : "";
}

export function willServeWeb(argv) {
  if (argv.some((a) => DUMP_FLAGS.includes(String(a).split("=")[0]))) return false;
  if (argv.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) return false;
  const positional = argv.filter((a) => !String(a).startsWith("-"));
  /* 子命令优先：`dsh web …` 起 web 服务，`dsh rescue …` 重建后同样起一个（默认也绑 3080），
     两者都该先回收旧实例；`tui` / `headless` / `desktop` 不占 web 端口。 */
  if (positional[0] === "web" || positional[0] === "rescue") return true;
  /* 没有子命令时 `dsh --profile web` 等价于 `dsh web`；`dsh plugin --profile web add`
     的第一个位置参数是 plugin，会在上面被排除，不会误杀。 */
  if (positional.length === 0) {
    const profile = profileArg(argv);
    return profile === "web" || profile === "rescue";
  }
  return false;
}

function main() {
  const argv = process.argv.slice(2);
  if (process.env.DSH_PURGE_NO_RECLAIM === "1") return;
  if (!willServeWeb(argv)) return;
  const i = process.argv.indexOf("--port");
  /* 两种写法都要认：`--port 4000` 与 `--port=4000`。只认前者时回收逻辑跑在 3080 上，
     真正占着的端口没人管，EADDRINUSE 照旧。 */
  const eq = process.argv.find((a) => /^--port=/.test(a));
  const raw = i > -1 ? process.argv[i + 1] : (eq ? eq.slice("--port=".length) : process.env.PORT);
  const port = Number(raw) || 3080;
  const home = String(process.env.DSH_HOME || "").trim() || path.join(os.homedir(), ".dsh");
  const record = path.join(home, "dsh-purge", `web-server-${port}.json`);

  try {
    let killed = 0;
    const killedPids = [];
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(record, "utf8"));
    } catch {
      rec = null;
    }
    const listeners = listeningPids(port);
    const recPid = Number(rec && rec.pid) || 0;
    let recStillAlive = false;
    if (recPid && alive(recPid)) {
      const cmd = cmdlineOf(recPid);
      // 命令行拿不到时，必须证明这个 pid 仍占着端口才杀：记录可能早于进程退出，
      // pid 被系统复用后盲目 taskkill 会杀掉无关进程。
      const ownsPort = listeners.includes(recPid);
      if (isDshWeb(cmd) || (!cmd && ownsPort)) {
        if (kill(recPid)) {
          killed += 1;
          killedPids.push(recPid);
        }
      }
      recStillAlive = alive(recPid);
    }
    // 杀不掉就留着记录，下一次启动再试；只有确认进程已经不在才清记录。
    if (rec && !recStillAlive) {
      try {
        fs.unlinkSync(record);
      } catch {
        /* ignore */
      }
    }

    /* 记录杀了也要按端口扫一遍：同端口可能还挂着别的孤儿（记录只记得最后一个）。 */
    for (const pid of listeners) {
      if (pid === process.pid || killedPids.includes(pid)) continue;
      if (!isDshWeb(cmdlineOf(pid))) continue;
      if (kill(pid)) {
        killed += 1;
        killedPids.push(pid);
      }
    }

    // taskkill 返回不代表端口已经释放。等被杀进程真正退出再让 Cordis 绑端口，
    // 否则还是会撞 EADDRINUSE。
    waitGone(killedPids);

    if (killed) {
      process.stderr.write(`[dsh-purge] reclaimed stale dsh web on :${port}, retrying boot\n`);
    }
  } catch {
    /* 回收失败不阻断启动 */
  }
}

function waitGone(pids, timeoutMs = 1500) {
  if (!pids.length) return;
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline && pids.some((pid) => alive(pid))) {
    try {
      Atomics.wait(sleeper, 0, 0, 80);
    } catch {
      break;
    }
  }
}

/* 被宿主 bin.js `import` 就执行，是注入机制要的行为。测试里把
   DSH_PURGE_PREFLIGHT_NOBOOT 设为 1 再 import，只拿 willServeWeb 做判定，不碰真进程。 */
if (process.env.DSH_PURGE_PREFLIGHT_NOBOOT !== "1") main();
