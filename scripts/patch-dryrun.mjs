/**
 * 只读诊断：逐条补丁、逐条 pattern 拿宿主真实文件试匹配，报告能不能 apply。
 * 绝不写宿主文件 —— 只读 text 然后 indexOf/test。
 *
 * 用法：
 *   node scripts/patch-dryrun.mjs            汇总
 *   node scripts/patch-dryrun.mjs --detail    逐 pattern 明细
 *   node scripts/patch-dryrun.mjs --only 32,53
 */
import fs from 'node:fs'
import {
	ALL_PATCHES,
	findAiBase,
	targetFiles,
	filePatchOutcome,
	patchStatus,
	hostCompat,
	HOST_TARGET,
	readHostVersion,
} from '../lib/core.js'

const argv = process.argv.slice(2)
const detail = argv.includes('--detail')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 && argv[onlyIdx + 1]
	? new Set(argv[onlyIdx + 1].split(',').map((s) => Number(s.trim())))
	: null

const aiBase = findAiBase()
if (!aiBase) {
	console.error('找不到 aiBase（宿主安装目录）')
	process.exit(1)
}

const host = readHostVersion(aiBase)
const compat = hostCompat(aiBase)
console.log('宿主 / host      :', host ? `${host.name}@${host.version}` : '(未识别)')
console.log('声明适配 / target :', HOST_TARGET || '(空)')
console.log('适配判定 / compat :', compat.ok === null ? 'unknown' : compat.ok ? 'OK' : 'MISMATCH（仅告警，不阻止 apply）')
console.log('aiBase           :', aiBase)
console.log('')

/** 与 core 内部一致的本地实现（那两个函数没导出，这里只做诊断用）。 */
function replacementsOf(p) {
	if (Array.isArray(p.replacements)) return p.replacements
	return (p.patterns ?? []).map((pat) => ({ pattern: pat, replace: p.replace }))
}
const asLf = (s) => String(s).replace(/\r\n/g, '\n')

function countHits(hay, pattern) {
	if (!pattern) return 0
	if (pattern instanceof RegExp) {
		const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
		return [...hay.matchAll(re)].length
	}
	const needle = asLf(pattern)
	if (!needle) return 0
	let n = 0
	let at = hay.indexOf(needle)
	while (at >= 0) {
		n += 1
		at = hay.indexOf(needle, at + needle.length)
	}
	return n
}

const files = targetFiles(aiBase)
const cached = new Map()
function read(fp) {
	if (!cached.has(fp)) {
		try { cached.set(fp, fs.readFileSync(fp, 'utf8')) } catch { cached.set(fp, null) }
	}
	return cached.get(fp)
}

const status = await patchStatus(aiBase)
const tally = {}
for (const s of Object.values(status)) tally[s] = (tally[s] ?? 0) + 1

console.log('=== 状态汇总 ===')
console.log(JSON.stringify(tally))
console.log('')

const interesting = ALL_PATCHES.filter((p) => (only ? only.has(p.id) : true))

const blocked = []
const ready = []
for (const p of interesting) {
	const st = status[p.id]
	if (st === 'na' || st === 'applied' || st === 'skipped') continue
	const keys = Array.isArray(p.file) ? p.file : [p.file]
	const rows = []
	let anyHit = 0
	let anyMiss = 0
	let missingFile = 0
	let alreadyDone = 0
	for (const key of keys) {
		// targetFiles 的值可能是字符串（firstExisting）也可能是数组（allExisting）
		const raw = files[key] ?? []
		const fps = Array.isArray(raw) ? raw : (raw ? [raw] : [])
		if (fps.length === 0) { missingFile += 1; continue }
		for (const fp of fps) {
			const text = read(fp)
			if (text == null) { missingFile += 1; continue }
			const hay = asLf(text)
			const outcome = filePatchOutcome(hay, p, fp)
			if (outcome === 'applied') { alreadyDone += 1; continue }
			for (const r of replacementsOf(p)) {
				const hits = countHits(hay, r.pattern)
				rows.push({ fp, pattern: r.pattern, hits })
				if (hits > 0) anyHit += 1
				else anyMiss += 1
			}
		}
	}
	const entry = { id: p.id, name: p.name, st, rows, anyHit, anyMiss, missingFile, alreadyDone }
	if (anyHit > 0) ready.push(entry)
	else blocked.push(entry)
}

console.log(`=== 可以 apply（pattern 至少命中一条）：${ready.length} 条 ===`)
for (const e of ready) {
	const pats = e.rows.filter((r) => r.hits > 0)
	console.log(`#${e.id} ${e.name}  [${e.st}]  命中 ${pats.length} 条 pattern`)
	if (detail) for (const r of pats) console.log(`     hits=${r.hits}  ${String(r.pattern).slice(0, 110)}`)
}
console.log('')

console.log(`=== 改不动（一条 pattern 都命中不了）：${blocked.length} 条 ===`)
for (const e of blocked) {
	console.log(`#${e.id} ${e.name}  [${e.st}]  optional=${e.optional ?? '?'}  缺文件=${e.missingFile}`)
	if (detail) {
		for (const r of e.rows) console.log(`     hits=0  ${String(r.pattern).slice(0, 110)}`)
	}
}
