// 递归删除：只删目录项本身，绝不穿过符号链接 / Windows junction 去删链接目标里的东西。
//
// 来源：社区版 lib/remove-tree.js（1.7.x）。本 fork 原先各处直接用 fs.rmSync(..., { recursive: true })，
// 那条路径**跟随**链接：技能目录或解包目录里放一个指向树外的 junction，删除时就连带删掉目标，
// 而技能包（tar 解出来的链接）与官方更新目录都可能带进外部来源的链接条目。
//
// 语义（与上游一致）：
//   1) 先 lstat 再决定；链接一律只 unlink 链接本身，绝不对删除目标做 stat / realpath；
//   2) 目录自己递归 + 非递归 rmdir，不用原生 recursive rm —— 那条路会跟链接跑；
//   3) 条目本就不存在算成功（幂等）；其它错误原样抛给调用方；
//   4) EBUSY / EMFILE / ENFILE / ENOTEMPTY / EPERM 可按 maxRetries 有界退避重试（延迟线性递增）；
//   5) Windows 只读条目先补写权限位再删（老 libuv 的 unlink/rmdir 会直接 EPERM）。
import fs from "node:fs";
import path from "node:path";
import { diskFs } from "./extract-asar.js";

/** 可重试的错误码：被占用、句柄耗尽、目录还没空、Windows 属性/权限。 */
const RETRYABLE_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

/** 有界同步退避：这条路径可能跑在宿主启动期，不能把事件循环交出去（与 atomic-files 同一手法）。 */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 目录摘除器。hostFs 的白名单（extract-asar.js 的 HOST_SYNC）里没有 rmdirSync，
 * 而官方更新那条调用链传的就是 hostFs：缺它就退回真实磁盘的同名调用
 * （摘目录不会新建/删除 app.asar，因此无需让 asar 探针缓存失效）。
 */
function dirRemoverOf(io) {
  if (typeof io.rmdirSync === "function") return (dir) => io.rmdirSync(dir);
  const real = diskFs();
  return (dir) => real.rmdirSync(dir);
}

/** Windows 只读条目（mode 无写位）直接 unlink/rmdir 会 EPERM：先在条目上补写位再删。 */
function isReadOnly(stat) {
  return process.platform === "win32" && (stat.mode & 0o200) === 0;
}

/** 有界重试。delay 线性递增，与 fs.rmSync 的 maxRetries/retryDelay 语义对齐。 */
function retryDelayFor(options, attempt) {
  return (options.retryDelay ?? 100) * (attempt + 1);
}

/**
 * 同步版：递归删除 target，不跟随符号链接 / junction。
 * options: { fs, maxRetries = 0, retryDelay = 100 }。
 * 根目录本身是文件系统根时拒绝执行（一个手滑就等于格盘）。
 */
export function removeTreeNoFollowSync(target, options = {}) {
  const io = options.fs || fs;
  const rmdir = dirRemoverOf(io);
  const maxRetries = options.maxRetries ?? 0;
  const root = path.resolve(target);
  if (root === path.parse(root).root) throw new Error("Refusing to remove a filesystem root");

  const walk = (file) => {
    let stat;
    try {
      stat = io.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    // lstat 必须在任何 stat / realpath 之前：删除目标绝不能被解引用。
    try {
      if (stat.isSymbolicLink()) {
        io.unlinkSync(file); // junction 在 Windows 上也是这一支：只摘链接，目标原样留着
        return;
      }
      if (stat.isDirectory()) {
        for (const name of io.readdirSync(file)) walk(path.join(file, name));
        if (isReadOnly(stat) && typeof io.chmodSync === "function") {
          try { io.chmodSync(file, stat.mode | 0o200); } catch { /* 删不掉时由外层重试或原样抛错 */ }
        }
        rmdir(file); // 非递归：没有原生 recursive rm 兜底，就不会跟着链接跑出去
        return;
      }
      if (isReadOnly(stat) && typeof io.chmodSync === "function") {
        try { io.chmodSync(file, stat.mode | 0o200); } catch { /* 同上 */ }
      }
      io.unlinkSync(file);
    } catch (error) {
      // 枚举之后被外部删掉：这次删除的目标已经不存在了，算成功。
      if (error.code !== "ENOENT") throw error;
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      walk(root);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (attempt >= maxRetries || !RETRYABLE_CODES.has(error.code)) throw error;
      // 每次重试都从根重新 lstat 一遍剩下的条目，包括根自己。
      sleepSync(retryDelayFor(options, attempt));
    }
  }
}

/**
 * 异步版：同一套语义，给 await 调用方用。
 * options: { fs, maxRetries = 0, retryDelay = 100 }，fs 需要有 promises 面上的
 * lstat / readdir / unlink / rmdir（node:fs 自带）。
 */
export async function removeTreeNoFollow(target, options = {}) {
  const io = (options.fs || fs).promises;
  const maxRetries = options.maxRetries ?? 0;
  const root = path.resolve(target);
  if (root === path.parse(root).root) throw new Error("Refusing to remove a filesystem root");

  const clearReadOnly = async (file, stat) => {
    if (!isReadOnly(stat) || typeof io.chmod !== "function") return;
    try { await io.chmod(file, stat.mode | 0o200); } catch { /* 删不掉时由外层重试或原样抛错 */ }
  };

  const walk = async (file) => {
    let stat;
    try {
      stat = await io.lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    try {
      if (stat.isSymbolicLink()) {
        await io.unlink(file);
        return;
      }
      if (stat.isDirectory()) {
        for (const name of await io.readdir(file)) await walk(path.join(file, name));
        await clearReadOnly(file, stat);
        await io.rmdir(file);
        return;
      }
      await clearReadOnly(file, stat);
      await io.unlink(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  };

  for (let attempt = 0; ; attempt += 1) {
    try {
      await walk(root);
      return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (attempt >= maxRetries || !RETRYABLE_CODES.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayFor(options, attempt)));
    }
  }
}
