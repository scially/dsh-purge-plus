// 补丁分组：面板/CLI 按组统计，组关掉时该组补丁不再应用（也不会刷失败）。
//
// 存储：$DSH_HOME/dsh-purge/groups.json
//   { "permission": false, "context": true }
// 缺省值来自 lib/extra-patches.js 的 PATCH_GROUPS（两组默认开启，保持既有行为）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PATCH_GROUPS } from "./extra-patches.js";

function dshHomeOf(explicit) {
	const home = String(explicit || process.env.DSH_HOME || "").trim();
	return home || path.join(os.homedir(), ".dsh");
}

export function groupsPath(dshHome) {
	return path.join(dshHomeOf(dshHome), "dsh-purge", "groups.json");
}

let cache = { key: "", value: {} };

export function readGroupSettings(dshHome) {
	const fp = groupsPath(dshHome);
	let key = "missing";
	try {
		const st = fs.statSync(fp);
		key = `${st.mtimeMs}:${st.size}`;
	} catch {
		/* 没有文件是常态 */
	}
	if (key === cache.key) return cache.value;
	let value = {};
	if (key !== "missing") {
		try {
			const data = JSON.parse(fs.readFileSync(fp, "utf8"));
			if (data && typeof data === "object") {
				for (const name of Object.keys(PATCH_GROUPS)) {
					if (typeof data[name] === "boolean") value[name] = data[name];
				}
			}
		} catch {
			value = {};
		}
	}
	cache = { key, value };
	return value;
}

export function writeGroupSettings(dshHome, patch) {
	const fp = groupsPath(dshHome);
	const next = { ...readGroupSettings(dshHome), ...patch };
	const clean = {};
	for (const name of Object.keys(PATCH_GROUPS)) {
		if (typeof next[name] === "boolean") clean[name] = next[name];
	}
	fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
	fs.writeFileSync(fp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
	cache = { key: "", value: {} };
	return clean;
}

export function groupEnabled(dshHome, name) {
	const saved = readGroupSettings(dshHome);
	if (typeof saved[name] === "boolean") return saved[name];
	return PATCH_GROUPS[name]?.defaultEnabled !== false;
}

/** 关掉的组里所有补丁 id。 */
export function disabledGroupPatchIds(dshHome) {
	const out = new Set();
	for (const [name, def] of Object.entries(PATCH_GROUPS)) {
		if (groupEnabled(dshHome, name)) continue;
		for (const id of def.ids) out.add(String(id));
	}
	return out;
}

export function groupOf(patchId) {
	const id = String(patchId);
	for (const [name, def] of Object.entries(PATCH_GROUPS)) {
		if (def.ids.map(String).includes(id)) return name;
	}
	return "";
}

/** 按组汇总状态：{ group: { applied, pending, drifted, off, na, ... } }。 */
export function summarizeByGroup(status) {
	const out = {};
	for (const [id, state] of Object.entries(status || {})) {
		const group = groupOf(id) || "other";
		out[group] = out[group] || {};
		out[group][state] = (out[group][state] || 0) + 1;
	}
	return out;
}
