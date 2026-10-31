/**
 * #32 / #53 在 0.2.1-rc.5 上的替换正确性验证。
 *
 * 这两个补丁踩的都是「往模板字符串里塞东西」的雷：
 *   · WEB_SURFACE_PROMPT 是一整条模板字符串，插 marker 会变成 prompt 正文；
 *   · 同一句话在 LEGACY_WEB_SURFACE.suffix 里还有一份，官方注释明写不许动它
 *     （动了会让历史会话的段落匹配不上并重写日志 prompt）。
 *
 * 宿主可能处于两种状态，测试都要成立：
 *   · 未 apply：pattern 必须能命中，模拟替换后产物必须干净；
 *   · 已 apply：marker 必须在，且 LEGACY 段与备份逐字相同。
 * 有 .dshpurge.bak 就用备份当「原文」，否则用当前文件。
 *
 * 宿主不在本机时整组跳过（CI 环境没有 dsh 安装目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { ALL_PATCHES, filePatchOutcome } from '../lib/core.js'

const AI_BASE = 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const DEV_CONTEXT = `${AI_BASE}/dsh-harness-dev-context/lib/index.js`
const WEB_APP_LIB = `${AI_BASE}/dsh-web-app/lib/index.js`
const BAK = `${DEV_CONTEXT}.dshpurge.bak`

const hasHost = existsSync(DEV_CONTEXT)
const skip = hasHost ? false : '宿主文件不在本机，跳过'

const patchOf = (id) => ALL_PATCHES.find((p) => p.id === id)
const replacementsOf = (p) => (Array.isArray(p.replacements)
	? p.replacements
	: (p.patterns ?? []).map((pattern) => ({ pattern, replace: p.replace })))

/** 原文：优先后备备份文件（apply 会留一份），否则当前文件。 */
const baseline = () => (existsSync(BAK) ? readFileSync(BAK, 'utf8') : readFileSync(DEV_CONTEXT, 'utf8'))
const current = () => readFileSync(DEV_CONTEXT, 'utf8')

function applyAll(text, patches) {
	let out = text
	for (const p of patches) {
		for (const r of replacementsOf(p)) {
			if (!r.pattern || typeof r.replace !== 'string') continue
			out = out.split(r.pattern).join(r.replace)
		}
	}
	return out
}

/** 截出 LEGACY_WEB_SURFACE 常量整块，用于逐字比对。 */
function legacyBlock(text) {
	const begin = text.indexOf('const LEGACY_WEB_SURFACE = {')
	assert.ok(begin > 0, '找不到 LEGACY_WEB_SURFACE')
	const end = text.indexOf('};', begin)
	assert.ok(end > begin, '找不到 LEGACY_WEB_SURFACE 结束')
	return text.slice(begin, end + 2)
}

/** 截出 WEB_SURFACE_PROMPT 模板字符串正文。 */
function promptBody(text) {
	const decl = text.indexOf('const WEB_SURFACE_PROMPT =')
	assert.ok(decl > 0, '找不到 WEB_SURFACE_PROMPT')
	const open = text.indexOf('`', decl)
	const close = text.indexOf('`;', open)
	assert.ok(open > 0 && close > open, '找不到模板字符串边界')
	return text.slice(open + 1, close)
}

test('原始文本里 #32/#53 都能命中；已 apply 时 marker 必须在', { skip }, () => {
	const src = baseline()
	const applied = current().includes('[dsh-purge] start-server prohibition removed')
	if (applied) {
		assert.ok(current().includes('[dsh-purge] web surface identity neutralized'), '#32 marker 缺失')
		assert.ok(current().includes('[dsh-purge] start-server prohibition removed'), '#53 marker 缺失')
		return
	}
	const webText = existsSync(WEB_APP_LIB) ? readFileSync(WEB_APP_LIB, 'utf8') : ''
	for (const id of [32, 53]) {
		const p = patchOf(id)
		assert.ok(p, `找不到补丁 #${id}`)
		const hits = replacementsOf(p).filter((r) => typeof r.pattern === 'string'
			&& (src.includes(r.pattern) || webText.includes(r.pattern)))
		assert.ok(hits.length > 0, `#${id} 一条 pattern 都没命中`)
	}
})

test('#53 只删模板串里那句，LEGACY_WEB_SURFACE 逐字不变', { skip }, () => {
	const src = baseline()
	const expectedLegacy = legacyBlock(src)

	// ① 模拟替换：LEGACY 不能被碰
	const after = applyAll(src, [patchOf(32), patchOf(53)])
	assert.equal(legacyBlock(after), expectedLegacy, 'LEGACY_WEB_SURFACE 被改动了')
	assert.ok(legacyBlock(after).includes('Do not start a replacement server'), 'LEGACY suffix 里的禁令句被误删')
	assert.equal(after.split('Do not start a replacement server').length - 1, 1, '禁令句应只剩 LEGACY 一处')

	// ② 真实文件（可能已被 apply）：LEGACY 同样必须逐字等于备份
	if (existsSync(BAK)) {
		assert.equal(legacyBlock(current()), expectedLegacy, '已 apply 的文件把 LEGACY 改了')
		const remaining = current().split('Do not start a replacement server').length - 1
		assert.equal(remaining, 1, `已 apply 的文件里禁令句应只剩 LEGACY 一处，实际 ${remaining} 处`)
	}
})

test('#32 去掉品牌名，且不往 prompt 正文里写注释', { skip }, () => {
	const src = baseline()
	const after = applyAll(src, [patchOf(32)])
	const body = promptBody(after)
	assert.ok(!body.includes('DeepSeek Harness'), 'prompt 正文里还有 DeepSeek Harness')
	assert.ok(body.includes('the web GUI whose URL the runtime context names'), '身份句没换成中性措辞')
	assert.ok(!/dsh-purge/.test(body), `prompt 正文被注入了标记: ${body.match(/[^.]*dsh-purge[^.]*/)?.[0]}`)

	// 真实文件若已被 apply，同样不能有污染
	const live = promptBody(current())
	assert.ok(!live.includes('DeepSeek Harness'), '已 apply 的文件 prompt 正文仍有品牌名')
	assert.ok(!/dsh-purge/.test(live), '已 apply 的文件 prompt 正文被注入了标记')
})

test('#53 的 marker 落在模板串外面', { skip }, () => {
	const after = applyAll(baseline(), [patchOf(53)])
	const decl = after.indexOf('const WEB_SURFACE_PROMPT =')
	const open = after.indexOf('`', decl)
	const markerAt = after.indexOf('[dsh-purge] start-server prohibition removed')
	assert.ok(markerAt > 0, 'marker 没写进去，补丁永远判不成 applied')
	assert.ok(markerAt < open, 'marker 落进了模板字符串内部（会污染 prompt）')

	if (current().includes('[dsh-purge] start-server prohibition removed')) {
		const liveDecl = current().indexOf('const WEB_SURFACE_PROMPT =')
		const liveOpen = current().indexOf('`', liveDecl)
		const liveMarker = current().indexOf('[dsh-purge] start-server prohibition removed')
		assert.ok(liveMarker < liveOpen, '已 apply 的文件里 marker 落进了模板字符串')
	}
})

test('替换后 #32 / #53 都能判成 applied', { skip }, () => {
	const after = applyAll(baseline(), [patchOf(32), patchOf(53)])
	assert.equal(filePatchOutcome(after, patchOf(32), DEV_CONTEXT), 'applied')
	assert.equal(filePatchOutcome(after, patchOf(53), DEV_CONTEXT), 'applied')
})

test('替换是幂等的：再跑一遍不再变化', { skip }, () => {
	const once = applyAll(baseline(), [patchOf(32), patchOf(53)])
	assert.equal(applyAll(once, [patchOf(32), patchOf(53)]), once, '重复 apply 会继续改动文件')
})
