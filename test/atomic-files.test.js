// 原子写：临时文件 + rename；rename 撞上 EPERM/EACCES/EBUSY 要退避重试，失败不留残渣。
//
// 背景：本机实测（Node 26 / NTFS）目标文件只要有一个普通读句柄，MoveFileEx 就是 EPERM；
// 关掉句柄立刻成功。面板轮询、杀软、另一个进程都会造成这种瞬时占用，所以退避重试是必须的；
// 重试耗尽时必须原样抛错，并且把临时文件清掉，不能把半截内容发布出去。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicFiles, atomicWriteFile, atomicWriteSync } from "../lib/atomic-files.js";
import { writeHostFileAtomic } from "../lib/hide-console.js";

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${tag}-`));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

/** 计数用的 fs 代理：只包 atomic-files 会碰的方法，顺便数 rename 试了几次。 */
function countingFs(failTimes = 0, code = "EBUSY") {
  const p = fs.promises;
  const calls = { renameSync: 0, rename: 0 };
  const io = {
    statSync: (...a) => fs.statSync(...a),
    mkdirSync: (...a) => fs.mkdirSync(...a),
    writeFileSync: (...a) => fs.writeFileSync(...a),
    chmodSync: (...a) => fs.chmodSync(...a),
    unlinkSync: (...a) => fs.unlinkSync(...a),
    copyFileSync: (...a) => fs.copyFileSync(...a),
    openSync: (...a) => fs.openSync(...a),
    fsyncSync: (...a) => fs.fsyncSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
    renameSync: (...a) => {
      calls.renameSync += 1;
      if (calls.renameSync <= failTimes) throw Object.assign(new Error("busy"), { code });
      return fs.renameSync(...a);
    },
    promises: {
      mkdir: (...a) => p.mkdir(...a),
      writeFile: (...a) => p.writeFile(...a),
      unlink: (...a) => p.unlink(...a),
      copyFile: (...a) => p.copyFile(...a),
      rename: async (...a) => {
        calls.rename += 1;
        if (calls.rename <= failTimes) throw Object.assign(new Error("busy"), { code });
        return p.rename(...a);
      },
    },
  };
  return { io, calls };
}

test("atomic-files: 同步写替换内容、保留权限位、不留临时文件", () => {
  const dir = tmpDir("atomic-sync");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  fs.chmodSync(file, 0o600);

  atomicWriteSync(file, "new", "utf8");

  assert.equal(fs.readFileSync(file, "utf8"), "new");
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === "win32") assert.equal(mode & 0o200, 0o200, "Windows 上没有只读位");
  else assert.equal(mode, 0o600, "POSIX 上原权限位必须保留");
  assert.deepEqual(leftovers(dir), [], "不能留下临时文件");
  cleanup(dir);
});

test("atomic-files: 目标目录不存在时自动建（递归）", async () => {
  const dir = tmpDir("atomic-mkdir");
  const file = path.join(dir, "a", "b", "state.json");

  await atomicWriteFile(file, "deep", "utf8");

  assert.equal(fs.readFileSync(file, "utf8"), "deep");
  assert.deepEqual(leftovers(path.dirname(file)), []);
  cleanup(dir);
});

test("atomic-files: rename 被 EBUSY/EPERM 挡住时退避重试到成功（注入 fs）", async () => {
  const dir = tmpDir("atomic-retry");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const { io, calls } = countingFs(2);

  await atomicFiles(io).atomicWriteFile(file, "new", "utf8");

  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(calls.rename, 3, "前两次 EBUSY，第三次才成功");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});

test("atomic-files: 目标被真实句柄占用时退避重试后成功", async () => {
  const dir = tmpDir("atomic-hold");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const { io, calls } = countingFs(0);
  // Windows 上普通读句柄就够让 rename EPERM；这里 120ms 后释放，退避序列 50/100/150ms 内能接上。
  const fd = fs.openSync(file, "r");
  const release = setTimeout(() => { try { fs.closeSync(fd); } catch { /* 已关 */ } }, 120);

  try {
    await atomicFiles(io).atomicWriteFile(file, "new", "utf8");
  } finally {
    clearTimeout(release);
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }

  assert.equal(fs.readFileSync(file, "utf8"), "new", "占用释放后必须写成功");
  assert.deepEqual(leftovers(dir), []);
  if (process.platform === "win32") {
    assert.ok(calls.rename >= 2, `被占用的目标必须重试（实际 rename 次数 ${calls.rename}）`);
  }
  cleanup(dir);
});

test("atomic-files: 占用一直不释放 → 抛错且不留临时文件", { skip: process.platform !== "win32" }, async () => {
  const dir = tmpDir("atomic-stuck");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const { io } = countingFs(0);
  const fd = fs.openSync(file, "r"); // 句柄一直不关：rename 5 次都是 EPERM
  try {
    await assert.rejects(
      atomicFiles(io).atomicWriteFile(file, "new", "utf8"),
      (error) => error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES",
    );
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关 */ }
  }

  assert.equal(fs.readFileSync(file, "utf8"), "old", "失败时目标必须保持原样");
  assert.deepEqual(leftovers(dir), [], "失败也不能留下临时文件");
  cleanup(dir);
});

test("atomic-files: 同步 path 的 EBUSY 用尽重试后抛错并要求清理临时文件", () => {
  const dir = tmpDir("atomic-sync-stuck");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const { io, calls } = countingFs(99);

  assert.throws(
    () => atomicFiles(io).atomicWriteSync(file, "new", "utf8"),
    (error) => error.code === "EBUSY",
  );

  assert.equal(calls.renameSync, 5, "默认重试 5 次后放弃");
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});

test("atomic-files: 同步路径重试两次后成功", () => {
  const dir = tmpDir("atomic-sync-retry");
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  const { io, calls } = countingFs(2);

  atomicFiles(io).atomicWriteSync(file, "new", "utf8");

  assert.equal(fs.readFileSync(file, "utf8"), "new");
  assert.equal(calls.renameSync, 3, "前两次 EBUSY，第三次才成功");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});

test("atomic-files: hide-console 的 writeHostFileAtomic 已接到退避重试（旧实现第一次失败就抛）", () => {
  const dir = tmpDir("atomic-wire");
  const side = path.join(dir, "dsh-purge-hide-console.js");
  fs.writeFileSync(side, "old");
  const { io, calls } = countingFs(2);

  writeHostFileAtomic(io, side, "new");

  assert.equal(fs.readFileSync(side, "utf8"), "new");
  assert.equal(calls.renameSync, 3, "rename 必须走 atomic-files 的重试");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});

test("atomic-files: 拷贝变体同样原子且不留临时文件", () => {
  const dir = tmpDir("atomic-copy");
  const src = path.join(dir, "src.bin");
  const dest = path.join(dir, "dest.bin");
  fs.writeFileSync(src, "payload");
  fs.writeFileSync(dest, "old");

  atomicFiles(fs).atomicCopyFileSync(src, dest);

  assert.equal(fs.readFileSync(dest, "utf8"), "payload");
  assert.equal(fs.readFileSync(src, "utf8"), "payload", "源文件保持不动");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});

test("atomic-files: 默认导出走 hostFs，能落到真实磁盘", () => {
  const dir = tmpDir("atomic-default");
  const file = path.join(dir, "state.json");

  atomicWriteSync(file, "host-fs", "utf8");

  assert.equal(fs.readFileSync(file, "utf8"), "host-fs");
  assert.deepEqual(leftovers(dir), []);
  cleanup(dir);
});
