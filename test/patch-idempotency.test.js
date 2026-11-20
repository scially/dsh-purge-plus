// 插入型 replacement 的幂等契约：replace 里自带 pattern 原文时，pattern 在产物里仍然存在 ——
// 再 Apply 一次就会**再插一遍**。这类 replacement 必须有 `insertProbe`，或者所属补丁开 `skipIfMarked`。
//
// 已经踩过三次：#62（+119 B/文件/次）、#92（+514 B/次）、#93（+1633 B/次）。
// 这条测试把「以后别再踩」变成可执行的约定。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { ALL_PATCHES } = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

function replacementsOf(patch) {
	if (Array.isArray(patch.replacements)) return patch.replacements;
	return (patch.patterns ?? []).map((pattern) => ({ pattern, replace: patch.replace }));
}

test("patch 幂等：自匹配的插入型 replacement 必须有 insertProbe 或补丁级 skipIfMarked", () => {
	const offenders = [];
	for (const patch of ALL_PATCHES) {
		for (const [index, rep] of replacementsOf(patch).entries()) {
			if (typeof rep.pattern !== "string" || typeof rep.replace !== "string") continue;
			if (rep.replace === rep.pattern) continue; // 空操作条目（替换原文与 pattern 完全相同）：改了等于没改
			if (!rep.replace.includes(rep.pattern)) continue; // 一次性消费型：pattern 会被吃掉，天然幂等
			if (rep.insertProbe) continue;
			if (patch.skipIfMarked) continue;
			offenders.push(`#${patch.id} ${patch.name} rep[${index}]`);
		}
	}
	assert.deepEqual(offenders, [], `这些插入型 replacement 再 Apply 会重复插入：\n${offenders.join("\n")}`);
});

test("patch 幂等：真实重复应用不改变字节（用补丁自己的替换表在内存里跑两遍）", async () => {
	const { applyReplacementsToText } = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);
	// 造一个同时含 #62 与 #92 锚点的假文件（两者都是自匹配插入型）
	const fake = [
		"\t\t\tchild.once(\"close\", (code, signal) => {",
		"\t\t\t\tconst suffix = this.stderr.trim() === \"\" ? \"\" : `: ${this.stderr.trim()}`;",
		"\t\t\t});",
		"const approval = this.ctx.get(\"approval\");",
		"",
	].join("\n");
	for (const id of [62, 92]) {
		const patch = ALL_PATCHES.find((p) => String(p.id) === String(id));
		if (!patch) continue;
		const once = applyReplacementsToText(fake, patch, "x.js");
		if (!once.changed) continue; // 该锚点形态不在此（例如引号风格不同）
		const twice = applyReplacementsToText(once.text, patch, "x.js");
		assert.equal(twice.changed, false, `#${id} 第二次应用还在改内容（会越长越大）`);
		assert.equal(twice.text, once.text, `#${id} 第二次应用改变了字节`);
	}
});
