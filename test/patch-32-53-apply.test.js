/**
 * #32 / #53 在 0.2.1-rc.5 上的替换结果验证。
 *
 * 这两个补丁踩的都是「往模板字符串里塞东西」的雷：
 *   · WEB_SURFACE_PROMPT 是一整条模板字符串，插 /* marker *\/ 会变成 prompt 正文；
 *   · 同一句话在 LEGACY_WEB_SURFACE.suffix 里还有一份，官方注释明写不许动它
 *     （动了会让历史会话的段落匹配不上并重写日志 prompt）。
 * 所以这里不只看「能不能匹配」，还要把替换真的跑一遍，检查产物。
 *
 * 宿主不在本机时整组跳过（CI 环境没有 dsh 安装目录）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { ALL_PATCHES } from '../lib/core.js'

const AI_BASE = 'C:/nvm4w/nodejs/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const DEV_CONTEXT = `${AI_BASE}/dsh-harness-dev-context/lib/index.js`
const WEB_APP_LIB = `${AI_BASE}/dsh-web-app/lib/index.js`

const hasHost = existsSync(DEV_CONTEXT)
const skip = hasHost ? false : '宿主文件不在本机，跳过'

const patchOf = (id) => ALL_PATCHES.find((p) => p.id === id)
const replacementsOf = (p) => (Array.isArray(p.replacements)
	? p.replacements
	: (p.patterns ?? []).map((pattern) => ({ pattern, replace: p.replace })))

/** 按 patch 顺序把 replacements 全跑一遍（等价于 apply 的 replaceAll 语义）。 */
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

test('#32/#53 的 pattern 在 rc.5 上都能命中', { skip }, () => {
	const text = readFileSync(DEV_CONTEXT, 'utf8')
	const webText = readFileSync(WEB_APP_LIB, 'utf8')
	for (const id of [32, 53]) {
		const p = patchOf(id)
		assert.ok(p, `找不到补丁 #${id}`)
		const hits = replacementsOf(p).filter((r) => typeof r.pattern === 'string'
			&& (text.includes(r.pattern) || webText.includes(r.pattern)))
		assert.ok(hits.length > 0, `#${id} 一条 pattern 都没命中`)
	}
})

test('#53 只删模板串里那句，LEGACY_WEB_SURFACE 必须完好', { skip }, () => {
	const original = readFileSync(DEV_CONTEXT, 'utf8')
	const after = applyAll(original, [patchOf(32), patchOf(53)])

	// LEGACY 块逐字不变（官方冻结，动了会重写历史会话日志）
	const legacyBegin = original.indexOf('const LEGACY_WEB_SURFACE = {')
	const legacyEnd = original.indexOf('};', legacyBegin)
	assert.ok(legacyBegin > 0, '找不到 LEGACY_WEB_SURFACE')
	const legacyBefore = original.slice(legacyBegin, legacyEnd + 2)
	const legacyAfter = after.slice(after.indexOf('const LEGACY_WEB_SURFACE = {'), after.indexOf('};', after.indexOf('const LEGACY_WEB_SURFACE = {')) + 2)
	assert.equal(legacyAfter, legacyBefore, 'LEGACY_WEB_SURFACE 被改动了')

	// LEGACY 里那句「不许另开服务器」必须还在（证明删的是模板串那处）
	assert.ok(
		legacyAfter.includes('Do not start a replacement server'),
		'LEGACY suffix 里的禁令句被误删',
	)
	// 模板串里那句应当已经没了：全文只剩 LEGACY 那一处
	const remaining = after.split('Do not start a replacement server').length - 1
	assert.equal(remaining, 1, `禁令句应只剩 LEGACY 一处，实际 ${remaining} 处`)
})

test('#32 去掉品牌名，且不往 prompt 正文里写注释', { skip }, () => {
	const after = applyAll(readFileSync(DEV_CONTEXT, 'utf8'), [patchOf(32)])

	// 模板串里不再自称 DeepSeek Harness
	const promptStart = after.indexOf('const WEB_SURFACE_PROMPT = `')
	const promptEnd = after.indexOf('`;', promptStart)
	const promptBody = after.slice(promptStart, promptEnd)
	assert.ok(!promptBody.includes('DeepSeek Harness'), 'prompt 正文里还有 DeepSeek Harness')
	assert.ok(promptBody.includes('the web GUI whose URL the runtime context names'), '身份句没换成中性措辞')

	// 关键：正文里不能出现任何 dsh-purge 注释（那会变成模型读到的文字）
	assert.ok(!/dsh-purge/.test(promptBody), `prompt 正文被注入了标记: ${promptBody.match(/[^.]*dsh-purge[^.]*/)?.[0]}`)
})

test('#53 的 marker 落在模板串外面', { skip }, () => {
	const after = applyAll(readFileSync(DEV_CONTEXT, 'utf8'), [patchOf(53)])
	const promptStart = after.indexOf('const WEB_SURFACE_PROMPT = ')
	const promptBodyStart = after.indexOf('`', promptStart)
	const markerAt = after.indexOf('[dsh-purge] start-server prohibition removed')
	assert.ok(markerAt > 0, 'marker 没写进去，补丁永远判不成 applied')
	assert.ok(markerAt < promptBodyStart, 'marker 落进了模板字符串内部（会污染 prompt）')
})

test('替换后 #32 / #53 都能判成 applied', { skip }, async () => {
	const { filePatchOutcome } = await import('../lib/core.js')
	const after = applyAll(readFileSync(DEV_CONTEXT, 'utf8'), [patchOf(32), patchOf(53)])
	assert.equal(filePatchOutcome(after, patchOf(32), DEV_CONTEXT), 'applied')
	assert.equal(filePatchOutcome(after, patchOf(53), DEV_CONTEXT), 'applied')
})

test('替换是幂等的：再跑一遍不再变化', { skip }, () => {
	const once = applyAll(readFileSync(DEV_CONTEXT, 'utf8'), [patchOf(32), patchOf(53)])
	const twice = applyAll(once, [patchOf(32), patchOf(53)])
	assert.equal(twice, once, '重复 apply 会继续改动文件')
})
