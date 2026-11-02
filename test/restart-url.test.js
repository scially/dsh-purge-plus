/**
 * restart 相关回归：web.js 必须把记录里的 url 传给 helper。
 *
 * 背景（上游死代码）：restart-web.js 的 waitFree 失败分支调 `openBrowser(info.url)`，
 * 想让「端口杀不掉、旧 server 还活着」时把页面重新打开，别让用户以为服务凭空消失。
 * 但 scheduleRestart 组装的 payload 从来没有 url 字段，`info.url` 恒为 undefined，
 * `openBrowser("")` 在开头 `if (!url) return;` 就返回了 —— 那段逻辑一直是空操作。
 *
 * 这个测试锁住两件事：
 *   1. readRecordedUrl 能从 web-server-<port>.json 正确读出带 token 的地址；
 *   2. 各种坏输入都安全降级成 ""（不能让重启因为读记录失败而崩）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { readRecordedUrl } from '../lib/web.js'
import { recordPath } from '../lib/web-reclaim.js'

const TOKEN_URL = 'http://127.0.0.1:3080/?token=pU7ZO7ugPuFvDT4X-Ces5qvNaU1jsHI9BQoBxSfMZwM'

/** 造一个临时 DSH_HOME，并在其中写一条 web-server-<port>.json。 */
function withHome(fn) {
	const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-web-'))
	const prev = process.env.DSH_HOME
	process.env.DSH_HOME = home
	try {
		return fn(home)
	} finally {
		if (prev === undefined) delete process.env.DSH_HOME
		else process.env.DSH_HOME = prev
	}
}

function writeRec(home, port, payload) {
	const fp = recordPath(home, port)
	fs.mkdirSync(path.dirname(fp), { recursive: true })
	fs.writeFileSync(fp, typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
	return fp
}

test('能读出记录里的带 token 地址', () => {
	withHome((home) => {
		writeRec(home, 3080, { pid: 1234, port: 3080, host: '127.0.0.1', url: TOKEN_URL })
		assert.equal(readRecordedUrl(3080), TOKEN_URL)
	})
})

test('端口不同不会串号', () => {
	withHome((home) => {
		writeRec(home, 3080, { url: TOKEN_URL })
		writeRec(home, 3999, { url: 'http://127.0.0.1:3999/?token=other' })
		assert.equal(readRecordedUrl(3080), TOKEN_URL)
		assert.equal(readRecordedUrl(3999), 'http://127.0.0.1:3999/?token=other')
	})
})

test('记录不存在时安全返回空串', () => {
	withHome(() => {
		assert.equal(readRecordedUrl(3080), '')
	})
})

test('记录是坏 JSON 时安全返回空串', () => {
	withHome((home) => {
		writeRec(home, 3080, '{ this is not json')
		assert.equal(readRecordedUrl(3080), '')
	})
})

test('url 字段缺失或不是字符串时返回空串', () => {
	withHome((home) => {
		writeRec(home, 3080, { pid: 1, url: '' })
		assert.equal(readRecordedUrl(3080), '')
		writeRec(home, 3080, { pid: 1 })
		assert.equal(readRecordedUrl(3080), '')
		writeRec(home, 3080, { pid: 1, url: 12345 })
		assert.equal(readRecordedUrl(3080), '')
	})
})

test('url 来自 writeRecord 的真实写入路径', async () => {
	const { writeRecord } = await import('../lib/web-reclaim.js')
	withHome((home) => {
		writeRecord(home, 3080, 4242, { host: '127.0.0.1', url: TOKEN_URL })
		assert.equal(readRecordedUrl(3080), TOKEN_URL)
	})
})
