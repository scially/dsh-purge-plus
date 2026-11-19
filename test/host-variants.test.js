import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);

const core = await load("lib/core.js");
const { HOST_VARIANTS, HOST_VARIANT_FILES, HOST_VARIANT_FLAGS, HOST_VARIANTS_SKIP } = await load("lib/host-variants.js");

const byId = new Map(core.ALL_PATCHES.map((p) => [String(p.id), p]));

test("host-variants: 每条变体都并进了对应补丁的 replacements", () => {
	for (const [id, variants] of Object.entries(HOST_VARIANTS)) {
		const patch = byId.get(id);
		assert.ok(patch, `补丁 #${id} 不存在`);
		assert.ok(Array.isArray(patch.replacements), `#${id} 应该有 replacements`);
		const sources = patch.replacements.map((r) => String(r.pattern instanceof RegExp ? r.pattern : r.pattern));
		for (const v of variants) {
			const needle = String(v.pattern instanceof RegExp ? v.pattern : v.pattern);
			assert.ok(
				sources.some((s) => s === needle),
				`#${id} 没有并进变体 ${needle.slice(0, 60)}…`,
			);
		}
	}
});

test("host-variants: 搬家的文件键并进了补丁的 file 列表", () => {
	for (const [id, keys] of Object.entries(HOST_VARIANT_FILES)) {
		const patch = byId.get(id);
		assert.ok(patch, `补丁 #${id} 不存在`);
		const list = Array.isArray(patch.file) ? patch.file : [patch.file];
		for (const key of keys) assert.ok(list.includes(key), `#${id} 缺少文件键 ${key}`);
	}
});

test("host-variants: 状态口径补丁并进了 markers / 标志位", () => {
	for (const [id, flags] of Object.entries(HOST_VARIANT_FLAGS)) {
		const patch = byId.get(String(id));
		assert.ok(patch, `补丁 #${id} 不存在`);
		for (const m of flags.addMarkers ?? []) {
			assert.ok((patch.markers ?? []).includes(m), `#${id} 没并进 marker ${m}`);
		}
		if (flags.markersAny === true) assert.equal(patch.markersAny, true, `#${id} markersAny 没生效`);
		if (flags.softSettle === true) assert.equal(patch.softSettle, true, `#${id} softSettle 没生效`);
	}
	// 0.2.2 上 apply 成功后不再假报漂移的四条
	assert.deepEqual(Object.keys(HOST_VARIANT_FLAGS).map(Number).sort((a, b) => a - b), [17, 40, 54, 60, 62]);
});

test("host-variants: 出厂 pattern 没被覆盖（只追加）", () => {
	// #54 出厂 pattern 仍包含「句尾带空格」的老形式；新增的是句首空格形式。
	const patch = byId.get("54");
	const all = patch.replacements.map((r) => String(r.pattern));
	assert.ok(all.some((p) => p.endsWith("will appear. ")), "老的 #54 pattern 丢了");
	assert.ok(all.some((p) => p.startsWith(" Do not call present")), "新的 #54 pattern 没进来");
});

test("host-variants: #77 的压缩变体存在，且插入型变体带 insertProbe", () => {
	// 0.2.2-rc.2 起会话客户端压成一行，出厂缩进式 pattern 一条都不中。
	const patch = byId.get("77");
	const minified = patch.replacements.find((r) => typeof r.pattern === "string" && r.pattern.startsWith("append(record){const event=record.event;"));
	assert.ok(minified, "#77 缺压缩变体");
	assert.ok(
		minified.replace.includes("isRewindMarker"),
		"#77 压缩变体必须用 typeof 守卫调用 #56 注入的 isRewindMarker",
	);
	// 插入型变体（replace 自带 pattern）必须用 insertProbe 收住，否则每次 apply 都再插一遍。
	for (const rep of patch.replacements ?? []) {
		if (typeof rep.pattern !== "string" || typeof rep.replace !== "string") continue;
		if (!rep.replace.includes(rep.pattern)) continue;
		assert.ok(rep.insertProbe, `自匹配 replacement 缺 insertProbe：${rep.pattern.slice(0, 50)}`);
	}
	const p62 = byId.get("62");
	for (const rep of p62.replacements ?? []) {
		if (typeof rep.pattern !== "string" || typeof rep.replace !== "string") continue;
		if (!rep.replace.includes(rep.pattern)) continue;
		assert.ok(rep.insertProbe, `#62 自匹配 replacement 缺 insertProbe：${rep.pattern.slice(0, 50)}`);
	}
});

test("host-variants: 0.2.2 上不再需要 skip 名单", () => {
	assert.deepEqual(HOST_VARIANTS_SKIP, {}, "#77 补上压缩变体后 skip 名单应为空");
});

test("package.json 声明的宿主版本包含实测过的 0.2.2 版本", async () => {
	const pkg = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(repo, "package.json"), "utf8"));
	assert.ok(pkg.dshTargets.includes("0.2.2-rc.1"));
	assert.ok(pkg.dshTargets.includes("0.2.2-rc.3"));
	assert.ok(pkg.dshTargets.includes("0.2.2-rc.4"));
	assert.ok(pkg.dshTargets.includes("0.2.2-rc.5"));
	assert.ok(!pkg.dshTargets.includes("0.2.2-rc.2"), "rc.2 没单独实测，不要声明");
});
