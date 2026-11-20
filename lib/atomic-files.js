/** 原子替换：先写同目录临时文件，再 rename 顶上；原文件的权限位保留下来（社区 #20）。
 *
 * 来源：社区版 lib/atomic-files.js（1.7.x）。本 fork 原先的 writeHostFileAtomic / 状态文件写入
 * 都是「写 tmp 直接 rename」，Windows 上只要目标文件被面板轮询、杀软、或别的进程拿了一个普通读句柄，
 * MoveFileEx 就抛 EPERM（本机实测：开着句柄 rename → EPERM，关掉立刻成功），一次失败整次写入作废。
 * 这里补上「写临时文件 + rename 退避重试」，并把三种写/拷路径收敛成一个模块。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { hostFs } from "./extract-asar.js";

/** 这些错误码是「目标暂时打不开」，不是逻辑错误：退避之后再 rename 一次。 */
const RENAME_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/** 同步退避：Atomics.wait 不把事件循环交出去（宿主启动期不能靠 setTimeout 排微任务）。 */
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 带退避的 rename（同步）。抽成「吃 fs 面」的模块级导出，是因为 core.js 的原子写走的是
 * `hostFs`（app.asar 还在时要写进真实 resources/app），**不能换成 node:fs**，
 * 但它需要同一套 EPERM/EACCES/EBUSY 退避 —— 两边必须是同一份实现，不复制第二份。
 */
export function renameSyncWithRetry(fs, from, to, tries = 5) {
  for (let i = 0; ; i += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!error || !RENAME_BUSY_CODES.has(error.code) || i >= tries - 1) throw error;
      sleepSync(50 * (i + 1));
    }
  }
}

/** 带退避的 rename（异步）；传入的 fs 面只要有 `rename`（通常是 `hostFs.promises`）。 */
export async function renameWithRetry(fs, from, to, tries = 5) {
  for (let i = 0; ; i += 1) {
    try {
      return await fs.rename(from, to);
    } catch (error) {
      if (!error || !RENAME_BUSY_CODES.has(error.code) || i >= tries - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

export function atomicFiles(fs = hostFs) {
  const fsp = fs.promises;

  /** 目标现有权限位；allowMissing 时目标不在按「新建」处理，不算错。 */
  const modeOf = (file, allowMissing = false) => {
    try {
      return fs.statSync(file).mode & 0o777;
    } catch (error) {
      if (allowMissing && error.code === "ENOENT") return undefined;
      throw error;
    }
  };

  // 同目录 + 唯一名字：跨设备 rename 会变成拷贝，也不该和别的进程的临时文件撞名。
  const temporary = (file) => `${file}.${process.pid}.${randomUUID()}.tmp`;

  const renameSyncRetry = (from, to, tries = 5) => renameSyncWithRetry(fs, from, to, tries);

  const renameRetry = (from, to, tries = 5) => renameWithRetry(fsp, from, to, tries);

  /** 同步原子写：失败时删掉临时文件，绝不把半截内容放到目标上。 */
  function atomicWriteSync(file, content, encoding = "utf8", options = {}) {
    const mode = options.exactMode ?? modeOf(file, true) ?? options.mode;
    const tmp = temporary(file);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: options.directoryMode });
    try {
      if (options.durable) {
        const fd = fs.openSync(tmp, "wx", mode);
        try {
          fs.writeFileSync(fd, content, { encoding });
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.writeFileSync(tmp, content, { encoding, mode, flag: "wx" });
      }
      // writeFile 的 mode 会被 umask 削掉：发布之前显式补回原文件的精确 rwx 位，
      // 私有配置与可执行文件都不能因为这次替换变宽或变窄。
      if (mode !== undefined) fs.chmodSync(tmp, mode);
      renameSyncRetry(tmp, file);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* 临时文件残留不影响正确性 */ }
      throw error;
    }
  }

  async function atomicWriteFile(file, content, encoding = "utf8", options = {}) {
    const mode = modeOf(file, true) ?? options.mode;
    const tmp = temporary(file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.writeFile(tmp, content, { encoding, mode, flag: "wx" });
      if (mode !== undefined) fs.chmodSync(tmp, mode);
      await renameRetry(tmp, file);
    } catch (error) {
      try { await fsp.unlink(tmp); } catch { /* 同上 */ }
      throw error;
    }
  }

  function atomicCopyFileSync(src, dest) {
    const mode = modeOf(src);
    const tmp = temporary(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(src, tmp, constants.COPYFILE_EXCL);
      fs.chmodSync(tmp, mode);
      renameSyncRetry(tmp, dest);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* 同上 */ }
      throw error;
    }
  }

  async function atomicCopyFile(src, dest) {
    const mode = modeOf(src);
    const tmp = temporary(dest);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fsp.copyFile(src, tmp, constants.COPYFILE_EXCL);
      fs.chmodSync(tmp, mode);
      await renameRetry(tmp, dest);
    } catch (error) {
      try { await fsp.unlink(tmp); } catch { /* 同上 */ }
      throw error;
    }
  }

  return { atomicWriteSync, atomicWriteFile, atomicCopyFileSync, atomicCopyFile };
}

export const { atomicWriteSync, atomicWriteFile, atomicCopyFileSync, atomicCopyFile } = atomicFiles();
