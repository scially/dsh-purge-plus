/**
 * 补齐最后一个未覆盖的差异：真实重启用 detached:true + stdio:"ignore" 起 helper。
 * 之前的手动实验用的是 detached:false + pipe，看不到 helper 在独立控制台下会不会死。
 *
 * 观察手段只有日志文件（stdio 被 ignore，读不到 stdout）。
 * 不碰 3080：端口 3997，pid=0 不杀任何进程。
 *
 * 用法：node scripts/diag-restart-detached.mjs
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../lib/core.js'
import { restartArgv } from '../lib/web.js'

const PORT = 3997
const HELPER = fileURLToPath(new URL('../lib/restart-web.js', import.meta.url))
const LOG = path.join(core.findDshHome(), 'dsh-purge', 'restart.log')

function portOpen(port) {
	return new Promise((resolve) => {
		const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true) })
		s.on('error', () => resolve(false))
	})
}

try { fs.rmSync(LOG, { force: true }) } catch { /* ignore */ }

const argv = restartArgv()
const i = argv.indexOf('--port')
if (i >= 0 && argv[i + 1]) argv[i + 1] = String(PORT)
else argv.push('--port', String(PORT))

const payload = {
	kind: 'web',
	execPath: process.execPath,
	argv,
	cwd: process.cwd(),
	host: '127.0.0.1',
	port: PORT,
	pid: 0,
	openBrowser: false,
}

console.log('=== 用和真实重启完全相同的 spawn 参数 ===')
console.log('  detached: true, stdio: "ignore", windowsHide: true, shell: false')

const child = spawn(process.execPath, [HELPER], {
	detached: true,
	stdio: 'ignore',
	windowsHide: true,
	shell: false,
	env: { ...core.envForDetachedSpawn(), DSH_PURGE_RESTART: JSON.stringify(payload) },
})
child.unref()
console.log('  helper pid =', child.pid ?? '(未拿到 pid —— spawn 可能失败)')

let exited = null
child.on('exit', (code, sig) => { exited = { code, sig } })
child.on('error', (e) => console.log('  spawn error:', e.message))

const t0 = Date.now()
let listened = null
while (Date.now() - t0 < 30000) {
	if (await portOpen(PORT)) { listened = Date.now() - t0; break }
	await new Promise((r) => setTimeout(r, 250))
}

console.log('\n=== 结果 ===')
console.log('  新进程监听:', listened === null ? `否（30s 内没起来）` : `是，${listened}ms`)
console.log('  helper 退出:', exited ? JSON.stringify(exited) : '仍在运行')
console.log('\n=== restart.log ===')
try {
	const text = fs.readFileSync(LOG, 'utf8')
	console.log(text.trim().split('\n').map((l) => '  ' + l).join('\n') || '  (空)')
} catch (e) {
	console.log('  读不到日志:', e.message)
}

// 清场
if (listened !== null) {
	const out = spawn('cmd.exe', ['/d', '/s', '/c', `netstat -ano | findstr :${PORT}`], { windowsHide: true, stdio: 'pipe' })
	let txt = ''
	out.stdout.on('data', (c) => { txt += String(c) })
	await new Promise((r) => out.on('exit', r))
	const pids = [...new Set([...txt.matchAll(/LISTENING\s+(\d+)/g)].map((m) => m[1]))]
	for (const pid of pids) spawn('taskkill', ['/PID', pid, '/F', '/T'], { windowsHide: true, stdio: 'ignore' })
	console.log('\n已清理探测进程:', pids.join(',') || '(未定位到)')
}
