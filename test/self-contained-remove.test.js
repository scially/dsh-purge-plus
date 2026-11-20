/**
 * 三份「卸载后仍要能跑」的自包含删除副本：
 *   lib/restart-desktop.js / lib/uninstall-restart.js / bin/dsh-purge.js
 *
 * 这些副本故意不复用 lib/remove-tree.js —— 它们跑在「插件包已经/正在被卸载」
 * 的时刻，那时 lib/ 已经不在磁盘上。所以本测试**从源码文本里把函数抽出来**
 * 现场执行（证明零 import 依赖），再用真 junction 夹具断言「树内链接消失、
 * 树外目标一个字节没动」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPIES = ["lib/restart-desktop.js", "lib/uninstall-restart.js", "bin/dsh-purge.js"];
const BEGIN = "// BEGIN standalone no-follow cleanup (checked against lib/remove-tree.js)";
const END = "// END standalone no-follow cleanup";

function sourceOf(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function blockOf(rel) {
  const src = sourceOf(rel);
  const b = src.indexOf(BEGIN);
  const e = src.indexOf(END);
  assert.ok(b >= 0 && e > b, `${rel} 里找不到 standalone 标记块`);
  const block = src.slice(b, e + END.length);
  // 防手滑：块里只要出现 import/require，卸载后就会炸（那时模块已经不在）。
  assert.doesNotMatch(block, /\bimport\b/, `${rel} 的自包含副本里不允许出现 import`);
  assert.doesNotMatch(block, /\brequire\b/, `${rel} 的自包含副本里不允许出现 require`);
  assert.match(block, /function removeTreeNoFollowSync\(target, options = \{\}\) \{/, `${rel} 缺少函数定义`);
  return block;
}

/** 从源码文本现场构造函数：不 import 任何东西也能跑，才算真的自包含。 */
function loadCopy(rel) {
  const factory = new Function("fs", "path", `${blockOf(rel)}\nreturn removeTreeNoFollowSync;`);
  const fn = factory(fs, path);
  assert.equal(typeof fn, "function", `${rel} 没能抽出 removeTreeNoFollowSync`);
  return fn;
}

function makeFixture(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-nofollow-${tag}-`));
  const outside = path.join(base, "outside");
  const tree = path.join(base, "tree");
  fs.mkdirSync(path.join(tree, "sub"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "important.txt"), "KEEP-ME\n");
  fs.writeFileSync(path.join(tree, "sub", "own.txt"), "own\n");
  const link = path.join(tree, "link");
  let kind = "";
  if (process.platform === "win32") {
    // mklink /J 建 junction 不需要管理员权限
    execFileSync("cmd.exe", ["/c", "mklink", "/J", link, outside], { encoding: "utf8", windowsHide: true });
    kind = "junction";
  } else {
    fs.symlinkSync(outside, link, "dir");
    kind = "symlink";
  }
  return { base, outside, tree, link, kind };
}

function assertFixtureIntact(fx, label) {
  assert.equal(fs.existsSync(fx.tree), false, `${label}: 树没删干净`);
  assert.equal(fs.existsSync(path.join(fx.outside, "important.txt")), true, `${label}: 树外目标被删了（no-follow 失效）`);
  assert.equal(fs.readFileSync(path.join(fx.outside, "important.txt"), "utf8"), "KEEP-ME\n", `${label}: 树外文件内容被改`);
}

function dropFixture(fx) {
  try { fs.rmSync(fx.base, { recursive: true, force: true }); } catch { /* ignore */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

test("三份自包含副本逐字节一致（防漂移）", () => {
  const blocks = COPIES.map((rel) => blockOf(rel));
  assert.equal(new Set(blocks).size, 1, "三份副本已经漂移，请保持同一段文本");
});

test("三份副本的 maxRetries / retryDelay / 退避错误码一致", () => {
  for (const rel of COPIES) {
    const block = blockOf(rel);
    assert.match(block, /options\.maxRetries \?\? 8\b/, `${rel}: maxRetries 不是 8`);
    assert.match(block, /options\.retryDelay \?\? 120\b/, `${rel}: retryDelay 不是 120`);
    assert.match(
      block,
      /new Set\(\["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"\]\)/,
      `${rel}: 退避错误码表不一致`,
    );
  }
});

test("从源码文本抽出的副本：树内 junction 消失、树外目标存活", () => {
  for (const rel of COPIES) {
    const fn = loadCopy(rel);
    const fx = makeFixture(path.basename(rel, ".js"));
    try {
      fn(fx.tree);
      assertFixtureIntact(fx, rel);
    } finally {
      dropFixture(fx);
    }
  }
});

test("删除目标本身是 junction 时只摘链接，目标目录保住", () => {
  const fn = loadCopy(COPIES[0]);
  const fx = makeFixture("link-target");
  try {
    fn(fx.link);
    assert.equal(fs.existsSync(fx.link), false, "链接本身没被摘掉");
    assert.equal(fs.existsSync(path.join(fx.outside, "important.txt")), true, "junction 目标被删了");
  } finally {
    dropFixture(fx);
  }
});

test("ENOENT 幂等、拒删文件系统根、空目标不动 cwd", () => {
  const fn = loadCopy(COPIES[0]);
  const fx = makeFixture("semantics");
  const cwd = process.cwd();
  try {
    fn(fx.tree);
    assert.doesNotThrow(() => fn(fx.tree), "第二次调用必须幂等");
    assert.doesNotThrow(() => fn(path.join(fx.base, "nope", "nope")), "不存在的路径必须幂等");
    const root = path.parse(path.resolve(fx.base)).root;
    assert.throws(() => fn(root), /Refusing to remove a filesystem root/, "必须拒删文件系统根");
    assert.doesNotThrow(() => fn(""));
    assert.equal(process.cwd(), cwd, "空目标不能把 cwd 当删除目标");
  } finally {
    dropFixture(fx);
  }
});

test("只读文件先补写位再删（Windows readonly 属性）", () => {
  const fn = loadCopy(COPIES[0]);
  const fx = makeFixture("readonly");
  try {
    const ro = path.join(fx.tree, "sub", "ro.txt");
    fs.writeFileSync(ro, "ro\n");
    fs.chmodSync(ro, 0o444);
    fn(fx.tree);
    assertFixtureIntact(fx, "readonly");
  } finally {
    dropFixture(fx);
  }
});

test("真进程：restart-desktop.js 用自包含副本清理，junction 目标存活", { timeout: 60000 }, () => {
  const fx = makeFixture("proc-desktop");
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "lib", "restart-desktop.js")], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 45000,
      env: {
        ...process.env,
        DSH_PURGE_RESTART: JSON.stringify({ cleanup: [fx.tree], respawn: false }),
      },
    });
    assert.equal(r.status, 0, `helper 退出码 ${r.status}；stderr=${r.stderr}`);
    assertFixtureIntact(fx, "restart-desktop");
  } finally {
    dropFixture(fx);
  }
});

test("真进程：uninstall-restart.js 用自包含副本清理，junction 目标存活", { timeout: 60000 }, async () => {
  const fx = makeFixture("proc-uninstall");
  const port = await freePort();
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, "lib", "uninstall-restart.js")], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 45000,
      env: {
        ...process.env,
        DSH_PURGE_RESTART: JSON.stringify({
          port,
          host: "127.0.0.1",
          cleanup: [fx.tree],
          execPath: process.execPath,
          argv: ["-e", "process.exit(0)"],
          cwd: os.tmpdir(),
        }),
      },
    });
    assert.equal(r.status, 0, `helper 退出码 ${r.status}；stderr=${r.stderr}`);
    assertFixtureIntact(fx, "uninstall-restart");
  } finally {
    dropFixture(fx);
  }
});

test("三处调用点都用自包含副本，旧的裸 rmSync 递归删除已移除", () => {
  const desktop = sourceOf(COPIES[0]);
  const uninst = sourceOf(COPIES[1]);
  const binSrc = sourceOf(COPIES[2]);
  assert.match(desktop, /removeTreeNoFollowSync\(dir\);/, "restart-desktop 调用点没换");
  assert.match(uninst, /removeTreeNoFollowSync\(dir\);/, "uninstall-restart 调用点没换");
  assert.match(binSrc, /removeTreeNoFollowSync\(dir, \{ fs, path \}\);/, "bin 调用点没换");
  for (const [rel, src] of [[COPIES[0], desktop], [COPIES[1], uninst], [COPIES[2], binSrc]]) {
    assert.doesNotMatch(src, /rmSync\(dir, \{ recursive: true, force: true, maxRetries/, `${rel} 还留着旧的裸 rmSync 递归删除`);
  }
});
