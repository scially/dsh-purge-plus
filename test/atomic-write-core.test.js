// core.js 的四个原子写/拷：目标被占用时必须退避重试，失败时不能留临时文件、不能动目标字节。
//
// 为什么单独钉这条：core.js 的原子写走 `hostFs`（app.asar 还在时要写进真实 resources/app），
// 不能像 lib/atomic-files.js 那样换成 node:fs，所以它借用的是同一份「吃 fs 面」的退避助手
// （renameSyncWithRetry / renameWithRetry）。这几条用例同时守住：退避确实生效、权限位保留、
// 失败路径干净。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const core = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

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

test("core.atomicWriteSync: 目标被读句柄占用时退避重试并写成功", (t) => {
	const dir = tmpDir(t, "sync-busy");
	const fp = path.join(dir, "state.json");
	fs.writeFileSync(fp, "旧内容");
	fs.chmodSync(fp, 0o755);
	holdWithChild(t, fp, 150);

	core.atomicWriteSync(fp, "新内容");
	assert.equal(fs.readFileSync(fp, "utf8"), "新内容", "退避后应当写入成功");
	// Windows 的可执行位不可表达（chmod 只切只读位），照既有测试的口径分开断言。
	const mode = fs.statSync(fp).mode & 0o777;
	if (process.platform === "win32") assert.equal(mode & 0o200, 0o200, "Windows 上不能被写成只读");
	else assert.equal(mode, 0o755, "POSIX 上原权限位必须保留（#155/#157）");
	assert.deepEqual(tempLeftovers(dir), [], "不该残留临时文件");
});

test("core.atomicWriteSync: 句柄一直不放 → 抛错、目标字节不变、无临时文件", (t) => {
	const dir = tmpDir(t, "sync-fail");
	const fp = path.join(dir, "state.json");
	fs.writeFileSync(fp, "原始内容");
	const handle = fs.openSync(fp, "r");
	t.after(() => { try { fs.closeSync(handle); } catch { /* ignore */ } });

	assert.throws(() => core.atomicWriteSync(fp, "不该落盘的内容"), /EPERM|EACCES|EBUSY/);
	assert.equal(fs.readFileSync(fp, "utf8"), "原始内容", "失败时目标必须原样");
	assert.deepEqual(tempLeftovers(dir), [], "失败路径必须清掉临时文件");
});

test("core.atomicWriteFile: 目标被读句柄占用时退避重试并写成功，失败时干净退出", async (t) => {
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
	const lock = fs.openSync(fp2, "r");
	t.after(() => { try { fs.closeSync(lock); } catch { /* ignore */ } });
	await assert.rejects(() => core.atomicWriteFile(fp2, "不许落盘"), /EPERM|EACCES|EBUSY/);
	assert.equal(fs.readFileSync(fp2, "utf8"), "原样");
	assert.deepEqual(tempLeftovers(dir), []);
});

test("core.atomicCopyFile(Sync): 拷贝也带退避，失败不留 .copytmp", async (t) => {
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

	const locked = path.join(dir, "locked.bin");
	fs.writeFileSync(locked, "KEEP");
	const handle = fs.openSync(locked, "r");
	t.after(() => { try { fs.closeSync(handle); } catch { /* ignore */ } });
	await assert.rejects(() => core.atomicCopyFile(src, locked), /EPERM|EACCES|EBUSY/);
	assert.equal(fs.readFileSync(locked, "utf8"), "KEEP", "失败时目标原样");
	assert.deepEqual(tempLeftovers(dir), [], "不该残留 .copytmp");
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
