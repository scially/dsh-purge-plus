// fileOptional 契约：已知会整体搬走的目标副本算中性，真正负责该行为的副本仍按漂移口径报。
//
// 背景：0.2.2 把审批逻辑从 dsh-tools/index.js 搬到了 pipeline.js。出厂 marker 认不出变体写入的
// 内容，旧口径会在 apply 成功后把整条补丁判成 drifted（4 条假告警）；而粗暴地给整条补丁
// 开 softSettle 会把「上游真把这段删了」也一起藏掉。fileOptional 只声明「哪些副本允许空」。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { ALL_PATCHES, patchStatus } = await import(pathToFileURL(path.join(repo, "lib/core.js")).href);

const P62 = ALL_PATCHES.find((p) => String(p.id) === "62");
const LIVE_DOUBLE = 'const approval = this.ctx.get("approval");';
const LIVE_SINGLE = "const approval = this.ctx.get('approval');";
const LIVE_PATCHED_DOUBLE = `${LIVE_DOUBLE} if (true) return { decision: { kind: "allow" }, approvalCancelled: false }; // [dsh-purge] no approval service → allow`;
const LIVE_PATCHED_SINGLE = `${LIVE_SINGLE} if (true) return { decision: { kind: 'allow' }, approvalCancelled: false }; // [dsh-purge] no approval service → allow`;

/** 造一棵最小的宿主树（aiBase = …/node_modules/@deepseek-ai）。 */
function fixture(live) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-fileopt-"));
	const ai = path.join(root, "node_modules", "@deepseek-ai");
	const put = (rel, text) => {
		const fp = path.join(ai, rel);
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.writeFileSync(fp, text);
	};
	put("dsh-agent-instructions/lib/index.js", "// fixture\n");
	put("dsh/package.json", JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.5" }));
	// 陈旧的副本：0.2.2 上这里已经没有审批逻辑
	put("dsh-tools/lib/index.js", "// approval logic moved elsewhere\n");
	put("dsh-tools/lib/types/index.js", "// approval logic moved elsewhere\n");
	// 真正负责该行为的副本
	put("dsh-tools/lib/pipeline.js", live.double);
	put("dsh-tools/lib/types/pipeline.js", live.single);
	return { ai, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("fileOptional: 陈旧副本不让补丁翻红，但真漂移照样报 drifted", async () => {
	// 1) 干净树：live 副本待应用
	const clean = fixture({ double: LIVE_DOUBLE, single: LIVE_SINGLE });
	try {
		const st = await patchStatus(clean.ai, [P62]);
		assert.equal(st["62"], "pending", "干净树上应是待应用");
	} finally {
		clean.close();
	}

	// 2) 打完的状态：live 副本带 marker，陈旧副本一无所有
	const patched = fixture({ double: LIVE_PATCHED_DOUBLE, single: LIVE_PATCHED_SINGLE });
	try {
		const st = await patchStatus(patched.ai, [P62]);
		assert.equal(st["62"], "applied", "陈旧副本不该把整条补丁判成漂移");
	} finally {
		patched.close();
	}

	// 3) 上游把 live 副本整段改写（锚点消失）：必须报 drifted
	const drifted = fixture({
		double: 'const approval = this.ctx.get("approval-renamed");',
		single: "const approval = this.ctx.get('approval-renamed');",
	});
	try {
		const st = await patchStatus(drifted.ai, [P62]);
		assert.equal(st["62"], "drifted", "fileOptional 不能把真漂移藏掉");
	} finally {
		drifted.close();
	}
});

test("fileOptional: 只声明在确实搬过家的补丁上，且不开 softSettle", () => {
	assert.deepEqual(P62.fileOptional, ["dsh-tools", "dsh-tools-types"]);
	assert.equal(P62.softSettle, undefined, "整条补丁软settle 会把真漂移一起藏掉，不要再开");
	for (const id of ["54", "60"]) {
		const p = ALL_PATCHES.find((x) => String(x.id) === id);
		assert.ok(Array.isArray(p.fileOptional) && p.fileOptional.length > 0, `#${id} 应声明 fileOptional`);
		assert.equal(p.softSettle, undefined, `#${id} 不该再开 softSettle`);
	}
	// 真正该保留漂移口径的补丁没有 fileOptional
	for (const id of ["17", "40"]) {
		const p = ALL_PATCHES.find((x) => String(x.id) === id);
		assert.equal(p.fileOptional, undefined, `#${id} 不应声明 fileOptional`);
	}
});
