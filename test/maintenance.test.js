import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(repo, rel)).href);
const anchors = await load("lib/anchors.js");
const presetPolicy = await load("lib/preset-policy.js");
const probe = await load("lib/probe.js");
const snapshot = await load("lib/snapshot.js");
const { renderDiagnosis } = await load("lib/diagnose.js");

function tmpHome(tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-${tag}-`));
	return dir;
}

/* ------------------------------------------------------------------ anchors */

test("anchors: 写入/读取/清除覆盖，apply 只改指定下标", () => {
	const home = tmpHome("anchor");
	anchors.resetOverrideCache();
	const patch = { id: 7, replacements: [{ pattern: "a", replace: "A" }, { pattern: "b", replace: "B" }] };
	assert.equal(anchors.applyOverrides(patch, {}), patch);

	anchors.writeOverride(home, 7, 1, "b2", { host: "x" });
	const all = anchors.readOverrides(home);
	assert.equal(all["7"]["1"].pattern, "b2");
	assert.equal(all["7"]["1"].host, "x");

	const merged = anchors.applyOverrides(patch, all);
	assert.equal(merged.replacements[0].pattern, "a");
	assert.equal(merged.replacements[1].pattern, "b2");
	assert.equal(merged.overridden, true);
	assert.equal(patch.replacements[1].pattern, "b");
	assert.ok(fs.statSync(anchors.overridesPath(home)).isFile());

	assert.deepEqual(anchors.overrideSummary(home), { total: 1, patches: 1, ids: ["7"] });
	anchors.clearOverride(home, 7);
	assert.deepEqual(anchors.readOverrides(home), {});
	fs.rmSync(home, { recursive: true, force: true });
});

test("anchors: overridesFor 按 mtime 失效缓存", async () => {
	const home = tmpHome("anchor-cache");
	anchors.resetOverrideCache();
	assert.deepEqual(anchors.overridesFor(home), {});
	anchors.writeOverride(home, 3, 0, "zzz");
	assert.equal(anchors.overridesFor(home)["3"][0].pattern, "zzz");
	fs.rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------------ preset policy */

test("preset-policy: 配置 + 文件合并、去重、小写", () => {
	const home = tmpHome("preset");
	presetPolicy.writeExcludeFile(home, ["RolePlay", " minimal ", ""]);
	assert.deepEqual(presetPolicy.readExcludeFile(home), ["RolePlay", "minimal"]);
	const ids = presetPolicy.excludedPresetIds({ excludePresets: ["roleplay"] }, home);
	assert.deepEqual(ids.sort(), ["minimal", "roleplay"]);
	fs.rmSync(home, { recursive: true, force: true });
});

test("preset-policy: 没配排除时永远 allow；配了但 preset 未知则保守不注入", () => {
	const home = tmpHome("preset-policy");
	const ctxKnown = { agent: { session: { header: { agentPreset: "roleplay" } } } };
	const ctxUnknown = { agent: { session: { header: {} } } };

	assert.equal(presetPolicy.injectionPolicy({}, ctxKnown, home).allowed, true);
	assert.equal(presetPolicy.injectionPolicy({ enabled: false }, ctxKnown, home).allowed, false);

	presetPolicy.writeExcludeFile(home, ["roleplay"]);
	const excluded = presetPolicy.injectionPolicy({}, ctxKnown, home);
	assert.equal(excluded.allowed, false);
	assert.equal(excluded.reason, "excluded");

	const unknown = presetPolicy.injectionPolicy({}, ctxUnknown, home);
	assert.equal(unknown.allowed, false);
	assert.equal(unknown.reason, "unknown-preset");

	const other = presetPolicy.injectionPolicy({}, { agent: { session: { header: { agentPreset: "standard" } } } }, home);
	assert.equal(other.allowed, true);
	fs.rmSync(home, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- probe */

test("probe: 生成/读取/正文，TTL 过期后视为没有", () => {
	const home = tmpHome("probe");
	const created = probe.createProbe(home);
	assert.match(created.nonce, /^purge-[0-9a-f]{8}$/);
	const read = probe.readProbe(home);
	assert.equal(read.nonce, created.nonce);
	const text = probe.probeText(home);
	assert.ok(text.includes(created.nonce));
	assert.ok(text.includes("<dsh_probe>"));

	fs.writeFileSync(probe.probePath(home), JSON.stringify({ nonce: "purge-deadbeef", at: Date.now() - probe.PROBE_TTL_MS - 1000 }));
	assert.equal(probe.readProbe(home), null);
	assert.equal(probe.probeText(home), "");
	fs.rmSync(home, { recursive: true, force: true });
});

test("probe: checkProbe 在会话日志里找到 nonce（支持 zstd 与明文）", () => {
	const home = tmpHome("probe-check");
	const created = probe.createProbe(home);
	const dir = path.join(home, "sessions", "--ws--", "session-abc");
	fs.mkdirSync(dir, { recursive: true });
	const sessionFile = path.join(dir, "session.v4.jsonl");
	fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "message", text: `echo [${created.nonce}]` })}\n`);

	const hit = probe.checkProbe(home);
	assert.equal(hit.error, undefined);
	assert.equal(hit.hits.length, 1);
	assert.ok(hit.hits[0].file.endsWith("session.v4.jsonl"));
	assert.ok(hit.hits[0].snippet.includes(created.nonce));

	probe.clearProbe(home);
	assert.equal(probe.checkProbe(home).error.length > 0, true);
	fs.rmSync(home, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- snapshot */

test("snapshot: 建快照 → 改文件 → 回滚，内容与 sha 校验通过", () => {
	const home = tmpHome("snap-home");
	const aiBase = tmpHome("snap-host");
	const file = path.join(aiBase, "pkg", "lib", "index.js");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "original\n");

	const made = snapshot.createSnapshot(aiBase, { dshHome: home, paths: [file], label: "t" });
	assert.equal(made.ok, true);
	assert.equal(made.files, 1);

	fs.writeFileSync(file, "patched\n");
	const list = snapshot.listSnapshots(home);
	assert.equal(list.length, 1);

	const restored = snapshot.restoreSnapshot(aiBase, list[0].id, { dshHome: home });
	assert.equal(restored.ok, true);
	assert.equal(restored.restored, 1);
	assert.equal(fs.readFileSync(file, "utf8"), "original\n");
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(aiBase, { recursive: true, force: true });
});

test("maintenance.snapshots: 不带 prune 只列表，绝不清理", async () => {
	const { snapshots } = await load("lib/maintenance.js");
	const home = tmpHome("snap-list");
	const aiBase = tmpHome("snap-list-host");
	const file = path.join(aiBase, "a.js");
	fs.writeFileSync(file, "x");
	snapshot.createSnapshot(aiBase, { dshHome: home, paths: [file], id: "s1" });
	snapshot.createSnapshot(aiBase, { dshHome: home, paths: [file], id: "s2" });

	const listed = snapshots({ dshHome: home });
	assert.equal(listed.ok, true);
	assert.ok(listed.text.includes("s1") && listed.text.includes("s2"));
	assert.equal(snapshot.listSnapshots(home).length, 2);

	const pruned = snapshots({ dshHome: home, prune: 1 });
	assert.match(pruned.text, /已清理/);
	assert.equal(snapshot.listSnapshots(home).length, 1);
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(aiBase, { recursive: true, force: true });
});

test("snapshot: 保留策略只留最新 N 份", () => {	const home = tmpHome("snap-prune");
	const aiBase = tmpHome("snap-prune-host");
	const file = path.join(aiBase, "a.js");
	fs.writeFileSync(file, "x");
	for (let i = 0; i < 3; i += 1) {
		snapshot.createSnapshot(aiBase, { dshHome: home, paths: [file], id: `s${i}` });
	}
	assert.equal(snapshot.listSnapshots(home).length, 3);
	const removed = snapshot.pruneSnapshots(home, 1);
	assert.equal(removed.length, 2);
	assert.equal(snapshot.listSnapshots(home).length, 1);
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(aiBase, { recursive: true, force: true });
});

/* ----------------------------------------------------------------- diagnose */

test("diagnose: 文本报告列出失配补丁与候选", () => {
	const text = renderDiagnosis({
		host: "@deepseek-ai/dsh@0.2.2-rc.1",
		compat: { known: true, ok: false },
		declared: ["0.2.1-rc.5"],
		tally: { drifted: 1, applied: 85 },
		total: 86,
		overridden: 0,
		drifted: [{ id: "40", name: "COMPLETE_PROMPT_KEEP_INJECT", files: [], misses: [{ index: 0, kind: "regex", pattern: "/x/", candidates: [{ file: "a.js", line: 3, text: "x" }] }] }],
	}, { detail: true });
	assert.ok(text.includes("MISMATCH"));
	assert.ok(text.includes("#40"));
	assert.ok(text.includes("a.js:3"));
});

/* --------------------------------------------------------------- exec-proof */

test("exec-proof: 正确哈希 PASS，回显 nonce FAIL", () => {
	const script = path.join(repo, "scripts", "exec-proof.mjs");
	const gen = spawnSync(process.execPath, [script, "new"], { encoding: "utf8" });
	assert.equal(gen.status, 0);
	const nonce = gen.stdout.match(/nonce: ([0-9a-f]{32})/)[1];
	const expected = gen.stdout.match(/期望输出（SHA256\(nonce\)）: ([0-9a-f]{64})/)[1];

	const ok = spawnSync(process.execPath, [script, "check", nonce], { input: `${expected}\n`, encoding: "utf8" });
	assert.equal(ok.status, 0);
	assert.match(ok.stdout, /PASS/);

	const echo = spawnSync(process.execPath, [script, "check", nonce], { input: nonce, encoding: "utf8" });
	assert.equal(echo.status, 1);
	assert.match(echo.stderr, /回显/);
});
