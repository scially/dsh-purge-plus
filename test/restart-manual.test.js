import test from 'node:test'
import assert from 'node:assert/strict'

import {
	manualRestartCommand,
	manualRestartPlan,
	scheduleRestart,
} from '../lib/web.js'

/**
 * 自动重启已经下线（2026-11-03）。这些用例守住「别再把重启捡回来」：
 * 无论从哪条路进来，`scheduleRestart` 都只能回一份手动重启说明，
 * 不允许涉及 spawn / 杀进程 / 端口交接。
 */

test('scheduleRestart 只回手动重启说明，不声明 restarting', () => {
	const plan = scheduleRestart(null)
	assert.equal(plan.restarting, false)
	assert.equal(plan.needsManualRestart, true)
	assert.equal(plan.clean, true)
	assert.match(plan.command, /^dsh web --port \d+$/)
	assert.match(plan.note, /手动重启/)
})

test('端口取自请求头：多实例时命令指向当前端口', () => {
	const plan = scheduleRestart({ headers: { host: '127.0.0.1:4099' } })
	assert.equal(plan.command, 'dsh web --port 4099')
})

test('端口缺失时退回 PORT 环境变量，再退回 3080', () => {
	const saved = process.env.PORT
	try {
		process.env.PORT = '4123'
		assert.equal(manualRestartPlan(0).command, 'dsh web --port 4123')
		delete process.env.PORT
		assert.equal(manualRestartCommand(), 'dsh web --port 3080')
	} finally {
		if (saved === undefined) delete process.env.PORT
		else process.env.PORT = saved
	}
})
