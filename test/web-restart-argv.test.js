// restartArgv：卸载/回收重启时重建命令行。不能把「已经是完整启动命令」的写法再包一层
// `web --port`，否则会丢掉 `--profile` / 裸 profile 名 / headless 这类形态。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { restartArgv } = await import(pathToFileURL(path.join(repo, "lib/web.js")).href);

function fakeRoot(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-argv-"));
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(dir, "lib", "bin.js"), "// fixture\n");
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return () => dir;
}

test("restartArgv: 已带 web 子命令时原样保留", (t) => {
	const argv = ["node", "bin.js", "web", "--port", "3999"];
	const out = restartArgv({ argv, findBinRoot: fakeRoot(t) });
	assert.ok(out[0].endsWith(path.join("lib", "bin.js")));
	assert.deepEqual(out.slice(1), ["web", "--port", "3999", "--no-open"]);
});

test("restartArgv: --profile 形态不再被塞 web --port", (t) => {
	const root = fakeRoot(t);
	for (const argv of [
		["node", "bin.js", "--profile", "custom"],
		["node", "bin.js", "--profile=custom"],
	]) {
		const out = restartArgv({ argv, findBinRoot: root });
		assert.deepEqual(out.slice(1), [...argv.slice(2), "--no-open"], `不该改写：${argv.join(" ")}`);
	}
});

test("restartArgv: 裸 profile 名 / 其它子命令不再被塞 web --port", (t) => {
	const root = fakeRoot(t);
	for (const argv of [
		["node", "bin.js", "custom-profile"],
		["node", "bin.js", "headless"],
		["node", "bin.js", "tui"],
	]) {
		const out = restartArgv({ argv, findBinRoot: root });
		assert.deepEqual(out.slice(1), [...argv.slice(2), "--no-open"], `不该改写：${argv.join(" ")}`);
	}
});

test("restartArgv: 光秃秃的启动才补 web --port（含 PORT 透传）", (t) => {
	const root = fakeRoot(t);
	const out = restartArgv({ argv: ["node", "bin.js"], findBinRoot: root });
	assert.equal(out[1], "web");
	assert.equal(out[2], "--port");
	assert.ok(Number(out[3]) > 0);
	assert.equal(out.at(-1), "--no-open");
});

test("restartArgv: --no-open 不会被重复追加", (t) => {
	const out = restartArgv({ argv: ["node", "bin.js", "web", "--no-open"], findBinRoot: fakeRoot(t) });
	assert.equal(out.filter((a) => a === "--no-open").length, 1);
});
