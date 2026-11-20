// 递归删除必须「只删目录项」：技能目录 / 解包目录里带链接时，绝不能顺着链接删到树外。
//
// 背景：本 fork 原先用 fs.rmSync(dir, { recursive: true })，那条路跟随符号链接与 Windows junction。
// 技能包（tar 解出来的链接）与官方更新的旧解包目录都可能带进外部来源的链接，卸载时就会连带删目标。
// 这里钉住移植件的行为：只摘链接、只读条目先补写位、幂等、拒绝删根、有界重试、hostFs 形状也能用。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { removeTreeNoFollow, removeTreeNoFollowSync } from "../lib/remove-tree.js";

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

test("remove-tree: 树内 junction 只摘链接，树外目标原样存活（同步）", () => {
  const root = tmpDir("rmtree-link");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const tree = path.join(root, "tree");
  fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tree, "a.txt"), "a");
  fs.writeFileSync(path.join(tree, "sub", "b.txt"), "b");
  linkDir(outside, path.join(tree, "junc"));
  linkDir(outside, path.join(tree, "sub", "deep-junc")); // 深层同样要挡住
  fs.symlinkSync(path.join(outside, "keep.txt"), path.join(tree, "file-link"), "file");

  removeTreeNoFollowSync(tree);

  assert.equal(fs.existsSync(tree), false, "树本身要删干净");
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true, "树外目标必须存活");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.deepEqual(fs.readdirSync(outside).sort(), ["keep.txt"], "目标目录内容不能被改动");
  cleanup(root);
});

test("remove-tree: 异步版同样不跟随链接（导入失败后的临时目录清理走这条）", async () => {
  const root = tmpDir("rmtree-async");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const temp = path.join(root, "tmp-skill");
  fs.mkdirSync(path.join(temp, "unpacked"), { recursive: true });
  fs.writeFileSync(path.join(temp, "unpacked", "SKILL.md"), "x");
  linkDir(outside, path.join(temp, "unpacked", "junc"));

  await removeTreeNoFollow(temp);

  assert.equal(fs.existsSync(temp), false);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  cleanup(root);
});

test("remove-tree: 大树（宽 + 深）删干净，深层链接仍不跟随", () => {
  const root = tmpDir("rmtree-big");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const tree = path.join(root, "tree");
  let cursor = tree;
  fs.mkdirSync(cursor, { recursive: true });
  for (let depth = 0; depth < 8; depth += 1) {
    for (let i = 0; i < 25; i += 1) fs.writeFileSync(path.join(cursor, `f${i}.txt`), "x");
    cursor = path.join(cursor, `d${depth}`);
    fs.mkdirSync(cursor);
  }
  linkDir(outside, path.join(cursor, "bottom-junc"));

  removeTreeNoFollowSync(tree);

  assert.equal(fs.existsSync(tree), false);
  assert.equal(fs.existsSync(path.join(outside, "keep.txt")), true);
  cleanup(root);
});

test("remove-tree: Windows 只读文件能被删掉（未注入 fs 的真实路径）", () => {
  const root = tmpDir("rmtree-ro");
  const file = path.join(root, "readonly.txt");
  fs.writeFileSync(file, "ro");
  fs.chmodSync(file, 0o444);
  assert.equal(fs.lstatSync(file).mode & 0o200, 0, "前置条件：这个条目确实没有写位");

  removeTreeNoFollowSync(root);

  assert.equal(fs.existsSync(root), false);
  cleanup(root);
});

test("remove-tree: 只读条目先补写位再删（注入 io 记录调用顺序）", () => {
  const root = tmpDir("rmtree-io");
  const ro = path.join(root, "ro.txt");
  fs.writeFileSync(ro, "x");
  fs.chmodSync(ro, 0o444);

  const calls = [];
  const io = {
    lstatSync: (p) => fs.lstatSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    chmodSync: (p, mode) => { calls.push(["chmod", p, mode & 0o777]); fs.chmodSync(p, mode); },
    unlinkSync: (p) => { calls.push(["unlink", p, (fs.lstatSync(p).mode & 0o200) !== 0]); fs.unlinkSync(p); },
    // 故意不给 rmdirSync：官方更新那条链传进来的 hostFs（extract-asar.js 白名单）就没有它，
    // 模块必须退回真实磁盘的 rmdirSync 才能收尾。
  };

  removeTreeNoFollowSync(root, { fs: io });

  assert.equal(fs.existsSync(root), false, "没有 rmdirSync 的 fs 也必须能删干净");
  const chmod = calls.find((c) => c[0] === "chmod");
  const unlink = calls.find((c) => c[0] === "unlink");
  assert.ok(unlink, "只读条目必须被删掉");
  /* 平台差异（CI 在 ubuntu/macos 上踩过）：Windows 上删只读文件要先补写位，
     POSIX 只要求父目录可写 —— 实现里 isReadOnly() 也只在 win32 返回真。 */
  if (process.platform === "win32") {
    assert.ok(chmod, "Windows：只读条目必须先补写位");
    assert.equal(chmod[2] & 0o200, 0o200, "补的写位要落在 chmod 上");
    assert.equal(unlink[2], true, "unlink 时条目已经是可写的");
    assert.ok(calls.indexOf(chmod) < calls.indexOf(unlink), "顺序必须是先 chmod 再 unlink");
  } else {
    assert.equal(chmod, undefined, "POSIX：不该去补文件写位（只看父目录写位）");
    assert.equal(unlink[2], false, "POSIX：unlink 时条目仍是只读位（不需要补）");
  }
  cleanup(root);
});

test("remove-tree: 不存在算成功；文件系统根一律拒绝", async () => {
  const root = tmpDir("rmtree-guard");
  const missing = path.join(root, "nope");
  assert.doesNotThrow(() => removeTreeNoFollowSync(missing));
  await removeTreeNoFollow(missing);

  const fsRoot = path.parse(process.cwd()).root;
  assert.throws(() => removeTreeNoFollowSync(fsRoot), /Refusing to remove a filesystem root/);
  await assert.rejects(removeTreeNoFollow(fsRoot), /Refusing to remove a filesystem root/);
  cleanup(root);
});

test("remove-tree: deleteSkill 卸载带 junction 的技能目录，树外目标存活（真实调用点）", async () => {
  const { saveSkill, deleteSkill } = await import("../lib/skills.js");
  const home = tmpDir("rmtree-skill-home");
  const outside = tmpDir("rmtree-skill-outside");
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const saved = await saveSkill(home, "demo-skill", "---\nname: demo-skill\ndescription: demo\n---\n\nbody\n", "demo");
  const bundle = path.dirname(saved.path);
  linkDir(outside, path.join(bundle, "junc"));

  await deleteSkill(home, "demo-skill");

  assert.equal(fs.existsSync(bundle), false, "技能目录要删掉");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  cleanup(home);
  cleanup(outside);
});

test("remove-tree: official-update 清旧解包目录不跟随 junction（真实调用点）", async () => {
  const { clearStaleExtractedApps } = await import("../lib/official-update.js");
  const install = tmpDir("rmtree-official");
  const exe = path.join(install, "DeepSeek Harness.exe");
  fs.writeFileSync(exe, "");
  const resources = path.join(install, "resources");
  fs.mkdirSync(resources);
  const outside = path.join(install, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "must survive");

  const stale = path.join(resources, "app.dshpurge-prev-123");
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, "index.js"), "x");
  linkDir(outside, path.join(stale, "junc"));
  const keep = path.join(resources, "app.dshpurge-keep");
  fs.mkdirSync(keep);

  clearStaleExtractedApps(exe);

  assert.equal(fs.existsSync(stale), false, "旧解包目录要清掉");
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "must survive");
  assert.equal(fs.existsSync(keep), true, "只清 app.dshpurge-prev* 前缀");
  cleanup(install);
});

test("remove-tree: EBUSY 有界重试，次数用尽后原样抛错", () => {
  const root = tmpDir("rmtree-retry");
  fs.writeFileSync(path.join(root, "x.txt"), "x");
  let attempts = 0;
  const base = {
    lstatSync: (p) => fs.lstatSync(p),
    readdirSync: (p) => fs.readdirSync(p),
    chmodSync: (p, mode) => fs.chmodSync(p, mode),
    rmdirSync: (p) => fs.rmdirSync(p),
  };
  const flaky = {
    ...base,
    unlinkSync: (p) => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      fs.unlinkSync(p);
    },
  };
  removeTreeNoFollowSync(root, { fs: flaky, maxRetries: 2, retryDelay: 1 });
  assert.equal(attempts, 3, "首次 + 2 次重试才成功");
  assert.equal(fs.existsSync(root), false);

  const stuck = tmpDir("rmtree-retry-stuck");
  fs.writeFileSync(path.join(stuck, "y.txt"), "y");
  const alwaysBusy = {
    ...base,
    unlinkSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
  };
  assert.throws(
    () => removeTreeNoFollowSync(stuck, { fs: alwaysBusy, maxRetries: 1, retryDelay: 1 }),
    (error) => error.code === "EBUSY",
  );
  cleanup(stuck);
  cleanup(root);
});
