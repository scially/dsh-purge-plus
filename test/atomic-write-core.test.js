// core.js 的四个原子写/拷：目标打不开时退避重试，失败时不能留临时文件、不能动目标字节。
//
// 为什么单独钉这条：core.js 的原子写走 `hostFs`（app.asar 还在时要写进真实 resources/app），
// 不能像 lib/atomic-files.js 那样换成 node:fs，所以它借用的是同一份「吃 fs 面」的退避助手
// （renameSyncWithRetry / renameWithRetry）。这几条用例守住：退避确实生效、权限位保留、失败路径干净。
//
// 平台差异（CI 在 ubuntu/macos 上踩过）：POSIX **允许** rename 覆盖已打开的文件，所以
// 「持一个读句柄 → 一定失败」只有 Windows 成立；POSIX 上改用「父目录不可写 → EACCES」构造失败现场。
// 两个平台都必须判绿：Windows `node --test`；Linux `wsl -e bash -lc "… node --test"`。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const core = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

const IS_WINDOWS = process.platform === "win32";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

function tmpDir(t, label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-atomic-${label}-`));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** 只看临时文件残留（.tmp / .copytmp），目录里原有的正常文件不算。 */
function tempLeftovers(dir) {
	return fs.readdirSync(dir).filter((f) => /\.(tmp|copytmp)$/.test(f));
}

/** 同步等一小会儿（Atomics.wait 不交事件循环）——给别的进程留出持句柄的时间里用。 */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 让**子进程**持一个普通读句柄，`holdMs` 之后自己关掉。
 * 不能用同进程的 setTimeout：同步退避循环用 Atomics.wait 阻塞事件循环，定时器根本不会触发。
 */
function holdWithChild(t, fp, holdMs) {
	const child = spawn(
		process.execPath,
		["-e", `const fs=require("node:fs");const h=fs.openSync(process.argv[1],"r");setTimeout(()=>{fs.closeSync(h);process.exit(0)},${holdMs})`, fp],
		{ stdio: "ignore", windowsHide: true },
	);
	t.after(() => { try { child.kill(); } catch { /* ignore */ } });
	sleepSync(80); // 等子进程真的把文件打开
	return child;
}

/**
 * 造一个「这次写入一定失败」的现场，返回还原函数。
 *   Windows —— 开一个读句柄不放：rename 顶上去会 EPERM（本机实测）。
 *   POSIX   —— 把父目录 chmod 0o500：rename 需要父目录写位，稳定 EACCES；read 句柄在 POSIX 不挡 rename。
 * 以 root 跑时跳过 POSIX 权限法（root 绕过权限检查），由调用方 `t.skip`。
 */
function makeWriteFail(dir, target) {
	if (IS_WINDOWS) {
		const handle = fs.openSync(target, "r");
		return () => { try { fs.closeSync(handle); } catch { /* ignore */ } };
	}
	fs.chmodSync(dir, 0o500);
	return () => { try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ } };
}

test("core.atomicWriteSync: 目标被读句柄占用时仍写成功（Windows 走退避）", (t) => {
	const dir = tmpDir(t, "sync-busy");
	const fp = path.join(dir, "state.json");
	fs.writeFileSync(fp, "旧内容");
	fs.chmodSync(fp, 0o755);
	holdWithChild(t, fp, 150);

	core.atomicWriteSync(fp, "新内容");
	assert.equal(fs.readFileSync(fp, "utf8"), "新内容", "应当写入成功");
	// Windows 的可执行位不可表达（chmod 只切只读位），照既有测试的口径分开断言。
	const mode = fs.statSync(fp).mode & 0o777;
	if (IS_WINDOWS) assert.equal(mode & 0o200, 0o200, "Windows 上不能被写成只读");
	else assert.equal(mode, 0o755, "POSIX 上原权限位必须保留（#155/#157）");
	assert.deepEqual(tempLeftovers(dir), [], "不该残留临时文件");
});

test("core.atomicWriteSync: 目标一直写不进去 → 抛错、目标字节不变、无临时文件", (t) => {
	if (!IS_WINDOWS && IS_ROOT) return t.skip("以 root 运行，POSIX 权限拒绝构造不出来");
	const dir = tmpDir(t, "sync-fail");
	const fp = path.join(dir, "state.json");
	fs.writeFileSync(fp, "原始内容");
	const restore = makeWriteFail(dir, fp);
	try {
		assert.throws(() => core.atomicWriteSync(fp, "不该落盘的内容"), /EPERM|EACCES|EBUSY/);
	} finally {
		restore();
	}
	assert.equal(fs.readFileSync(fp, "utf8"), "原始内容", "失败时目标必须原样");
	assert.deepEqual(tempLeftovers(dir), [], "失败路径必须清掉临时文件");
});

test("core.atomicWriteFile: 目标被读句柄占用时仍写成功，写不进去时干净退出", async (t) => {
	if (!IS_WINDOWS && IS_ROOT) return t.skip("以 root 运行，POSIX 权限拒绝构造不出来");
	const dir = tmpDir(t, "async-busy");
	const fp = path.join(dir, "state.json");
	fs.writeFileSync(fp, "旧内容");
	const handle = fs.openSync(fp, "r");
	t.after(() => { try { fs.closeSync(handle); } catch { /* ignore */ } });
	const timer = setTimeout(() => { try { fs.closeSync(handle); } catch { /* ignore */ } }, 120);
	t.after(() => clearTimeout(timer));

	await core.atomicWriteFile(fp, "新内容");
	assert.equal(fs.readFileSync(fp, "utf8"), "新内容");
	assert.deepEqual(tempLeftovers(dir), []);

	const fp2 = path.join(dir, "locked.json");
	fs.writeFileSync(fp2, "原样");
	const deny = path.join(dir, "deny");
	fs.mkdirSync(deny);
	const locked = path.join(deny, "locked.json");
	fs.writeFileSync(locked, "原样");
	const restore = makeWriteFail(deny, locked);
	try {
		await assert.rejects(() => core.atomicWriteFile(locked, "不许落盘"), /EPERM|EACCES|EBUSY/);
	} finally {
		restore();
	}
	assert.equal(fs.readFileSync(locked, "utf8"), "原样");
	assert.deepEqual(tempLeftovers(deny), [], "失败路径不该残留临时文件");
	assert.deepEqual(tempLeftovers(dir), []);
});

test("core.atomicCopyFile(Sync): 拷贝也带退避，失败不留 .copytmp", async (t) => {
	if (!IS_WINDOWS && IS_ROOT) return t.skip("以 root 运行，POSIX 权限拒绝构造不出来");
	const dir = tmpDir(t, "copy");
	const src = path.join(dir, "src.bin");
	const dst = path.join(dir, "dst.bin");
	fs.writeFileSync(src, "PAYLOAD");
	fs.writeFileSync(dst, "OLD");

	core.atomicCopyFileSync(src, dst);
	assert.equal(fs.readFileSync(dst, "utf8"), "PAYLOAD");
	assert.deepEqual(tempLeftovers(dir), [], "同步拷贝不该留 .copytmp");

	await core.atomicCopyFile(src, dst);
	assert.equal(fs.readFileSync(dst, "utf8"), "PAYLOAD");

	const deny = path.join(dir, "deny");
	fs.mkdirSync(deny);
	const locked = path.join(deny, "locked.bin");
	fs.writeFileSync(locked, "KEEP");
	const restore = makeWriteFail(deny, locked);
	try {
		await assert.rejects(() => core.atomicCopyFile(src, locked), /EPERM|EACCES|EBUSY/);
	} finally {
		restore();
	}
	assert.equal(fs.readFileSync(locked, "utf8"), "KEEP", "失败时目标原样");
	assert.deepEqual(tempLeftovers(deny), [], "不该残留 .copytmp");
});

test("atomic-files: 退避助手是同一份实现，core 借的是它（不复制第二份）", async () => {
	const source = fs.readFileSync(path.join(repo, "lib", "core.js"), "utf8");
	assert.match(source, /import \{ renameSyncWithRetry, renameWithRetry \} from "\.\/atomic-files\.js"/);
	assert.equal(
		/\bfs\.renameSync\(tmp, fp\)/.test(source),
		false,
		"core.js 里不该再有无退避的 renameSync",
	);
});
