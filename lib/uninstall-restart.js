import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
  info = JSON.parse(encoded);
} catch {
  process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";
const cleanup = Array.isArray(info.cleanup) ? info.cleanup : [];

function spawnEnv() {
  const env = { ...process.env };
  delete env.DSH_PERMISSION_MODE;
  delete env.DSH_PURGE_RESTART;
  return env;
}

function portFree() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(true));
  });
}

async function waitFree() {
  for (let i = 0; i < 80; i++) {
    if (await portFree()) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

function rmTree(dir) {
  if (!dir) return;
  try {
    removeTreeNoFollowSync(dir);
  } catch {
    // 锁着就留下
  }
}

const ok = await waitFree();
/* 端口等不到也要清理：以前直接退出，插件的目录和文件就永远留在那里，
   用户以为卸载成功，重启后插件还在。删不掉的会被 rmTree 吞掉，下一步照常。 */
for (const dir of cleanup) rmTree(dir);
if (info.helper) {
  try {
    fs.unlinkSync(info.helper);
  } catch {
    // ignore
  }
}

/* 端口没释放就不拉起新进程（会立刻撞端口），但上面的清理已经做完了。 */
if (!ok) process.exit(1);

const child = spawn(info.execPath, info.argv, {
  detached: true,
  stdio: "ignore",
  cwd: info.cwd || process.cwd(),
  env: spawnEnv(),
  windowsHide: true,
  shell: false,
});

child.on("error", () => process.exit(1));
child.unref();
await new Promise((r) => setTimeout(r, 400));
process.exit(0);

// BEGIN standalone no-follow cleanup (checked against lib/remove-tree.js)
/* 自包含 no-follow 删除：**故意不复用 lib/remove-tree.js**。
   这三份副本跑在「插件包已经/正在被卸载」的时刻，那时 lib/ 已经不在磁盘上，
   所以整段只允许依赖调用方作用域里的 fs / path（都是 node: 内置模块）。
   语义：lstat 优先 → 链接只 unlink 链接本身、绝不跟进；目录逐层非递归 rmdir；
        ENOENT 幂等；EBUSY/EPERM/ENOTEMPTY/EMFILE/ENFILE 有界退避（8 次 × 120ms 起）；
        Windows 只读条目先补写位再删；拒删文件系统根；空目标直接返回。 */
function removeTreeNoFollowSync(target, options = {}) {
  const io = options.fs || fs;
  const nodePath = options.path || path;
  const raw = String(target == null ? "" : target).trim();
  if (!raw) return;
  const root = nodePath.resolve(raw);
  if (root === nodePath.parse(root).root) throw new Error("Refusing to remove a filesystem root");
  const maxRetries = options.maxRetries ?? 8;
  const retryDelay = options.retryDelay ?? 120;
  const retryable = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  // Windows 只读条目删不掉：先补上写位。chmod 失败不在这里报错，交给后面的 unlink/rmdir。
  const clearReadOnly = (file, stat) => {
    try {
      if (typeof io.chmodSync !== "function") return;
      if ((stat.mode & 0o200) === 0) io.chmodSync(file, stat.mode | 0o200);
    } catch { /* ignore */ }
  };
  const walk = (file) => {
    let stat = null;
    try {
      stat = io.lstatSync(file);
    } catch (error) {
      if (error && error.code === "ENOENT") return; // 已经没了 = 幂等
      throw error;
    }
    // lstat 必须排在 isDirectory 之前：删除目标绝不 stat/realpath，否则会跟进 junction。
    try {
      if (stat.isSymbolicLink()) {
        io.unlinkSync(file); // 只删链接本身，目标一个字节都不动
        return;
      }
      if (stat.isDirectory()) {
        clearReadOnly(file, stat);
        for (const name of io.readdirSync(file)) walk(nodePath.join(file, name));
        io.rmdirSync(file); // 非递归：不借助原生递归 rm
      } else {
        clearReadOnly(file, stat);
        io.unlinkSync(file);
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      walk(root);
      return;
    } catch (error) {
      if (error && error.code === "ENOENT") return;
      // 有界退避：每次重试都重新 lstat 剩余条目（含根），不缓存任何 stat 结果。
      const code = error && error.code;
      if (attempt >= maxRetries || !retryable.has(code)) throw error;
      sleepSync(retryDelay * (attempt + 1));
    }
  }
}
// END standalone no-follow cleanup
