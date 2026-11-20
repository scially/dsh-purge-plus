import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);

const groups = await load("lib/patch-groups.js");
const { PATCH_GROUPS, EXTRA_PATCHES } = await load("lib/extra-patches.js");
const core = await load("lib/core.js");

function tmpHome(tag) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${tag}-`));
}

test("patch-groups: 默认两组都开，关闭后其补丁被收集", () => {
	const home = tmpHome("groups");
	assert.equal(groups.groupEnabled(home, "permission"), true);
	assert.equal(groups.groupEnabled(home, "context"), true);
	assert.equal(groups.disabledGroupPatchIds(home).size, 0);

	groups.writeGroupSettings(home, { permission: false });
	const disabled = groups.disabledGroupPatchIds(home);
	assert.ok(disabled.has("6"));
	assert.ok(disabled.has("62"));
	assert.ok(!disabled.has("18"));
	assert.equal(groups.groupEnabled(home, "context"), true);
	fs.rmSync(home, { recursive: true, force: true });
});

test("patch-groups: 组归属与按组汇总", () => {
	assert.equal(groups.groupOf(6), "permission");
	assert.equal(groups.groupOf("18"), "context");
	assert.equal(groups.groupOf(40), "");
	const summary = groups.summarizeByGroup({ 6: "applied", 7: "pending", 18: "pending", 40: "drifted" });
	assert.deepEqual(summary.permission, { applied: 1, pending: 1 });
	assert.deepEqual(summary.context, { pending: 1 });
	assert.deepEqual(summary.other, { drifted: 1 });
});

test("patch-groups: 坏文件回落到默认值（不把整组误关）", () => {
	const home = tmpHome("groups-bad");
	fs.mkdirSync(path.join(home, "dsh-purge"), { recursive: true });
	fs.writeFileSync(path.join(home, "dsh-purge", "groups.json"), "{ not json");
	assert.equal(groups.groupEnabled(home, "permission"), PATCH_GROUPS.permission.defaultEnabled);
	fs.rmSync(home, { recursive: true, force: true });
});

test("extra-patches: inspector 加固两条已并入补丁表", () => {
	assert.equal(EXTRA_PATCHES.length, 2);
	// 不再钉死总数：移植/新增补丁是常态，钉死数字只会让无关改动在这里误报。
	// 真正要守的是「id 唯一」+「EXTRA_PATCHES 全都在 ALL_PATCHES 里」。
	const ids = core.ALL_PATCHES.map((p) => String(p.id));
	assert.equal(new Set(ids).size, ids.length, "补丁 id 必须唯一");
	for (const extra of EXTRA_PATCHES) {
		assert.ok(ids.includes(String(extra.id)), `#${extra.id} 不在 ALL_PATCHES 里`);
	}
	for (const id of [95, 96]) {
		const patch = core.ALL_PATCHES.find((p) => String(p.id) === String(id));
		assert.ok(patch, `#${id} 不在 ALL_PATCHES 里`);
		assert.equal(patch.optional, true);
		assert.ok(Array.isArray(patch.markers) && patch.markers.length === 2);
		assert.equal(patch.markersAny, true);
		assert.equal(patch.silentWhenMissing, true);
	}
});
