// 状态口径顺序：forbid（官方原句已回来）必须比 markers 先判。
//
// 背景（audit A 线 F-01）：#60 同时有 markers 与 forbid，而 `filePatchOutcome` 先看 markers，
// 于是「半回滚态」（官方原句回来 + 旧 marker 还在）会显示 applied，apply 路径却还要改 ——
// 两条路径对同一个文件给出相反结论，真漂移被显示成绿色。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { ALL_PATCHES, filePatchOutcome } = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

const SYNTHETIC = {
	id: 9001,
	name: "SYNTHETIC_FORBID",
	file: ["x.js"],
	forbid: ["Wider sandbox mode for this complete program execution; requires justification and approval."],
	markers: ["[dsh-purge] synthetic marker"],
	markersAny: true,
	replacements: [{
		pattern: "Wider sandbox mode for this complete program execution; requires justification and approval.",
		replace: "[dsh-purge] synthetic marker",
	}],
};

test("filePatchOutcome: forbid 命中时不再看 markers（半回滚态不能显示 applied）", () => {
	const half = "Wider sandbox mode for this complete program execution; requires justification and approval.\n[dsh-purge] synthetic marker\n";
	assert.notEqual(filePatchOutcome(half, SYNTHETIC, "x.js"), "applied", "官方原句回来了就不能算 applied");
	assert.equal(filePatchOutcome(half, SYNTHETIC, "x.js"), "pending", "还有活要干");

	const clean = "Wider sandbox mode for this complete program execution; requires justification and approval.\n";
	assert.equal(filePatchOutcome(clean, SYNTHETIC, "x.js"), "pending");

	const done = "普通一行\n[dsh-purge] synthetic marker\n";
	assert.equal(filePatchOutcome(done, SYNTHETIC, "x.js"), "applied");
});

test("filePatchOutcome: 真实补丁里带 forbid 的都不会被 markers 抢答", () => {
	const withForbid = ALL_PATCHES.filter((p) => Array.isArray(p.forbid) && p.forbid.length > 0);
	assert.ok(withForbid.length > 0, "应有带 forbid 的补丁");
	for (const patch of withForbid) {
		const forbidText = String(patch.forbid[0]);
		const ourMarker = Array.isArray(patch.markers) && patch.markers.length ? String(patch.markers[0]) : "";
		if (!ourMarker) continue;
		const half = `${forbidText}\n${ourMarker}\n`;
		assert.notEqual(
			filePatchOutcome(half, patch, "x.js"),
			"applied",
			`#${patch.id} 的 forbid 回来了却被 markers 判成 applied`,
		);
	}
});
