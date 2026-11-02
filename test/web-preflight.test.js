/**
 * preflight 回收范围的回归：只有「这次调用真的会起 web server」才允许回收旧进程。
 *
 * 背景：旧判定是一行 `argv.some((a) => a === "web")`，凡 argv 里出现 web 就按 3080
 * 去 taskkill。于是这些都会把正在服务的实例杀掉：
 *   - `dsh plugin --profile web add dsh-plugin-message-edit` —— 插件安装器内部就是它，
 *     装完插件页面立刻打不开；
 *   - `dsh web --dump-config` —— 只想导个配置，结果服务被回收；
 *   - `dsh web --help` / `dsh --version` —— 同理。
 * 真起服务的 `dsh web` / `dsh rescue` 仍必须回收，否则 #197 的 EADDRINUSE 会回来。
 *
 * 这里锁死判定表本身；真正 taskkill 的行为由启动 smoke 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DSH_PURGE_PREFLIGHT_NOBOOT = '1'
const { willServeWeb } = await import('../lib/web-preflight-entry.js')

const yes = [
	['dsh web', ['web']],
	['带端口启动', ['web', '--port', '3099', '--no-open']],
	['等号写端口', ['web', '--port=3099']],
	['仅 --profile web', ['--profile', 'web']],
	['等号 --profile=web', ['--profile=web']],
	['rescue 重建后起服务', ['rescue']],
	['rescue 指定模板', ['rescue', '--from-default-profile', 'web']],
	['仅 --profile rescue', ['--profile', 'rescue']],
]

const no = [
	['装插件（本次 bug 的触发命令）', ['plugin', '--profile', 'web', 'add', 'dsh-plugin-message-edit']],
	['装 profile 依赖', ['plugin', '--profile', 'web', 'install']],
	['卸插件', ['plugin', '--profile', 'web', 'remove', 'dsh-plugin-message-edit']],
	['pnpm 透传参数', ['plugin', '--profile', 'web', 'why', 'dsh-plugin-message-edit']],
	['导配置', ['web', '--dump-config']],
	['导默认配置', ['web', '--dump-default-config']],
	['导 schema', ['web', '--dump-config-schema']],
	['导配置带端口', ['web', '--dump-config', '--port', '3080']],
	['等号写 dump', ['web', '--dump-config=true']],
	['看 web 帮助', ['web', '--help']],
	['短帮助', ['web', '-h']],
	['看版本', ['--version']],
	['短版本', ['-V']],
	['headless 不绑 web 端口', ['headless', 'run the tests']],
	['tui 不绑 web 端口', ['tui']],
	['desktop profile', ['--profile', 'desktop']],
	['plugin 帮助', ['plugin', '--help']],
]

for (const [name, argv] of yes) {
	test(`会起服务 → 回收：${name}`, () => {
		assert.equal(willServeWeb(argv), true, `${JSON.stringify(argv)} 应当回收`)
	})
}

for (const [name, argv] of no) {
	test(`不起服务 → 不回收：${name}`, () => {
		assert.equal(willServeWeb(argv), false, `${JSON.stringify(argv)} 不应回收`)
	})
}

test('DSH_PURGE_NO_RECLAIM 由 main 负责，判定函数保持纯函数', () => {
	// willServeWeb 不读环境变量：紧急开关只影响 main，测试里才能稳定断言。
	process.env.DSH_PURGE_NO_RECLAIM = '1'
	try {
		assert.equal(willServeWeb(['web']), true)
	} finally {
		delete process.env.DSH_PURGE_NO_RECLAIM
	}
})
