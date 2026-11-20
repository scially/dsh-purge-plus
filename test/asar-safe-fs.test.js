// extract-asar 主链路（装卸官方桌面版的换包路径）里的安全文件操作：
//   1) 递归删目录一律 no-follow —— 夹具目录带指向树外的 junction 时，只摘链接、目标必须存活；
//   2) 换目录 / 挪 asar 的 rename 带退避重试 —— 目标目录里有被打开的条目时 Windows 抛 EPERM，
//      退避后要能成功；一直占用则失败语义不变（{busy:true} / 抛错）且原文件字节不变。
//
// 本机探针结论（Node 26 / NTFS，脚本在 _scratch\fixall2\probe\）：
//   - rename 目录：目录里有被打开的条目 → EPERM，关掉后立刻成功（退避重试才有意义）；
//   - rename 自己的**源**文件被打开 → 反而成功，所以只能靠"目标目录里有被打开的条目"造锁；
//   - unlink / rmSync 对"被打开的文件"走 POSIX 语义删除 → 成功；因此删除路径的对照断言用
//     fs 打桩观测调用序列（unlinkSync + rmdirSync 是新的走法，且不再依赖 rmSync(recursive)）。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  commitExtractedDir,
  extractAsarToSide,
  renameAsarAside,
  renameWithRetrySync,
  restoreExtractedDir,
} from "../lib/extract-asar.js";
import { repairOfficialCliAfterUnpack } from "../lib/desktop.js";

const BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${tag}-`));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
}

/** Windows 上造 junction 不需要管理员权限；其它平台用目录符号链接。 */
function linkDir(target, linkPath) {
  if (process.platform === "win32") fs.symlinkSync(target, linkPath, "junction");
  else fs.symlinkSync(target, linkPath, "dir");
}

/**
 * 给 node:fs 的同步方法打桩。非 Electron 环境里 diskFs() 就是 node:fs，
 * 产品代码（extract-asar / remove-tree）的调用会打到桩上，可以观测调用序列。
 * 桩内部要调真实实现时用 `io.original.apply(fs, args)`，不要再走桩（否则自递归）。
 */
function spyFs(method, impl) {
  const original = fs[method];
  const calls = [];
  fs[method] = function patched(...args) {
    calls.push(args);
    return impl ? impl(...args) : original.apply(fs, args);
  };
  return {
    calls,
    original,
    restore() { fs[method] = original; },
    inside(root) { return calls.filter((args) => String(args[0]).startsWith(root)); },
  };
}

function mkdirp(...parts) {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const busyError = (code = "EBUSY") => Object.assign(new Error(`busy ${code}`), { code });

/* ------------------------------------------------------- 递归删：no-follow */

test("asar-safe-fs: discardDir 删半成品目录时只摘 junction，树外目标存活", () => {
  const root = tmpDir("asar-discard");
  const outside = mkdirp(root, "outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const dest = path.join(root, "resources", "app");
  const next = `${dest}.dshpurge-next`;
  mkdirp(next, "sub", "deep");
  fs.writeFileSync(path.join(next, "sub", "deep", "file.txt"), "x");
  fs.writeFileSync(path.join(next, "top.txt"), "y");
  linkDir(outside, path.join(next, "junc"));
  linkDir(outside, path.join(next, "sub", "deep", "deep-junc"));

  const asar = path.join(root, "app.asar");
  fs.writeFileSync(asar, Buffer.alloc(32, 0)); // 不是真 asar：extractAsar 在读头时失败

  let error = null;
  try {
    extractAsarToSide(asar, dest);
  } catch (err) {
    error = err;
  }

  assert.ok(error, "坏 asar 必须抛错");
  assert.equal(BUSY_CODES.has(error.code), false, `不能是占用类错误：${error.code}`);
  assert.equal(fs.existsSync(next), false, "半成品目录要清干净");
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "树外目标必须存活");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"], "目标目录内容不能被改动");
  cleanup(root);
});

test("asar-safe-fs: 对照断言——删除走 unlink+rmdir 的新走法，不再依赖 rmSync(recursive)", () => {
  const root = tmpDir("asar-nowalk");
  const outside = mkdirp(root, "outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const dest = path.join(root, "resources", "app");
  const next = `${dest}.dshpurge-next`;
  mkdirp(next, "sub");
  fs.writeFileSync(path.join(next, "sub", "file.txt"), "x");
  linkDir(outside, path.join(next, "junc"));

  const rmSpy = spyFs("rmSync");
  const unlinkSpy = spyFs("unlinkSync");
  const rmdirSpy = spyFs("rmdirSync");
  try {
    const asar = path.join(root, "app.asar");
    fs.writeFileSync(asar, Buffer.alloc(32, 0));
    assert.throws(() => extractAsarToSide(asar, dest));
  } finally {
    rmSpy.restore();
    unlinkSpy.restore();
    rmdirSpy.restore();
  }

  const junc = path.join(next, "junc");
  assert.equal(fs.existsSync(next), false, "半成品目录要清干净");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.ok(unlinkSpy.inside(root).some((args) => args[0] === junc), "链接要用 unlinkSync 摘掉");
  assert.ok(rmdirSpy.inside(root).length >= 2, "目录要用 rmdirSync 收尾");
  const recursiveRm = rmSpy.inside(root).filter((args) => args[1] && args[1].recursive === true);
  assert.deepEqual(recursiveRm, [], "这条路径不能再走 rmSync(recursive)");
  cleanup(root);
});

test("asar-safe-fs: restoreExtractedDir 删坏目录同样 no-follow，且换目录成功", () => {
  const root = tmpDir("asar-restore");
  const outside = mkdirp(root, "outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const destDir = path.join(root, "app");
  mkdirp(destDir, "sub");
  fs.writeFileSync(path.join(destDir, "broken.txt"), "broken");
  linkDir(outside, path.join(destDir, "junc"));
  const prev = `${destDir}.dshpurge-prev`;
  mkdirp(prev);
  fs.writeFileSync(path.join(prev, "restored.txt"), "restored");

  const unlinkSpy = spyFs("unlinkSync");
  let restored;
  try {
    restored = restoreExtractedDir(destDir, prev);
  } finally {
    unlinkSpy.restore();
  }

  assert.equal(restored, true);
  assert.equal(fs.existsSync(prev), false, "prev 要被换到 destDir 上");
  assert.equal(fs.readFileSync(path.join(destDir, "restored.txt"), "utf8"), "restored");
  assert.equal(fs.existsSync(path.join(destDir, "broken.txt")), false, "坏目录要被删掉");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.ok(
    unlinkSpy.inside(root).some((args) => String(args[0]).endsWith(`${path.sep}junc`)),
    "坏目录（已改名成 app.dshpurge-failed-*）里的链接要 no-follow 摘掉",
  );
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes("failed")), [], "failed 目录不能残留");
  cleanup(root);
});

/* ------------------------------------------------- 带退避 rename：单元断言 */

test("asar-safe-fs: renameWithRetrySync 撞占用退避后成功", () => {
  const attempts = [];
  const io = {
    renameSync() {
      attempts.push("try");
      if (attempts.length <= 2) throw busyError();
      return undefined;
    },
  };

  assert.equal(renameWithRetrySync(io, "a", "b"), true);
  assert.equal(attempts.length, 3, "前两次 EPERM/EBUSY，第三次成功");
});

test("asar-safe-fs: renameWithRetrySync 一直占用 → 原样抛错且次数有界", () => {
  let attempts = 0;
  const io = {
    renameSync() {
      attempts += 1;
      throw busyError("EPERM");
    },
  };

  assert.throws(() => renameWithRetrySync(io, "a", "b"), (error) => error.code === "EPERM");
  assert.equal(attempts, 5, "默认 5 次尝试后放弃");
});

test("asar-safe-fs: renameWithRetrySync 非占用类错误立即抛，不重试", () => {
  let attempts = 0;
  const io = {
    renameSync() {
      attempts += 1;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  };

  assert.throws(() => renameWithRetrySync(io, "a", "b"), (error) => error.code === "ENOENT");
  assert.equal(attempts, 1);
});

/* ------------------------------------- 带退避 rename：真实目录锁 / 真归档文件 */

test("asar-safe-fs: destDir 里有被打开的条目 → commitExtractedDir 退避后换目录成功", () => {
  const root = tmpDir("asar-commit");
  const destDir = path.join(root, "app");
  mkdirp(destDir, "sub");
  fs.writeFileSync(path.join(destDir, "sub", "old.txt"), "old");
  const nextDir = `${destDir}.dshpurge-next`;
  mkdirp(nextDir);
  fs.writeFileSync(path.join(nextDir, "new.txt"), "new");

  // 真实读句柄：Windows 上"目录里有被打开的条目"时 rename 这个目录就是 EPERM（探针 P5）。
  const fd = fs.openSync(path.join(destDir, "sub", "old.txt"), "r");
  let attempts = 0;
  let released = false;
  const renameSpy = spyFs("renameSync", (from, to) => {
    attempts += 1;
    if (attempts > 1 && !released) {
      // 第一次真的撞锁（句柄还开着 → 系统抛 EPERM）；第二次尝试前释放句柄，
      // 证明"重试之后才成功"而不是一开始就没锁。
      released = true;
      fs.closeSync(fd);
    }
    return renameSpy.original.apply(fs, [from, to]);
  });

  let result;
  try {
    result = commitExtractedDir(destDir, nextDir);
  } finally {
    renameSpy.restore();
    try { fs.closeSync(fd); } catch { /* 已经关了 */ }
  }

  assert.equal(released, true, "第二次尝试前应当释放了句柄");
  assert.ok(attempts >= 2, `第一次 EPERM 后必须重试（实际 ${attempts} 次）`);
  assert.equal(fs.existsSync(nextDir), false, "next 目录要被换上去");
  assert.equal(fs.readFileSync(path.join(destDir, "new.txt"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(result.prev, "sub", "old.txt"), "utf8"), "old", "旧目录要完整留在 prev");
  cleanup(root);
});

test("asar-safe-fs: 句柄一直不释放 → commitExtractedDir 抛 EPERM 且两边原样在位", () => {
  const root = tmpDir("asar-commit-stuck");
  const destDir = path.join(root, "app");
  mkdirp(destDir, "sub");
  fs.writeFileSync(path.join(destDir, "sub", "old.txt"), "old");
  const nextDir = `${destDir}.dshpurge-next`;
  mkdirp(nextDir);
  fs.writeFileSync(path.join(nextDir, "new.txt"), "new");

  const fd = fs.openSync(path.join(destDir, "sub", "old.txt"), "r");
  const renameSpy = spyFs("renameSync");
  try {
    assert.throws(() => commitExtractedDir(destDir, nextDir), (error) => error.code === "EPERM");
  } finally {
    renameSpy.restore();
    fs.closeSync(fd);
  }

  assert.equal(renameSpy.calls.length, 5, "占用类错误最多重试 5 次");
  assert.equal(fs.readFileSync(path.join(destDir, "sub", "old.txt"), "utf8"), "old", "旧目录必须原样在位");
  assert.equal(fs.readFileSync(path.join(nextDir, "new.txt"), "utf8"), "new", "next 目录必须原样在位");
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.includes("dshpurge-prev") || n.includes("recover")),
    [],
    "第一跳没成功就不能产生 prev / recover.json",
  );
  cleanup(root);
});

test("asar-safe-fs: renameAsarAside 成功挪走 asar，字节原样进 .bak", () => {
  const root = tmpDir("asar-aside");
  const asar = path.join(root, "app.asar");
  const bytes = Buffer.from([4, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
  fs.writeFileSync(asar, bytes);

  const result = renameAsarAside(asar);

  assert.equal(result.renamed, true);
  assert.equal(result.bak, `${asar}.bak`);
  assert.equal(fs.existsSync(asar), false, "asar 要被挪走");
  assert.deepEqual(fs.readFileSync(result.bak), bytes, "bak 字节要和原归档一致");
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith(".tmp")), [], "不能留临时文件");
  cleanup(root);
});

test("asar-safe-fs: renameAsarAside 一直占用 → {busy:true}、asar 原样在位且字节不变", () => {
  const root = tmpDir("asar-busy");
  const asar = path.join(root, "app.asar");
  const bytes = Buffer.from([4, 0, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9]);
  fs.writeFileSync(asar, bytes);

  // 模拟杀软/官方更新器一直拿着目标：每次 rename 都是 EPERM。
  const renameSpy = spyFs("renameSync", () => { throw busyError("EPERM"); });
  let result;
  try {
    result = renameAsarAside(asar);
  } finally {
    renameSpy.restore();
  }

  assert.deepEqual(result, { renamed: false, busy: true, bak: `${asar}.bak` });
  assert.equal(renameSpy.calls.length, 5, "占用类错误最多重试 5 次");
  assert.equal(fs.existsSync(asar), true, "asar 必须原样在位");
  assert.deepEqual(fs.readFileSync(asar), bytes, "asar 字节不能被改动");
  assert.equal(fs.existsSync(`${asar}.bak`), false, "没挪走就不能有 bak");
  cleanup(root);
});

test("asar-safe-fs: renameAsarAside 中途释放占用 → 退避后成功", () => {
  const root = tmpDir("asar-busy-then-ok");
  const asar = path.join(root, "app.asar");
  const bytes = Buffer.from([4, 0, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7]);
  fs.writeFileSync(asar, bytes);

  let attempts = 0;
  const renameSpy = spyFs("renameSync", (from, to) => {
    attempts += 1;
    if (attempts <= 2) throw busyError();
    return renameSpy.original.apply(fs, [from, to]);
  });
  let result;
  try {
    result = renameAsarAside(asar);
  } finally {
    renameSpy.restore();
  }

  assert.equal(result.renamed, true);
  assert.equal(attempts, 3, "两次占用后第三次成功");
  assert.deepEqual(fs.readFileSync(result.bak), bytes);
  assert.equal(fs.existsSync(asar), false);
  cleanup(root);
});

/* --------------------------------------------- desktop.js：app/runtime 链接替换 */

/** 伪造官方安装目录（DeepSeek Harness.exe + resources/{app,runtime}）。 */
function fakeOfficialInstall(tag) {
  const root = tmpDir(tag);
  const exe = path.join(root, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "");
  const resources = mkdirp(root, "resources");
  const appDir = mkdirp(resources, "app");
  mkdirp(resources, "runtime");
  return { root, exe, resources, appDir, link: path.join(appDir, "runtime") };
}

test("asar-safe-fs: desktop 替换 app/runtime 时只摘旧条目，不再走 rmSync(recursive)", () => {
  const fx = fakeOfficialInstall("asar-desktop-file");
  fs.writeFileSync(fx.link, "stray file");

  const unlinkSpy = spyFs("unlinkSync");
  const rmSpy = spyFs("rmSync");
  let report;
  try {
    report = repairOfficialCliAfterUnpack(fx.exe);
  } finally {
    unlinkSpy.restore();
    rmSpy.restore();
  }

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.symlink.created, true, `symlink=${JSON.stringify(report.symlink)}`);
  assert.ok(unlinkSpy.calls.some((args) => String(args[0]) === fx.link), "旧条目要用 unlinkSync 摘掉");
  assert.deepEqual(
    rmSpy.calls.filter((args) => args[1] && args[1].recursive === true),
    [],
    "这条路径不能再走 rmSync(recursive)",
  );
  assert.equal(fs.lstatSync(fx.link).isSymbolicLink(), true, "app/runtime 应当被换成链接");
  cleanup(fx.root);
});

test("asar-safe-fs: desktop 换链接时只摘链接，树外目标必须存活", () => {
  const fx = fakeOfficialInstall("asar-desktop-link");
  const outside = mkdirp(fx.root, "outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");
  // app/runtime 是一个指向树外的 junction；用 existsSync 打桩让它走到删除分支
  // （真实系统上 existsSync 会看到它，从而走 already 分支；这里验证的是删除分支的语义）。
  fs.rmSync(fx.link, { force: true });
  linkDir(outside, fx.link);
  const realExists = fs.existsSync;
  fs.existsSync = (p) => (String(p) === fx.link ? false : realExists.call(fs, p));
  const unlinkSpy = spyFs("unlinkSync");
  let report;
  try {
    report = repairOfficialCliAfterUnpack(fx.exe);
  } finally {
    unlinkSpy.restore();
    fs.existsSync = realExists;
  }

  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.symlink.created, true, `symlink=${JSON.stringify(report.symlink)}`);
  assert.ok(
    unlinkSpy.calls.some((args) => String(args[0]) === fx.link),
    "旧链接要用 unlinkSync 摘掉（不跟进目标）",
  );
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "树外目标必须存活");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.equal(fs.lstatSync(fx.link).isSymbolicLink(), true, "app/runtime 应当被换成新链接");
  cleanup(fx.root);
});

/* ------------------------------------------------- 主链路 happy path（不能被改坏） */

/** 手搓一个最小合法 app.asar：16 字节 pickle 头 + JSON 目录 + 正文。 */
function buildAsar(entries) {
  const files = {};
  let offset = 0;
  const chunks = [];
  for (const [rel, content] of entries) {
    const buf = Buffer.from(content, "utf8");
    const parts = rel.split("/");
    let node = files;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] || { files: {} };
      node = node[part].files;
    }
    node[parts[parts.length - 1]] = { size: buf.length, offset };
    offset += buf.length;
    chunks.push(buf);
  }
  const json = Buffer.from(JSON.stringify({ files }), "utf8");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + json.length, 4);
  header.writeUInt32LE(json.length, 8);
  header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, json, ...chunks]);
}

test("asar-safe-fs: 解包 + 换目录 happy path 照常可用（退避不改变成功路径）", () => {
  const root = tmpDir("asar-roundtrip");
  const asar = path.join(root, "app.asar");
  fs.writeFileSync(asar, buildAsar([["main.js", "console.log(1)\n"], ["lib/util.js", "export const x = 1;\n"]]));
  const destDir = path.join(root, "resources", "app");
  fs.mkdirSync(path.dirname(destDir), { recursive: true });

  const side = extractAsarToSide(asar, destDir);
  assert.equal(side.count, 2);
  assert.equal(fs.readFileSync(path.join(side.next, "main.js"), "utf8"), "console.log(1)\n");

  const first = commitExtractedDir(destDir, side.next);
  assert.equal(first.prev, "", "destDir 本来不存在时不该有 prev");
  assert.equal(fs.readFileSync(path.join(destDir, "lib", "util.js"), "utf8"), "export const x = 1;\n");

  const side2 = extractAsarToSide(asar, destDir);
  const second = commitExtractedDir(destDir, side2.next);
  assert.equal(second.prev, `${destDir}.dshpurge-prev`);
  assert.equal(fs.existsSync(path.join(second.prev, "main.js")), true, "旧目录要完整留在 prev");
  assert.equal(fs.existsSync(path.join(destDir, "main.js")), true);
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.endsWith(".tmp")),
    [],
    "不能留临时文件",
  );
  cleanup(root);
});

test("asar-safe-fs: renameAsarAside 归档不在时直接返回 {renamed:false}", () => {
  const root = tmpDir("asar-missing");
  const result = renameAsarAside(path.join(root, "nope.asar"));
  assert.deepEqual(result, { renamed: false });
  cleanup(root);
});
