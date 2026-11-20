#!/usr/bin/env node
/**
 * 真宿主锚点巡检：装一份声明的 DSH 版本，用插件自己的补丁表去「对位」。
 *
 *   node scripts/ci-host-anchor.mjs --versions 0.2.2-rc.5,0.2.1-rc.5
 *   node scripts/ci-host-anchor.mjs --dir <...>/node_modules/@deepseek-ai   # 用现成宿主树，不装
 *   node scripts/ci-host-anchor.mjs --version 0.2.2-rc.5 --apply            # 再跑一轮 apply→复检→再 apply
 *   node scripts/ci-host-anchor.mjs --versions auto --report out.json --summary out.md
 *
 * 默认只读：只算 patchStatus / diagnose，不写宿主。`--apply` 会往宿主树写盘
 * （临时装出来的那份可以随便写；配 `--dir` 用时自己确认目标）。
 * 基线在 .github/host-baseline.json：命中就用它判红绿，没命中只报告不阻断。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------- 参数 */

const argv = process.argv.slice(2);
const flagValue = (name) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : "";
};
const has = (name) => argv.includes(name);

const explicitDir = flagValue("--dir");
const applyCheck = has("--apply");
const keep = has("--keep");
const reportPath = flagValue("--report");
const summaryPath = flagValue("--summary");
const baselinePath = flagValue("--baseline") || path.join(root, ".github", "host-baseline.json");

function declaredTargets() {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const list = Array.isArray(pkg.dshTargets) && pkg.dshTargets.length ? pkg.dshTargets : [pkg.dshTarget];
		return list.filter(Boolean).map(String);
	} catch {
		return [];
	}
}

function wantedVersions() {
	const raw = flagValue("--versions") || flagValue("--version");
	if (explicitDir) return [flagValue("--host-name") || "local"];
	if (!raw || raw === "auto") return declaredTargets().slice(-1);
	return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const versions = wantedVersions();
if (!versions.length) {
	console.error("没有可用宿主版本：给 --versions，或让 package.json 的 dshTargets 非空");
	process.exit(2);
}
if (applyCheck && versions.length > 1) {
	console.error("--apply 只支持单个版本（写盘路径要保持可解释）：--version <v> 或 --dir <宿主树>");
	process.exit(2);
}

/* ------------------------------------------------------- 环境隔离（先于 import） */

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-anchor-"));
const dshHome = path.join(workRoot, "home");
fs.mkdirSync(dshHome, { recursive: true });
/* 只读阶段也要隔离：findDshHome() / 组开关只读这个目录，不碰开发机上的真 ~/.dsh。 */
process.env.DSH_HOME = dshHome;

const { diagnoseHost, renderDiagnosis } = await import("../lib/diagnose.js");
const core = applyCheck ? await import("../lib/core.js") : null;

/* ------------------------------------------------------------------- 工具 */

function installHost(version) {
	const prefix = path.join(workRoot, `inst-${version.replace(/[^\w.-]/g, "_")}`);
	fs.mkdirSync(prefix, { recursive: true });
	const t0 = Date.now();
	const r = spawnSync(
		process.platform === "win32" ? "npm.cmd" : "npm",
		["install", "--prefix", prefix, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", `@deepseek-ai/dsh@${version}`],
		{ encoding: "utf8", timeout: 900000, shell: process.platform === "win32" },
	);
	const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
	if (r.status !== 0) throw new Error(`装 @deepseek-ai/dsh@${version} 失败（退出码 ${r.status}）\n${out.split("\n").slice(-8).join("\n")}`);
	const aiBase = path.join(prefix, "node_modules", "@deepseek-ai");
	if (!fs.existsSync(aiBase)) throw new Error(`装完了却没找到 ${aiBase}`);
	return { aiBase, prefix, ms: Date.now() - t0 };
}

function tallyOf(status) {
	const t = {};
	for (const s of Object.values(status)) t[s] = (t[s] ?? 0) + 1;
	return t;
}

/** 基线：文件不存在 = 只报告；存在但解析不了 = 直接红（解析不了等于闸门失效，不能装看不见）。 */
function loadBaseline() {
	if (!fs.existsSync(baselinePath)) return null;
	try {
		return JSON.parse(fs.readFileSync(baselinePath, "utf8").replace(/^\uFEFF/, ""));
	} catch (err) {
		console.error(`基线文件解析失败：${baselinePath}\n${err?.message ?? err}`);
		process.exit(2);
	}
}

function judge(version, report, baseline) {
	const matched = (report.tally.pending ?? 0) + (report.tally.applied ?? 0);
	const driftedIds = report.drifted.map((d) => String(d.id));
	/* 基线键按三种写法依次找：请求的版本号 → "名字@版本" → 宿主自己报出来的版本号
	   （--dir 指已有宿主树时，靠第三种也能命中基线）。 */
	const host = String(report.host || "");
	const hostVersion = host.includes("@") ? host.slice(host.lastIndexOf("@") + 1) : "";
	const entry = baseline?.[version] ?? baseline?.[host] ?? (hostVersion ? baseline?.[hostVersion] : null) ?? null;
	if (!entry) return { matched, driftedIds, gated: false, ok: true, note: "无基线：只报告不阻断" };
	const problems = [];
	if (entry.minMatched != null && matched < entry.minMatched) problems.push(`可对位补丁 ${matched} < 基线 ${entry.minMatched}`);
	if (entry.maxDrifted != null && driftedIds.length > entry.maxDrifted) problems.push(`失配 ${driftedIds.length} > 基线 ${entry.maxDrifted}`);
	if (entry.allowedDriftedIds && driftedIds.some((id) => !entry.allowedDriftedIds.includes(id))) {
		problems.push(`出现基线外失配：${driftedIds.filter((id) => !entry.allowedDriftedIds.includes(id)).join(",")}`);
	}
	return { matched, driftedIds, gated: true, ok: problems.length === 0, note: problems.join("；") };
}

/* ------------------------------------------------------------------- 主流程 */

const results = [];
const baseline = loadBaseline();
let failed = 0;

for (const version of versions) {
	console.log(`\n=== 宿主 ${version} ===`);
	try {
		const installed = explicitDir ? { aiBase: explicitDir, prefix: "", ms: 0 } : installHost(version);
		console.log(`aiBase ${installed.aiBase}${installed.ms ? `（装好用了 ${(installed.ms / 1000).toFixed(0)}s）` : ""}`);
		/* 内部还有别的地方会 findAiBase()，钉在本次这份宿主上，别摸到开发机的真安装。 */
		if (!process.env.DSH_BASE) process.env.DSH_BASE = installed.aiBase;

		const report = await diagnoseHost(installed.aiBase, { dshHome });
		console.log(renderDiagnosis(report, { detail: false }));

		const entry = { version, aiBase: installed.aiBase, host: report.host, compat: report.compat, tally: report.tally, total: report.total };
		const verdict = judge(version, report, baseline);
		entry.matched = verdict.matched;
		entry.driftedIds = verdict.driftedIds;
		entry.gated = verdict.gated;
		entry.ok = verdict.ok;
		entry.note = verdict.note;

		if (applyCheck) {
			const ALL = core.ALL_PATCHES;
			const writes = (rep) => rep.reduce((n, r) => n + (r.applied || 0), 0);
			const first = await core.applyPatches(installed.aiBase, ALL, { dshHome });
			const firstSum = core.summarizeApplyReport(first, ALL);
			const afterFirst = tallyOf(await core.patchStatus(installed.aiBase, ALL));
			const second = await core.applyPatches(installed.aiBase, ALL, { dshHome });
			const secondSum = core.summarizeApplyReport(second, ALL);
			const after = await core.patchStatus(installed.aiBase, ALL);

			const applyProblems = [];
			if (firstSum.failed.length) applyProblems.push(`第一轮失败 ${firstSum.failed.length} 条：#${firstSum.failed.map((r) => r.patch_id).join(",#")}`);
			if ((afterFirst.pending ?? 0) > 0) applyProblems.push(`应用后仍有 ${afterFirst.pending} 条 pending`);
			if ((afterFirst.drifted ?? 0) > 0) applyProblems.push(`应用后仍有 ${afterFirst.drifted} 条 drifted`);
			if (writes(second) > 0 || secondSum.failed.length) {
				applyProblems.push(`第二轮还在写盘（${writes(second)} 处命中${secondSum.failed.length ? `，失败 ${secondSum.failed.length} 条` : ""}）`);
			}
			entry.apply = {
				writesFirst: writes(first),
				softFirst: firstSum.soft.length,
				after: afterFirst,
				writesSecond: writes(second),
				final: tallyOf(after),
			};
			entry.apply.ok = applyProblems.length === 0;
			entry.apply.note = applyProblems.join("；");
			console.log(
				`apply: 第一轮写 ${writes(first)} 处，之后 ${JSON.stringify(afterFirst)}；第二轮写 ${writes(second)} 处 → ${entry.apply.ok ? "ok" : "FAIL " + entry.apply.note}`,
			);
			if (!entry.apply.ok) entry.ok = false;
		}

		if (!entry.ok || (entry.apply && !entry.apply.ok)) failed += 1;
		results.push(entry);
		console.log(`判定: ${entry.ok ? "ok" : "FAIL"}${entry.note ? `（${entry.note}）` : ""}`);
	} catch (err) {
		results.push({ version, aiBase: explicitDir || "", ok: false, note: `巡检失败: ${err?.message ?? err}` });
		failed += 1;
		console.log(`FAIL ${err?.message ?? err}`);
	}
}

/* ------------------------------------------------------------------ 输出 */

const md = [];
md.push("## 真宿主锚点巡检");
md.push("");
md.push(`- 巡检版本：${versions.join(" / ")}`);
md.push(`- 声明适配：${declaredTargets().join(" / ") || "(空)"}`);
md.push(`- 基线：\`${path.relative(root, baselinePath).replace(/\\/g, "/")}\`${baseline ? "" : "（缺失，只报告）"}`);
md.push("");
md.push("| 宿主 | 识别为 | 可对位 | 失配 | apply | 判定 |");
md.push("|---|---|---|---|---|---|");
for (const r of results) {
	const compat = r.compat ? (r.compat.known === false ? "unknown" : r.compat.ok ? "OK" : "MISMATCH") : "-";
	const applyCell = r.apply ? (r.apply.ok ? `写 ${r.apply.writesFirst}/再写 ${r.apply.writesSecond}` : "FAIL") : "-";
	md.push(
		`| ${r.version} | ${r.host ?? "-"}（${compat}） | ${r.matched ?? "-"} | ${(r.driftedIds ?? []).join(",") || "0"} | ${applyCell} | ${r.ok ? "ok" : "FAIL"} |`,
	);
}
md.push("");
const notes = results.filter((r) => r.note || r.apply?.note);
if (notes.length) {
	md.push("明细：");
	md.push("");
	for (const r of notes) {
		md.push(`- ${r.version}：${[r.note, r.apply?.note].filter(Boolean).join("；")}`);
	}
	md.push("");
}
if (!failed) md.push("全部宿主在基线上。");
const summary = md.join("\n");

console.log(`\n${summary}`);
if (summaryPath) {
	fs.mkdirSync(path.dirname(path.resolve(summaryPath)), { recursive: true });
	fs.writeFileSync(summaryPath, `${summary}\n`, "utf8");
	console.log(`summary → ${summaryPath}`);
}
if (reportPath) {
	fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
	fs.writeFileSync(reportPath, `${JSON.stringify({ versions, dshHome, results }, null, 2)}\n`, "utf8");
	console.log(`report  → ${reportPath}`);
}

if (!keep) {
	try {
		fs.rmSync(workRoot, { recursive: true, force: true });
	} catch {
		console.log(`临时目录没清干净：${workRoot}`);
	}
} else {
	console.log(`临时目录保留：${workRoot}`);
}

console.log(failed ? `失败 ${failed}/${results.length}` : `全部通过（${results.length} 个宿主）`);
process.exit(failed ? 1 : 0);
