/**
 * 对照实验：确认「helper 退出后新进程挂掉」的根因就是 stdio 用 pipe。
 *
 * 模拟 dsh web：持续往 stdout 写日志（真实 dsh web 每轮对话/工具调用都会写）。
 *   A. stdio: ["ignore","pipe","pipe"] —— 读端随 helper 退出关闭，预期 EPIPE 崩溃
 *   B. stdio: ["ignore", fd, fd]        —— 落文件，预期继续存活
 *
 * 不碰 3080，只起两个几秒就退的假进程。
 * 用法：node scripts/verify-epipe.mjs
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = path.join(os.tmpdir(), 'dsh-purge-epipe-test')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const SIM = path.join(TMP, 'fake-web.mjs')
fs.writeFileSync(SIM, `
let n = 0
const t = setInterval(() => {
  n += 1
  process.stdout.write('heartbeat ' + n + ' ' + new Date().toISOString() + '\\n')
  if (n >= 60) { clearInterval(t); process.exit(0) }
}, 150)
process.on('uncaughtException', (e) => {
  require('fs').writeFileSync(process.env.CRASH_FILE, 'uncaughtException: ' + e.message)
  process.exit(7)
})
`.replace("require('fs')", "require('node:fs')").replace(/^/, "import { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)\n"))

function wait(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** A：pipe 接法 —— helper 读 1.2 秒后模拟"读到 URL 就退出"。 */
async function runPipe() {
  const crashFile = path.join(TMP, 'crash-pipe.txt')
  const child = spawn(process.execPath, [SIM], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CRASH_FILE: crashFile },
    windowsHide: true,
  })
  let bytes = 0
  child.stdout.on('data', (c) => { bytes += c.length })
  child.stderr.on('data', (c) => { bytes += c.length })
  let code = null
  child.on('exit', (c, s) => { code = { c, s } })

  await wait(1200)
  // 模拟 helper 退出：断开管道读端
  child.stdout.destroy()
  child.stderr.destroy()
  child.stdout.removeAllListeners()
  child.stderr.removeAllListeners()

  // 再等 3 秒：假进程会继续写 stdout
  await wait(3000)
  const crashed = fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8') : ''
  if (code === null) { try { child.kill() } catch { /* ignore */ } }
  return { bytes, code, crashed }
}

/** B：落文件接法 —— 与修好后的 restart-web.js 一致。 */
async function runFile() {
  const out = path.join(TMP, 'out.log')
  const crashFile = path.join(TMP, 'crash-file.txt')
  const fd = fs.openSync(out, 'a')
  const child = spawn(process.execPath, [SIM], {
    stdio: ['ignore', fd, fd],
    env: { ...process.env, CRASH_FILE: crashFile },
    windowsHide: true,
  })
  fs.closeSync(fd)
  let code = null
  child.on('exit', (c, s) => { code = { c, s } })

  await wait(1200)
  // 模拟 helper 退出：什么都不做（没有管道可断）
  await wait(3000)
  const crashed = fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8') : ''
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0
  if (code === null) { try { child.kill() } catch { /* ignore */ } }
  return { size, code, crashed }
}

const a = await runPipe()
const b = await runFile()

console.log('=== A. stdio 用 pipe（修复前）===')
console.log('  读到字节:', a.bytes)
console.log('  进程退出:', a.code ? JSON.stringify(a.code) : '仍未退出')
console.log('  崩溃记录:', a.crashed || '(无)')

console.log('\n=== B. stdio 落文件（修复后）===')
console.log('  日志文件字节:', b.size)
console.log('  进程退出:', b.code ? JSON.stringify(b.code) : '仍未退出（正常存活）')
console.log('  崩溃记录:', b.crashed || '(无)')

console.log('\n=== 结论 ===')
const aSurvived = a.code === null || (a.code.c === 0)
const bSurvived = b.code === null || (b.code.c === 0)
console.log('  pipe 接法存活:', aSurvived ? '是' : `否（exit ${JSON.stringify(a.code)}）`)
console.log('  落文件接法存活:', bSurvived ? '是' : `否（exit ${JSON.stringify(b.code)}）`)
if (bSurvived && b.size > a.bytes) {
  console.log('  ✓ 落文件接法在"父进程退出"后仍能继续写，pipe 接法会中断')
}
