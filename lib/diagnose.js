// 锚点漂移诊断：宿主一升级，靠字面量匹配的补丁就可能整段失配。
// 这个模块把「哪条补丁、哪条 pattern、在哪个文件、附近有没有候选落点」摊开，
// 配合 lib/anchors.js 的 overrides，可以在不改插件源码的情况下把锚点修回来。
import fs from "node:fs";
import path from "node:path";
import {
	ALL_PATCHES,
	HOST_TARGETS,
	hostCompat,
	patchStatus,
	readHostVersion,
	targetFiles,
} from "./core.js";
import { applyOverrides, readOverrides } from "./anchors.js";

const asLf = (s) => String(s ?? "").replace(/\r\n/g, "\n");

function replacementsOf(patch, overrides) {
	const effective = applyOverrides(patch, overrides);
	if (Array.isArray(effective.replacements)) return effective.replacements;
	return (effective.patterns ?? []).map((pat) => ({ pattern: pat, replace: effective.replace }));
}

function pathsOfPatch(files, patch) {
	const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
	const out = [];
	for (const key of keys) {
		const v = files[key];
		if (!v) continue;
		for (const fp of Array.isArray(v) ? v : [v]) if (fp && !out.includes(fp)) out.push(fp);
	}
	return out;
}

function readText(fp) {
	try {
		return asLf(fs.readFileSync(fp, "utf8"));
	} catch {
		return "";
	}
}

function literalHit(text, pattern) {
	if (!text) return false;
	if (pattern instanceof RegExp) {
		const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
		return re.test(text);
	}
	const needle = asLf(pattern);
	return needle ? text.includes(needle) : false;
}

/** 在文件里按「最长的几行」做候选定位，返回行号与上下文。 */
function candidatesFor(text, pattern, fp) {
	if (pattern instanceof RegExp) return [];
	const lines = asLf(pattern)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length >= 16)
		.sort((a, b) => b.length - a.length)
		.slice(0, 2);
	if (!lines.length) return [];
	const fileLines = text.split("\n");
	const out = [];
	for (const token of lines) {
		for (let i = 0; i < fileLines.length; i += 1) {
			if (!fileLines[i].includes(token)) continue;
			out.push({ file: fp, line: i + 1, text: fileLines[i].trim().slice(0, 220) });
			if (out.length >= 3) return out;
			break;
		}
	}
	return out;
}

/**
 * 逐条补丁诊断。
 * @returns {{host:string, compat:object, declared:string[], tally:object, drifted:Array, overridden:number}}
 */
export async function diagnoseHost(aiBase, options = {}) {
	const dshHome = options.dshHome;
	const overrides = readOverrides(dshHome);
	const files = targetFiles(aiBase);
	const status = await patchStatus(aiBase);
	const tally = {};
	for (const s of Object.values(status)) tally[s] = (tally[s] ?? 0) + 1;

	const drifted = [];
	for (const patch of ALL_PATCHES) {
		const s = status[String(patch.id)];
		if (s !== "drifted") continue;
		const paths = pathsOfPatch(files, patch);
		const pathsText = paths.map((fp) => ({ fp, text: readText(fp) }));
		const misses = [];
		replacementsOf(patch, overrides).forEach((rep, index) => {
			const hit = pathsText.some(({ text }) => literalHit(text, rep.pattern));
			if (hit) return;
			let cands = [];
			for (const { fp, text } of pathsText) {
				cands = candidatesFor(text, rep.pattern, fp);
				if (cands.length) break;
			}
			misses.push({
				index,
				kind: rep.pattern instanceof RegExp ? "regex" : "literal",
				pattern: rep.pattern instanceof RegExp ? String(rep.pattern) : asLf(rep.pattern),
				candidates: cands,
			});
		});
		drifted.push({
			id: String(patch.id),
			name: patch.name,
			files: paths,
			misses,
		});
	}

	const host = readHostVersion(aiBase);
	return {
		host: host ? `${host.name}@${host.version}` : "(未识别)",
		compat: hostCompat(aiBase),
		declared: HOST_TARGETS.slice(),
		tally,
		total: Object.keys(status).length,
		drifted,
		overridden: Object.values(overrides).reduce((n, m) => n + (m ? Object.keys(m).length : 0), 0),
	};
}

/** 文本化：给 CLI / /purge diagnose 直接用。 */
export function renderDiagnosis(report, { detail = false } = {}) {
	const lines = [];
	lines.push(`宿主: ${report.host}`);
	lines.push(`声明适配: ${report.declared.join(" / ") || "(空)"}`);
	const compat = report.compat || {};
	lines.push(`适配判定: ${compat.known === false ? "unknown" : compat.ok ? "OK" : "MISMATCH（仅告警，不阻止 apply）"}`);
	lines.push(`状态: ${JSON.stringify(report.tally)}  合计 ${report.total} 条`);
	if (report.overridden) lines.push(`本地重锚: ${report.overridden} 处`);
	if (!report.drifted.length) {
		lines.push("", "没有失配的锚点。");
		return lines.join("\n");
	}
	lines.push("", `失配 ${report.drifted.length} 条：`);
	for (const d of report.drifted) {
		lines.push(`  #${d.id} ${d.name}`);
		for (const m of d.misses) {
			lines.push(`    [${m.index}] ${m.kind} ${JSON.stringify(m.pattern).slice(0, 120)}`);
			if (!detail) continue;
			for (const c of m.candidates) {
				lines.push(`        候选 ${path.basename(c.file)}:${c.line} ${c.text}`);
			}
			if (!m.candidates.length) lines.push("        （没有候选，需人工看宿主源码）");
		}
	}
	lines.push("", "修法：dsh-purge reanchor <补丁号> --index <序号> --text \"<从宿主里取出的真实片段>\"");
	lines.push("      或者直接改 lib/core.js 的 pattern（发版方案）。");
	return lines.join("\n");
}
