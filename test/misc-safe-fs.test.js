// 零散点的安全文件操作：
//   A 组 —— 递归删目录改走 lib/remove-tree.js（不跟随符号链接 / junction，树外目标存活）；
//   B 组 —— 「临时文件 → 目标」的 rename 改走 lib/atomic-files.js 的退避版（被读句柄占住时重试）。
// 全部在本机真实文件系统上跑（临时目录），不联网、不碰真实 $DSH_HOME。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const snapshot = await load("lib/snapshot.js");
const tuning = await load("lib/tuning.js");
const drill = await load("lib/drill-grant.js");
const hooks = await load("lib/hooks-deny.js");
const preset = await load("lib/preset-default.js");

const isWindows = process.platform === "win32";

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${name}-`));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  } catch {
    /* 临时目录清理失败不影响结论 */
  }
}

/** atomic-files 的临时文件都以 .tmp 结尾：失败路径不许留。 */
function leftovers(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  } catch {
    return [];
  }
}

/** 建 junction（Windows）/ 目录符号链接（其它平台）：删除方一旦跟随就会动到树外。 */
function constantJunction(linkPath, target) {
  fs.symlinkSync(target, linkPath, isWindows ? "junction" : "dir");
}

/**
 * 真句柄占用：Windows 上普通读句柄就够让 rename 失败（MoveFileEx 不能替换被占的目标）。
 * 同步退避路径用 Atomics.wait 把事件循环堵住，主线程的 setTimeout 放不开句柄 —— 必须先开到 worker 里。
 * 「已打开 / 已关闭」用 MessageChannel + receiveMessageOnPort 同步收，避免和退避时序抢跑。
 */
function holdHandle(file, holdMs) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `const fs = require("node:fs");
const { workerData } = require("node:worker_threads");
const fd = fs.openSync(workerData.file, "r");
workerData.port.postMessage("open");
setTimeout(() => {
  try { fs.closeSync(fd); } catch { /* 已关 */ }
  workerData.port.postMessage("close");
}, workerData.holdMs);`,
    { eval: true, workerData: { file, holdMs, port: port2 }, transferList: [port2] },
  );
  const wait = (what) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const got = receiveMessageOnPort(port1);
      if (got && got.message === what) return true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    return false;
  };
  return {
    ready: wait("open"),
    closed: () => wait("close"),
    async release() {
      try {
        await worker.terminate();
      } catch {
        /* 已经退出 */
      }
      port1.close();
    },
  };
}

/* ------------------------------------------------------------ B 组：原子写 */

test("misc-safe-fs: drill-grant 写授权——目标被读句柄占住时退避重试，最后写成功且不留 .tmp", async () => {
  const home = tmpdir("drill-retry");
  const file = drill.drillGrantPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ granted: false })}\n`);
  const hold = holdHandle(file, 180);
  assert.ok(hold.ready, "worker 必须先真正打开句柄");
  try {
    const started = Date.now();
    const result = drill.writeDrillGrant(home);
    const elapsed = Date.now() - started;
    assert.equal(result.granted, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).granted, true);
    if (isWindows) assert.ok(elapsed >= 120, `被占用的目标必须退避重试（实际 ${elapsed}ms）`);
    assert.deepEqual(leftovers(path.dirname(file)), []);
  } finally {
    await hold.release();
  }
  cleanup(home);
});

test("misc-safe-fs: tuning 写 tuning.json——占用的目标重试后成功，内容可读回", async () => {
  const home = tmpdir("tuning-retry");
  const file = tuning.tuningPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ boost: true })}\n`);
  const hold = holdHandle(file, 180);
  assert.ok(hold.ready, "worker 必须先真正打开句柄");
  try {
    const started = Date.now();
    const next = tuning.writeTuning({ boost: false }, home);
    const elapsed = Date.now() - started;
    assert.equal(next.boost, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).boost, false);
    if (isWindows) assert.ok(elapsed >= 120, `被占用的目标必须退避重试（实际 ${elapsed}ms）`);
    assert.deepEqual(leftovers(path.dirname(file)), []);
  } finally {
    await hold.release();
  }
  cleanup(home);
});

test("misc-safe-fs: snapshot 回滚——目标被读句柄占住时重试后落地，快照字节一致", async () => {
  const home = tmpdir("snap-retry-home");
  const root = tmpdir("snap-retry-root");
  const dest = path.join(root, "app.js");
  fs.writeFileSync(dest, "v1-快照内容");
  const created = snapshot.createSnapshot(root, { dshHome: home, paths: [dest], label: "retry" });
  assert.equal(created.ok, true);
  fs.writeFileSync(dest, "v2-被改过");
  const hold = holdHandle(dest, 180);
  assert.ok(hold.ready, "worker 必须先真正打开句柄");
  try {
    const started = Date.now();
    const result = snapshot.restoreSnapshot(root, created.id, { dshHome: home });
    const elapsed = Date.now() - started;
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.restored, 1);
    assert.equal(fs.readFileSync(dest, "utf8"), "v1-快照内容");
    if (isWindows) assert.ok(elapsed >= 120, `被占用的目标必须退避重试（实际 ${elapsed}ms）`);
    assert.deepEqual(leftovers(root), []);
  } finally {
    await hold.release();
  }
  cleanup(home);
  cleanup(root);
});

test("misc-safe-fs: 占用一直不释放——drill-grant 抛错、目标字节不变、无 .tmp 残留", { skip: !isWindows }, async () => {
  const home = tmpdir("drill-stuck");
  const file = drill.drillGrantPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = `${JSON.stringify({ granted: true, at: "old" })}\n`;
  fs.writeFileSync(file, before);
  const hold = holdHandle(file, 30000);
  assert.ok(hold.ready, "worker 必须先真正打开句柄");
  try {
    assert.throws(
      () => drill.writeDrillGrant(home),
      (error) => ["EPERM", "EACCES", "EBUSY"].includes(error.code),
    );
    assert.equal(fs.readFileSync(file, "utf8"), before, "失败时目标字节必须原样");
    assert.deepEqual(leftovers(path.dirname(file)), [], "失败不能留下临时文件");
  } finally {
    await hold.release();
  }
  cleanup(home);
});

test("misc-safe-fs: 占用一直不释放——snapshot 回滚记错误、目标字节不变、无 .tmp 残留", { skip: !isWindows }, async () => {
  const home = tmpdir("snap-stuck-home");
  const root = tmpdir("snap-stuck-root");
  const dest = path.join(root, "app.js");
  fs.writeFileSync(dest, "v1");
  const created = snapshot.createSnapshot(root, { dshHome: home, paths: [dest] });
  assert.equal(created.ok, true);
  fs.writeFileSync(dest, "v2-不许被改回去");
  const hold = holdHandle(dest, 30000);
  assert.ok(hold.ready, "worker 必须先真正打开句柄");
  try {
    const result = snapshot.restoreSnapshot(root, created.id, { dshHome: home });
    assert.equal(result.ok, false);
    assert.equal(result.restored, 0);
    assert.match(result.errors[0].error, /写入失败/);
    assert.equal(fs.readFileSync(dest, "utf8"), "v2-不许被改回去");
    assert.deepEqual(leftovers(root), []);
  } finally {
    await hold.release();
  }
  cleanup(home);
  cleanup(root);
});

test("misc-safe-fs: hooks-deny 设置原子落盘——可读回、不留 .tmp", () => {
  const home = tmpdir("hooks-deny");
  const saved = hooks.saveHookDenySettings(home, { hooksDenyBypass: false });
  assert.equal(saved.ok, true);
  const file = hooks.hookDenySettingsPath(home);
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { hooksDenyBypass: false });
  assert.equal(hooks.loadHookDenySettings(home).hooksDenyBypass, false);
  assert.deepEqual(leftovers(path.dirname(file)), []);
  cleanup(home);
});

/* ------------------------------------------------------ A 组：不跟随链接删除 */

test("misc-safe-fs: pruneSnapshots 遇到指向树外的 junction——只摘链接，树外目标存活", () => {
  const home = tmpdir("prune-home");
  const root = tmpdir("prune-root");
  const outside = tmpdir("prune-outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "树外目标");
  const file = path.join(root, "app.js");
  fs.writeFileSync(file, "v1");
  const created = snapshot.createSnapshot(root, { dshHome: home, paths: [file], id: "20260101-000000-junc" });
  assert.equal(created.ok, true);
  const dir = snapshot.snapshotsRoot(home);
  constantJunction(path.join(dir, created.id, "files", "link-out"), outside);

  const dropped = snapshot.pruneSnapshots(home, 0);

  assert.deepEqual(dropped, [created.id]);
  assert.equal(fs.existsSync(path.join(dir, created.id)), false, "快照目录本身要删掉");
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "树外目标必须存活");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "树外目标");
  cleanup(home);
  cleanup(root);
  cleanup(outside);
});

test("misc-safe-fs: removeStaleAgentPresetDir 遇到指向树外的 junction——树外目标存活", () => {
  const home = tmpdir("preset-home");
  const outside = tmpdir("preset-outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "树外目标");
  const presetDir = path.join(home, ".agent-presets", "redteam");
  fs.mkdirSync(presetDir, { recursive: true });
  fs.writeFileSync(path.join(presetDir, "preset.json"), "{}");
  constantJunction(path.join(presetDir, "link-out"), outside);

  const removed = preset.removeStaleAgentPresetDir(home, "redteam");

  assert.equal(removed, true);
  assert.equal(fs.existsSync(presetDir), false);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "树外目标必须存活");
  cleanup(home);
  cleanup(outside);
});

/* --------------------------------------------- 其余接线点：源码顺序 / 引用断言 */

test("misc-safe-fs: 其余接线点用源码断言兜住（update/uninstall/index + 不留手写实现）", () => {
  const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");

  const update = read("lib/update.js");
  assert.match(update, /import \{ removeTreeNoFollow \} from "\.\/remove-tree\.js"/);
  assert.match(update, /await removeTreeNoFollow\(to, \{ fs, maxRetries: 8, retryDelay: 120 \}\)/);
  assert.match(update, /await removeTreeNoFollow\(tmp, \{ fs, maxRetries: 3, retryDelay: 80 \}\)/);
  assert.ok(!/fsp\.rm\([^)]*recursive/.test(update), "update 不该再有跟随链接的递归 rm");

  const uninstall = read("lib/uninstall.js");
  assert.match(uninstall, /import \{ removeTreeNoFollow \} from "\.\/remove-tree\.js"/);
  assert.match(uninstall, /await removeTreeNoFollow\(fp, \{ fs, maxRetries: 3, retryDelay: 100 \}\)/);
  assert.ok(!/fsp\.rm\(/.test(uninstall), "uninstall 的递归删已收敛到 removeTreeNoFollow");

  const index = read("lib/index.js");
  assert.match(index, /import \{ renameSyncWithRetry \} from "\.\/atomic-files\.js"/);
  assert.match(index, /renameSyncWithRetry\(fs, PURGE_INTERNAL_LOG, `\$\{PURGE_INTERNAL_LOG\}\.1`\)/);
  assert.ok(!index.includes("fs.renameSync(PURGE_INTERNAL_LOG"), "日志轮转不再裸 rename");

  // 改过的模块都必须接 helper，且不再自己写一份 rename 实现。
  const wired = [
    ["lib/snapshot.js", /import \{ atomicWriteSync \} from "\.\/atomic-files\.js"/, /import \{ removeTreeNoFollowSync \} from "\.\/remove-tree\.js"/],
    ["lib/tuning.js", /import \{ atomicWriteSync \} from "\.\/atomic-files\.js"/, null],
    ["lib/drill-grant.js", /import \{ atomicWriteSync \} from "\.\/atomic-files\.js"/, null],
    ["lib/hooks-deny.js", /import \{ atomicWriteSync \} from "\.\/atomic-files\.js"/, null],
    ["lib/preset-default.js", null, /import \{ removeTreeNoFollowSync \} from "\.\/remove-tree\.js"/],
  ];
  for (const [rel, atomic, tree] of wired) {
    const src = read(rel);
    if (atomic) assert.match(src, atomic, `${rel} 必须用 atomic-files`);
    if (tree) assert.match(src, tree, `${rel} 必须用 remove-tree`);
    assert.ok(!/fs\.renameSync\(/.test(src), `${rel} 不该再手写 rename（交给 atomic-files）`);
    assert.ok(!/rmSync\([^)]*recursive/.test(src), `${rel} 不该再有跟随链接的递归 rm`);
  }
});
