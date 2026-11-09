// 本地重锚覆盖：宿主升级把锚点改坏时，允许把某条补丁的某个 pattern
// 换成「从当前宿主里取出来的真实片段」，而不去改插件源码。
//
// 覆盖存在 $DSH_HOME/dsh-purge/anchor-overrides.json：
//   { "24": { "0": { "pattern": "...", "at": "...", "host": "0.2.2-rc.1" } } }
// apply / status / dryrun 都会叠加这份覆盖；清掉文件即恢复出厂锚点。
//
// 本模块刻意不 import core.js（core 会 import 本模块，形成循环依赖），
// 数据目录按同样顺序自己解析。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const OVERRIDES_FILE = "anchor-overrides.json";

function dshHomeOf(explicit) {
	const home = String(explicit || process.env.DSH_HOME || "").trim();
	return home || path.join(os.homedir(), ".dsh");
}

export function overridesPath(dshHome) {
	return path.join(dshHomeOf(dshHome), "dsh-purge", OVERRIDES_FILE);
}

export function readOverrides(dshHome) {
	try {
		const data = JSON.parse(fs.readFileSync(overridesPath(dshHome), "utf8"));
		return data && typeof data === "object" ? data : {};
	} catch {
		return {};
	}
}

/* core 的 patchReplacements 在热路径里被反复调用；文件不常变，按 mtime+size 缓存。 */
let cache = { key: "", value: {} };

/** 带缓存的读取（给 core 用；测试可直接用 readOverrides）。 */
export function overridesFor(dshHome) {
	const fp = overridesPath(dshHome);
	let key = "missing";
	try {
		const st = fs.statSync(fp);
		key = `${st.mtimeMs}:${st.size}`;
	} catch {
		/* 没有覆盖文件是常态 */
	}
	if (key === cache.key) return cache.value;
	const value = key === "missing" ? {} : readOverrides(dshHome);
	cache = { key, value };
	return value;
}

/** 只让测试用：清掉进程内缓存。 */
export function resetOverrideCache() {
	cache = { key: "", value: {} };
}

export function writeOverride(dshHome, patchId, index, pattern, extra = {}) {
	const text = String(pattern || "");
	if (!text) throw new Error("重锚 pattern 不能为空");
	const fp = overridesPath(dshHome);
	const all = readOverrides(dshHome);
	const key = String(patchId);
	all[key] = all[key] || {};
	all[key][String(index)] = {
		pattern: text,
		at: new Date().toISOString(),
		...extra,
	};
	fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
	fs.writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
	resetOverrideCache();
	return all;
}

export function clearOverride(dshHome, patchId, index) {
	const all = readOverrides(dshHome);
	const key = String(patchId);
	if (!all[key]) return all;
	if (index === undefined) delete all[key];
	else delete all[key][String(index)];
	if (all[key] && Object.keys(all[key]).length === 0) delete all[key];
	const fp = overridesPath(dshHome);
	fs.writeFileSync(fp, JSON.stringify(all, null, 2), { mode: 0o600 });
	resetOverrideCache();
	return all;
}

/** 把覆盖叠到一条补丁的 replacements 上（不改原对象）。 */
export function applyOverrides(patch, overrides) {
	const all = overrides || {};
	const mine = all[String(patch && patch.id)];
	if (!mine) return patch;
	const list = Array.isArray(patch.replacements)
		? patch.replacements.slice()
		: (patch.patterns ?? []).map((pat) => ({ pattern: pat, replace: patch.replace }));
	let changed = false;
	for (const [index, entry] of Object.entries(mine)) {
		const i = Number(index);
		if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
		if (!entry || typeof entry.pattern !== "string" || !entry.pattern) continue;
		list[i] = { ...list[i], pattern: entry.pattern };
		changed = true;
	}
	if (!changed) return patch;
	return { ...patch, replacements: list, overridden: true };
}

/** 覆盖统计（面板/CLI 用）：{ 总条数, 涉及补丁数, 涉及补丁 id }。 */
export function overrideSummary(dshHome) {
	const all = readOverrides(dshHome);
	const ids = Object.keys(all).filter((k) => all[k] && Object.keys(all[k]).length > 0);
	return {
		total: ids.reduce((n, id) => n + Object.keys(all[id]).length, 0),
		patches: ids.length,
		ids,
	};
}
