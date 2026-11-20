// 三件从社区版移植过来的补丁（#97 ask_user 等待上限 / #98 cookie 名忽略端口 / #99 host 请求头上限）
// 的契约：锚点、marker、可选性、幂等。ID 与社区不同（他们 #89/#91/#92），按 name 对齐。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { ALL_PATCHES, applyReplacementsToText } = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

const byName = (name) => ALL_PATCHES.find((p) => p.name === name);

test("移植补丁：三条都在，且名字/文件键/marker 与社区对齐", () => {
	const ask = byName("ASK_USER_WAIT_CAPPED");
	assert.ok(ask, "#97 ASK_USER_WAIT_CAPPED 缺失");
	assert.deepEqual(ask.file, ["tool-ask-user"]);
	assert.equal(ask.optional, true);
	assert.deepEqual(ask.markers, ["[dsh-purge] -1 capped at 300s"]);
	assert.deepEqual(ask.forbid, ["[dsh-purge] ask_user_question never blocks a turn"]);
	assert.equal(ask.replacements.length, 2, "原生 + 旧版迁移两条");

	const cookie = byName("BROWSER_COOKIE_NAME_IGNORE_PORT");
	assert.ok(cookie, "#98 BROWSER_COOKIE_NAME_IGNORE_PORT 缺失");
	assert.deepEqual(cookie.file, ["client-connection"]);
	assert.deepEqual(cookie.surfaces, ["desktop"]);
	assert.deepEqual(cookie.markers, ["[dsh-purge] cookie-name-ignore-port"]);

	const header = byName("HOST_MAX_HTTP_HEADER_SIZE");
	assert.ok(header, "#99 HOST_MAX_HTTP_HEADER_SIZE 缺失");
	assert.deepEqual(header.file, ["desktop-shell"]);
	assert.deepEqual(header.surfaces, ["desktop"]);
	assert.equal(header.optional, true);
	assert.deepEqual(header.markers, ["[dsh-purge] raise-host-header-limit"]);
});

test("移植补丁 #97：只把 -1 收成 300，其它等待时间不动、重复应用无变化、旧版标记能迁移", () => {
	const ask = byName("ASK_USER_WAIT_CAPPED");
	const native = "\t\t\tconst timeout = validateTimeout(args.timeout ?? defaultTimeout);\n";
	const first = applyReplacementsToText(native, ask, "dsh-tool-ask-user/lib/index.js");
	assert.equal(first.changed, true);
	assert.match(first.text, /args\.timeout === -1 \? 300 : \(args\.timeout \?\? defaultTimeout\)/);
	// 幂等：改完的文本再跑一遍不应该再变
	const second = applyReplacementsToText(first.text, ask, "dsh-tool-ask-user/lib/index.js");
	assert.equal(second.changed, false, "#97 第二次应用还在改内容");
	// 旧版形态（硬写 1 秒）能被迁移条替换掉
	const legacy = "\t\t\tconst timeout = 1; // [dsh-purge] ask_user_question never blocks a turn\n";
	const migrated = applyReplacementsToText(legacy, ask, "dsh-tool-ask-user/lib/index.js");
	assert.equal(migrated.changed, true);
	assert.match(migrated.text, /-1 capped at 300s/);
});

test("移植补丁 #98/#99：正则与字符串锚点都天然幂等", () => {
	const cookie = byName("BROWSER_COOKIE_NAME_IGNORE_PORT");
	const src = 'const name = encodeBase64Url(createHash("sha256").update(authority).digest());\n';
	const once = applyReplacementsToText(src, cookie, "dsh-client-connection/lib/index.js");
	assert.equal(once.changed, true);
	assert.ok(
		once.text.includes('.replace(/:[0-9]+$/u, "")'),
		"cookie 名应当只看主机名（丢掉端口）",
	);
	const twice = applyReplacementsToText(once.text, cookie, "dsh-client-connection/lib/index.js");
	assert.equal(twice.changed, false, "#98 第二次应用还在改内容");

	const header = byName("HOST_MAX_HTTP_HEADER_SIZE");
	const argv = 'spawn(exe, ["--expose-internals", "--experimental-vm-modules"], {});\n';
	const h1 = applyReplacementsToText(argv, header, "desktop-shell");
	assert.equal(h1.changed, true);
	assert.match(h1.text, /--max-http-header-size=262144/);
	const h2 = applyReplacementsToText(h1.text, header, "desktop-shell");
	assert.equal(h2.changed, false, "#99 第二次应用还在改内容");
	assert.equal(h2.text, h1.text);
	// 已经插过一次的旧产物也能被正则一次吃掉、不会叠加
	const h3 = applyReplacementsToText(h2.text, header, "desktop-shell");
	assert.equal(h3.text.split("--max-http-header-size").length - 1, 1, "不该出现第二份参数");
});
