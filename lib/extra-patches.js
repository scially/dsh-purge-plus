// 额外补丁：不写进 core.js 的 PATCHES 字面量（保持上游原文），加载时并入 ALL_PATCHES。
//
// 目前只有两条「Inspector 超限帧」加固（对齐社区版 1.6.99/1.6.100 的 #95/#96）：
// Cordis 树记录给状态外壳预留 1 KiB；单帧仍然超限时只丢弃这一帧、保留上一帧，
// 别的 topic 与序列化/监听异常继续按宿主原语义抛出 —— 以前这里会把整个宿主带走。
//
// 0.2.2-rc.2/rc.3 官方已预留 STATE_RECORD_OVERHEAD_BYTES，预算锚点不存在属于
// 「上游已修好」，用 silentWhenMissing 标成跳过，而不是漂移告警。

const LIMIT_ERROR = 'throw new Error("inspector: source state exceeds the source-frame byte limit");';
const RESERVE_MARKER = "/* [dsh-purge] reserve inspector record overhead */";
const DROP_MARKER = "/* [dsh-purge] discard oversized Cordis tree */";

function treeBudgetPatch(id, file, moduleName, budget) {
	const budgetLine = `maxBytes: ${budget} - 4096`;
	const indent = moduleName === "index.js" ? "\t\t\t" : "\t\t\t\t\t";
	const restore = "else this.state.set(topic, previous);\n" + indent;
	return {
		id,
		name: id === 95 ? "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD" : "INSPECTOR_FRAME_BUDGET_RECORD_OVERHEAD_CLIENT",
		layer: "代码",
		layer_en: "Code",
		desc: "Cordis 树预留记录开销，超限时保留上一帧 / reserve record overhead, drop only the oversized frame",
		file,
		replacements: [
			{ pattern: `${budgetLine}\n`, replace: `${budgetLine} - 1024 ${RESERVE_MARKER}\n` },
			{ pattern: restore + LIMIT_ERROR, replace: restore + `if (topic === "cordis/tree") return; ${DROP_MARKER}\n${indent}${LIMIT_ERROR}` },
			{
				/* 0.2.2-rc.2 的 client bundle 压成一行，上面的格式化锚点匹配不到。 */
				pattern:
					"if(!this.stateFits()){if(previous===void 0)this.state.delete(topic);else this.state.set(topic,previous);throw new Error(`inspector: source state exceeds the source-frame byte limit`)}this.enqueue(record)",
				replace:
					"if(!this.stateFits()){if(previous===void 0)this.state.delete(topic);else this.state.set(topic,previous);if(topic===`cordis/tree`)return; " + DROP_MARKER + "throw new Error(`inspector: source state exceeds the source-frame byte limit`)}this.enqueue(record)",
			},
		],
		markers: [RESERVE_MARKER, DROP_MARKER],
		markersAny: true,
		optional: true,
		silentWhenMissing: true,
	};
}

export const EXTRA_PATCHES = [
	treeBudgetPatch(95, "experimental-inspector", "index.js", "spec.maxSourceFrameBytes"),
	treeBudgetPatch(96, "experimental-inspector-client", "client.js", "bootstrap.maxFrameBytes"),
];

/** 补丁组：面板/CLI 按组统计与开关。 */
export const PATCH_GROUPS = {
	permission: {
		label: "权限与审批边界",
		label_en: "Permission & approval",
		ids: [6, 7, 8, 9, 10, 13, 14, 15, 16, 35, 51, 59, 60, 62],
		defaultEnabled: true,
	},
	context: {
		label: "上下文管理",
		label_en: "Context management",
		ids: [18, 19],
		defaultEnabled: true,
	},
};
