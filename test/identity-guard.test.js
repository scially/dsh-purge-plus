import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { installAssembleGuard, clearAssembleGuard } = await import(pathToFileURL(path.join(repo, "lib/identity.js")).href);

function freshPrompt() {
	const p = { sections: [] };
	Object.defineProperty(p, "assemble", { value: async () => ({ sections: [] }), writable: true, configurable: true, enumerable: true });
	return p;
}

test("identity: 同一 (slot, rewriteFn) 复用同一个 disposer（Cordis 每次给新 Proxy 也不增长）", () => {
	const prompt = freshPrompt();
	const rewriteA = () => {};
	const rewriteB = () => {};
	const d1 = installAssembleGuard(prompt, rewriteA);
	assert.equal(typeof d1, "function");
	assert.equal(installAssembleGuard(prompt, rewriteA), d1);
	// 模拟 cordis 每次读 assemble 都换一个 Proxy 对象
	assert.equal(installAssembleGuard(new Proxy(prompt, {}), rewriteA), d1);
	assert.equal(installAssembleGuard(new Proxy(prompt, {}), rewriteA), d1);
	// 不同 rewriteFn 必须是不同的 disposer（否则两套 rewrite 互相顶掉）
	assert.notEqual(installAssembleGuard(prompt, rewriteB), d1);
	// 换回来仍然是原来那个（缓存按 rewriteFn 记账）
	assert.equal(installAssembleGuard(prompt, rewriteA), d1);
});

test("identity: dispose 仍是 noop，停用要走 clearAssembleGuard", () => {
	const prompt = freshPrompt();
	const rewrite = () => {};
	const d = installAssembleGuard(prompt, rewrite);
	d();
	// noop：槽位还挂着，下一轮 assemble 仍会走我们的改写
	const again = installAssembleGuard(prompt, rewrite);
	assert.equal(again, d, "dispose 不能把 slot.rewrite 清掉");
	assert.equal(clearAssembleGuard(prompt), true);
	assert.equal(clearAssembleGuard(prompt), true, "clear 可重复调用");
});

test("identity: 重复安装不会把代理一层层套进去（同一 prompt 只包一次）", () => {
	const prompt = freshPrompt();
	const rewrite = () => {};
	for (let i = 0; i < 50; i += 1) installAssembleGuard(new Proxy(prompt, {}), rewrite);
	const desc = Object.getOwnPropertyDescriptor(prompt, "assemble");
	const current = desc.get();
	assert.equal(typeof current, "function");
	assert.equal(current._dshPurgeWrapped, true);
});
