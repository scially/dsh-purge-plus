// 按预设排除提示词注入：`roleplay` / `minimal` 这类预设只想保留命令、面板和工具，
// 不希望被 Purge 的注入改写。策略是「每次都按当前会话自己的预设判断」，
// 不存在全局「上一次用的预设」这种状态。
//
// 配置来源（合并）：
//   1. dsh 插件配置里的 excludePresets: ["roleplay", "minimal"]
//   2. $DSH_HOME/dsh-purge/exclude-presets.json（CLI 可写，热生效）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function dshHomeOf(explicit) {
	const home = String(explicit || process.env.DSH_HOME || "").trim();
	return home || path.join(os.homedir(), ".dsh");
}

let fileCache = { key: "", value: [] };

/** CLI 写的排除清单（按 mtime+size 缓存）。 */
export function readExcludeFile(dshHome) {
	const fp = path.join(dshHomeOf(dshHome), "dsh-purge", "exclude-presets.json");
	let key = "missing";
	try {
		const st = fs.statSync(fp);
		key = `${st.mtimeMs}:${st.size}`;
	} catch {
		/* 没有文件是常态 */
	}
	if (key === fileCache.key) return fileCache.value;
	let value = [];
	if (key !== "missing") {
		try {
			const data = JSON.parse(fs.readFileSync(fp, "utf8"));
			const list = Array.isArray(data) ? data : data?.excludePresets;
			if (Array.isArray(list)) value = list;
		} catch {
			value = [];
		}
	}
	fileCache = { key, value };
	return value;
}

export function writeExcludeFile(dshHome, list) {
	const fp = path.join(dshHomeOf(dshHome), "dsh-purge", "exclude-presets.json");
	const clean = (Array.isArray(list) ? list : [])
		.filter((x) => typeof x === "string")
		.map((x) => x.trim())
		.filter(Boolean);
	fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
	fs.writeFileSync(fp, `${JSON.stringify({ excludePresets: clean }, null, 2)}\n`, { mode: 0o600 });
	fileCache = { key: "", value: [] };
	return clean;
}

function normalizeId(x) {
	return typeof x === "string" ? x.trim().toLowerCase() : "";
}

/** 配置 + 文件合并后的排除清单（小写、去重）。 */
export function excludedPresetIds(config, dshHome) {
	const fromConfig = Array.isArray(config?.excludePresets) ? config.excludePresets : [];
	const all = [...fromConfig, ...readExcludeFile(dshHome)].map(normalizeId).filter(Boolean);
	return [...new Set(all)];
}

/** 从宿主 assembly 上下文里取当前预设 id。取不到返回 ""。 */
export function resolvePresetId(context) {
	try {
		const header = context?.agent?.session?.header || context?.session?.header || {};
		const id = header.agentPreset || header.preset || context?.agentPreset || "";
		return normalizeId(id);
	} catch {
		return "";
	}
}

/**
 * 本轮要不要注入。
 * - 没有配置排除 → 永远 allow（默认行为零变化）
 * - 有排除但 preset 解析不出来 → 保守不注入（避免把不该注入的预设污染掉）
 * - preset 在清单里 → 不注入
 */
export function injectionPolicy(config, context, dshHome) {
	const ids = excludedPresetIds(config, dshHome);
	const preset = resolvePresetId(context);
	const enabled = config?.enabled !== false;
	const unknown = ids.length > 0 && !preset;
	const excluded = Boolean(preset) && ids.includes(preset);
	return {
		preset,
		excluded,
		unknown,
		allowed: enabled && !excluded && !unknown,
		reason: !enabled ? "disabled" : excluded ? "excluded" : unknown ? "unknown-preset" : "allowed",
	};
}
