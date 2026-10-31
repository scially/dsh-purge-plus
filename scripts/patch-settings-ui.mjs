/**
 * 把 dsh-purge 的清洗面板注册进宿主「设置」菜单（settings.section slot）。
 *
 * 为什么是 SettingsRoot 而不是 PurgifySection：
 *   SettingsRoot 自带 dshp-root 外壳、PURGE_CSS 注入、theme 检测，并同时渲染
 *   PurgifySection + RulesSection。设置页里单独挂 PurgifySection 会没有样式。
 *
 * 为什么用标记块：
 *   client.js 是上游分发产物，上游改得很勤。这里只维护一段带标记的代码，
 *   升级时冲突了直接 `git checkout --theirs client.js`（拿上游版本），再跑一次本脚本即可。
 *   幂等：重复执行只替换标记块，不会重复插入。
 *
 * 用法：node scripts/patch-settings-ui.mjs [--check]
 *   --check  只报告状态，不写文件（CI / 升级后自检用）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client.js')

const BEGIN = '/* dsh-purge-plus: settings section BEGIN */'
const END = '/* dsh-purge-plus: settings section END */'

/** 挂在 apply(ctx) 末尾：宿主设置面板左侧导航多一页 dsh-purge。 */
const BLOCK = `\t\t\t${BEGIN}
\t\t\t/* 设置 → 左侧导航多一页；内容是 dock 里那块清洗面板（自带外壳与 CSS）。 */
\t\t\ttry {
\t\t\t\tctx.slots.inject("settings.section", () => ctx.slots.register({
\t\t\t\t\tname: "settings.section",
\t\t\t\t\tid: "dsh-purge",
\t\t\t\t\torder: 60,
\t\t\t\t\tlabel: "dsh-purge",
\t\t\t\t\tlocale: NS,
\t\t\t\t\tinject: () => ({ t: ctx.locale.bind(NS) }),
\t\t\t\t}, SettingsRoot));
\t\t\t} catch (e) {
\t\t\t\ttry { console.warn("[dsh-purge] settings section skipped:", e); } catch { /* ignore */ }
\t\t\t}
\t\t\t${END}`

/**
 * 锚点必须带上前面的 `\t\t}`（apply 的闭合大括号）。
 * 只锚 exports 会插到 apply 外面 —— 模块顶层没有 ctx，注册会静默失败。
 */
const TAIL = '\t\t}\n\n\t\texports.name = name;'
const APPLY_HEAD = 'function apply(ctx) {'

const checkOnly = process.argv.includes('--check')
const source = readFileSync(clientPath, 'utf8')
const hasBegin = source.includes(BEGIN)
const hasEnd = source.includes(END)

if (hasBegin !== hasEnd) {
	throw new Error(`标记块残缺（BEGIN=${hasBegin} END=${hasEnd}），先手工修好 client.js`)
}

let next
let action

if (hasBegin) {
	const start = source.indexOf(BEGIN)
	// 标记块从行首缩进开始，回退到该行开头
	const lineStart = source.lastIndexOf('\n', start) + 1
	const endMarker = source.indexOf(END)
	const lineEnd = source.indexOf('\n', endMarker)
	const current = source.slice(lineStart, lineEnd)
	next = current === BLOCK ? source : source.slice(0, lineStart) + BLOCK + source.slice(lineEnd)
	action = current === BLOCK ? 'unchanged' : 'replaced'
} else {
	const at = source.indexOf(TAIL)
	if (at < 0) throw new Error('找不到插入锚点（apply 闭合 + exports.name）。上游结构变了，先核对 apply(ctx) 尾部再改脚本。')
	if (source.indexOf(TAIL, at + 1) >= 0) throw new Error('插入锚点不唯一，拒绝猜位置')
	// 在 `\t\t}` 之前插入，块因此留在 apply(ctx) 体内
	next = source.slice(0, at) + BLOCK + '\n' + source.slice(at)
	action = 'inserted'
}

/** 在 `at` 下标处 apply(ctx) 的花括号深度必须 ≥ 1；否则说明插到了函数外面，ctx 是 undefined。 */
function depthInsideApply(text, at) {
	const head = text.indexOf(APPLY_HEAD)
	if (head < 0) return -1
	let depth = 0
	for (let i = head + APPLY_HEAD.length - 1; i < at; i += 1) {
		const ch = text[i]
		if (ch === '{') depth += 1
		else if (ch === '}') depth -= 1
	}
	return depth
}

const blockAt = next.indexOf(BEGIN)
const depth = depthInsideApply(next, blockAt)
if (depth < 1) {
	throw new Error(`注册块落在 apply(ctx) 外面（深度 ${depth}），ctx 未定义 —— 拒绝写入`)
}

if (action === 'unchanged') {
	console.log('[settings-ui] 已是最新，零写入')
} else if (checkOnly) {
	console.log(`[settings-ui] 需要${action === 'inserted' ? '插入' : '更新'}（--check 不写文件）`)
	process.exitCode = 1
} else {
	writeFileSync(clientPath, next, 'utf8')
	console.log(`[settings-ui] ${action === 'inserted' ? '已插入' : '已更新'} settings.section 注册块`)
}

// 关键符号存在性自检：注册用到的东西必须在同一作用域里
for (const symbol of ['function SettingsRoot(', 'const NS = "settings.dsh-purge"']) {
	if (!next.includes(symbol)) {
		console.error(`[settings-ui] 警告：找不到 ${symbol}，注册块可能引用不到`)
		process.exitCode = 1
	}
}
