// 维护动作：诊断 / 重锚 / 探针 / 快照 / 预设排除。
// CLI（bin/dsh-purge.js）和宿主的 /purge 命令都走这里，避免两套实现走偏。
import fs from "node:fs";
import * as core from "./core.js";
import * as anchors from "./anchors.js";
import * as probe from "./probe.js";
import * as snapshot from "./snapshot.js";
import * as presetPolicy from "./preset-policy.js";
import * as patchGroups from "./patch-groups.js";
import { PATCH_GROUPS } from "./extra-patches.js";
import { diagnoseHost, renderDiagnosis } from "./diagnose.js";

function resolveAiBase(explicit) {
	if (explicit) return explicit;
	try {
		return core.findAiBase();
	} catch {
		return null;
	}
}

export async function diagnose({ aiBase, dshHome, detail = false } = {}) {
	const base = resolveAiBase(aiBase);
	if (!base) return { ok: false, error: core.missingAiBaseMessage() };
	const report = await diagnoseHost(base, { dshHome });
	report.aiBase = base;
	return { ok: true, report, text: renderDiagnosis(report, { detail }) };
}

/**
 * 写/清一条重锚覆盖，并回报这条补丁改前改后的状态。
 */
export async function reanchor({ aiBase, dshHome, id, index = 0, text, from, clear = false } = {}) {
	if (!id) return { ok: false, error: "缺少补丁号，例如：dsh-purge reanchor 40 --index 0 --text \"...\"" };
	const base = resolveAiBase(aiBase);
	if (clear) {
		anchors.clearOverride(dshHome, id, index === null ? undefined : index);
		const after = base ? (await core.patchStatus(base))[String(id)] : "?";
		return { ok: true, text: `已清除 #${id}${index === undefined ? "" : ` 的第 ${index} 条`} 重锚覆盖（当前状态：${after}）` };
	}
	let pattern = text;
	if (!pattern && from) {
		try {
			pattern = fs.readFileSync(from, "utf8");
		} catch (e) {
			return { ok: false, error: `读不到 ${from}: ${e.message}` };
		}
	}
	if (!pattern) return { ok: false, error: "缺少锚点文本（--text 或 --from）" };
	pattern = String(pattern).replace(/\r\n/g, "\n");
	const before = base ? (await core.patchStatus(base))[String(id)] : "?";
	anchors.writeOverride(dshHome, id, index, pattern, {
		host: base ? (core.readHostVersion(base)?.version || "") : "",
	});
	const after = base ? (await core.patchStatus(base))[String(id)] : "?";
	const summary = anchors.overrideSummary(dshHome);
	return {
		ok: after !== "drifted",
		text: [
			`已写入重锚 #${id}[${index}]（${before} → ${after}）`,
			`覆盖文件：${anchors.overridesPath(dshHome)}`,
			`累计 ${summary.total} 处，涉及 ${summary.ids.map((x) => "#" + x).join(", ")}`,
			after === "drifted" ? "⚠ 仍然失配：这段锚点没在宿主文件里找到，需要重新取片段。" : "下一步：dsh-purge --apply 应用。",
		].join("\n"),
	};
}

export function probeStatus({ dshHome } = {}) {
	const p = probe.readProbe(dshHome);
	if (!p) return { ok: true, text: "当前没有存活中的探针。用 dsh-purge probe --new 生成。" };
	const age = Math.round((Date.now() - p.at) / 1000);
	return { ok: true, text: `探针存活：${p.nonce}（${age}s 前生成，TTL ${Math.round(probe.PROBE_TTL_MS / 60000)} 分钟）` };
}

export function probeNew({ dshHome } = {}) {
	const created = probe.createProbe(dshHome);
	return { ok: true, text: created.message };
}

export function probeCheck({ dshHome } = {}) {
	const result = probe.checkProbe(dshHome);
	if (result.error) return { ok: false, error: result.error };
	if (!result.hits.length) {
		return {
			ok: false,
			text: [
				`没有在会话日志里找到 ${result.nonce}（扫了 ${result.scanned} 个会话文件）。`,
				"可能原因：还没发新消息 / 注入没到达模型 / 该会话的日志还没落盘。",
				"再发一句话后重试；确认注入生效后跑 probe --end 清掉探针。",
			].join("\n"),
		};
	}
	const hit = result.hits[0];
	return {
		ok: true,
		text: [
			`PASS: ${result.nonce} 出现在会话日志里，注入确实到达了模型上下文。`,
			`证据：${hit.file}`,
			`片段：${hit.snippet.slice(0, 200)}`,
			"收尾：dsh-purge probe --end",
		].join("\n"),
	};
}

export function probeEnd({ dshHome } = {}) {
	probe.clearProbe(dshHome);
	return { ok: true, text: "探针已清除。" };
}

export function backup({ aiBase, dshHome, label = "", host = "" } = {}) {
	const base = resolveAiBase(aiBase);
	if (!base) return { ok: false, error: core.missingAiBaseMessage() };
	const r = snapshot.createSnapshot(base, { dshHome, label, host });
	if (!r.ok) return r;
	const pruned = snapshot.pruneSnapshots(dshHome, snapshot.SNAPSHOT_KEEP);
	return {
		ok: true,
		text: [
			`快照 ${r.id} 已建立：${r.files} 个文件，${(r.bytes / 1024 / 1024).toFixed(1)} MB`,
			`目录：${r.dir}`,
			pruned.length ? `已按保留 ${snapshot.SNAPSHOT_KEEP} 份清理：${pruned.join(", ")}` : "保留策略：最新 5 份",
		].join("\n"),
	};
}

export function rollback({ aiBase, dshHome, id } = {}) {
	const base = resolveAiBase(aiBase);
	if (!base) return { ok: false, error: core.missingAiBaseMessage() };
	const r = snapshot.restoreSnapshot(base, id, { dshHome });
	if (!r.ok && r.error) return { ok: false, error: r.error };
	const lines = [`回滚到快照 ${r.id}：${r.restored} 个文件已还原`];
	if (r.skipped?.length) lines.push(`跳过 ${r.skipped.length} 个（越界）：${r.skipped.map((s) => s.rel).join(", ")}`);
	if (r.errors?.length) {
		lines.push(`失败 ${r.errors.length} 个：`);
		for (const e of r.errors.slice(0, 10)) lines.push(`  ${e.rel}: ${e.error}`);
	}
	lines.push("提示：回滚只还原文件，不重装依赖；重启 dsh 后生效。");
	return { ok: r.ok, text: lines.join("\n") };
}

export function snapshots({ dshHome, prune } = {}) {
	if (prune !== undefined && prune !== null && prune !== false) {
		const removed = snapshot.pruneSnapshots(dshHome, Number(prune) || 0);
		return { ok: true, text: removed.length ? `已清理：${removed.join(", ")}` : "没有需要清理的快照。" };
	}
	const list = snapshot.listSnapshots(dshHome);
	if (!list.length) return { ok: true, text: "没有快照。dsh-purge backup 建立一份。" };
	const lines = list.map((s) => {
		const when = String(s.createdAt || "").replace("T", " ").slice(0, 19);
		return `  ${s.id}  ${when}  ${String(s.files).padStart(3)} 个文件  ${(s.bytes / 1024 / 1024).toFixed(1)} MB${s.label ? `  ${s.label}` : ""}`;
	});
	return { ok: true, text: ["快照（新→旧）：", ...lines].join("\n") };
}

export function excludePresets({ dshHome, set, list, clear } = {}) {
	if (list || (!set && !clear)) {
		const ids = presetPolicy.readExcludeFile(dshHome);
		return { ok: true, text: ids.length ? `当前排除的预设：${ids.join(", ")}` : "当前没有排除任何预设（全部会话都注入）。" };
	}
	const ids = clear ? [] : String(set).split(",").map((s) => s.trim()).filter(Boolean);
	const saved = presetPolicy.writeExcludeFile(dshHome, ids);
	return {
		ok: true,
		text: saved.length
			? `已排除：${saved.join(", ")}。这些预设不注入，但命令/面板/工具照常可用。`
			: "已清空排除列表：所有预设都会注入。",
	};
}

/** 补丁组开关：`groups` 只列表，`groups permission=off,context=on` 修改。 */
export function groups({ dshHome, set } = {}) {
	const groupsMod = patchGroups;
	const names = Object.keys(PATCH_GROUPS);
	if (!set) {
		const lines = ["补丁组（关掉的组不会被应用，也不会刷失败）："];
		for (const name of names) {
			const def = PATCH_GROUPS[name];
			const on = groupsMod.groupEnabled(dshHome, name);
			lines.push(`  ${on ? "✓" : "✗"} ${name.padEnd(11)} ${def.label}（${def.ids.length} 条）${on ? "" : " — 已关闭"}`);
		}
		lines.push("", "改：dsh-purge groups permission=off");
		return { ok: true, text: lines.join("\n") };
	}
	const patch = {};
	for (const part of String(set).split(",")) {
		const [name, value] = part.split("=").map((x) => x.trim());
		if (!names.includes(name)) continue;
		if (/^(off|0|false|no)$/i.test(value || "")) patch[name] = false;
		else if (/^(on|1|true|yes)$/i.test(value || "")) patch[name] = true;
	}
	if (!Object.keys(patch).length) return { ok: false, error: `没有可识别的组：${names.join(" / ")}` };
	const saved = groupsMod.writeGroupSettings(dshHome, patch);
	return { ok: true, text: `已更新：${JSON.stringify(saved)}（下次应用生效）` };
}
