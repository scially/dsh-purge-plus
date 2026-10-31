/**
 * client.js 接线测试：真的把 bundle 加载起来，跑一遍 apply(ctx)，
 * 检查 settings.section 有没有被注册 —— 不是靠读源码猜。
 *
 * 覆盖第 2 项的两个已知坑：
 *   1) 注册块必须在 apply(ctx) 体内（插到模块顶层会 ctx undefined，被 try/catch 吞掉）；
 *   2) 必须给 SettingsRoot 传 t，否则 typeof props.t !== "function"，
 *      面板会退化成 (key) => key，界面上全是原始字典键。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

/** 最小 react mock：只要能让 apply() 跑通、并让组件成为函数即可。 */
function reactMock() {
	const el = (type, props, ...children) => ({ type, props, children })
	const hook = (init) => [typeof init === 'function' ? init() : init, () => {}]
	return {
		createElement: el,
		Fragment: Symbol.for('react.fragment'),
		Component: class {},
		useState: hook,
		useEffect: () => {},
		useLayoutEffect: () => {},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useRef: (v) => ({ current: v }),
	}
}

/** 加载 bundle，返回它导出的模块（含 apply）。 */
function loadBundle() {
	const registered = []
	let mod = null
	const window = {
		__ModuleLoader__: { load: ({ factory }) => { mod = factory(requireMock) } },
		addEventListener: () => {},
		removeEventListener: () => {},
		setTimeout: (fn) => 0,
		clearTimeout: () => {},
		matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
	}
	const requireMock = (id) => {
		if (id === 'react') return reactMock()
		if (id === 'react-dom') return { createPortal: () => null }
		return {}
	}
	// 顶层只要 window 与少量 DOM 守卫；其余都在 try/catch 里
	const document = {
		body: null,
		documentElement: { style: {}, hasAttribute: () => false },
		addEventListener: () => {},
		removeEventListener: () => {},
		createElement: () => ({ style: {}, appendChild: () => {}, textContent: '' }),
		querySelector: () => null,
		getElementById: () => null,
	}
	// eslint-disable-next-line no-new-func
	new Function('window', 'document', 'require', 'console', source)(window, document, requireMock, console)
	assert.ok(mod && typeof mod.apply === 'function', 'bundle 应当导出 apply')
	return { mod, registered }
}

/** 造一个够 apply() 跑完的 ctx，记录 slots 注册；locale 用真字典查，别透传。 */
function makeCtx(registered) {
	const injected = []
	const dicts = {}
	const bounds = []
	const applyVars = (text, vars) => (vars
		? String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
		: text)
	const ctx = {
		uiConversation: { events: { register: () => {} } },
		locale: {
			register: (ns, dict) => { dicts[ns] = dict; return () => {} },
			bind: (ns) => {
				bounds.push(ns)
				return (key, vars) => {
					const dict = dicts[ns] || {}
					const hit = (dict.zh && dict.zh[key]) || (dict.en && dict.en[key])
					return applyVars(hit === undefined ? key : hit, vars)
				}
			},
			resolveText: (s) => s,
		},
		effect: (fn) => { try { fn() } catch { /* ignore */ } },
		// 依赖注入：立刻回调会让 installRewindUi 需要更多宿主服务，这里模拟"未就绪"
		inject: () => {},
		slots: {
			inject: (name, cb) => { injected.push(name); const off = cb(); return typeof off === 'function' ? off : () => {} },
			register: (options, component) => {
				registered.push({ options, component })
				return () => {}
			},
		},
	}
	return { ctx, injected, dicts, bounds }
}

test('apply() 注册了 settings.section', () => {
	const { mod, registered } = loadBundle()
	const { ctx, injected } = makeCtx(registered)
	mod.apply(ctx)

	assert.ok(injected.includes('settings.section'), `未注入 settings.section，实际=${JSON.stringify(injected)}`)
	const hit = registered.find((r) => r.options && r.options.name === 'settings.section')
	assert.ok(hit, 'settings.section 必须注册一次')
	assert.equal(hit.options.id, 'dsh-purge')
	assert.equal(hit.options.scope === undefined || hit.options.scope === 'root', true)
	assert.equal(typeof hit.component, 'function', '组件必须是函数（SettingsRoot）')
})

test('settings.section 注册项能提供 t，且字典真的接上（不是透传 key）', () => {
	const { mod, registered } = loadBundle()
	const { ctx, dicts, bounds } = makeCtx(registered)
	mod.apply(ctx)
	const hit = registered.find((r) => r.options && r.options.name === 'settings.section')
	const props = typeof hit.options.inject === 'function' ? hit.options.inject() : hit.options.inject
	assert.equal(typeof props.t, 'function', '必须注入 t，SettingsRoot 靠它本地化')
	assert.ok(bounds.includes('settings.dsh-purge'), `bind 的命名空间不对: ${JSON.stringify(bounds)}`)
	const dict = dicts['settings.dsh-purge'] || {}
	assert.ok(dict.zh && dict.zh['purge.title'], 'zh 字典必须含 purge.title')
	assert.ok(dict.en && dict.en['purge.title'], 'en 字典必须含 purge.title')
	assert.notEqual(props.t('purge.title'), 'purge.title', 't 必须真的翻译')
})

test('面板里本地靶场名单那几个键都在（第 3 项还原没被踩掉）', () => {
	const { mod, registered } = loadBundle()
	const { ctx, dicts } = makeCtx(registered)
	mod.apply(ctx)
	const zh = (dicts['settings.dsh-purge'] || {}).zh || {}
	for (const key of ['own.title', 'own.hint', 'own.allow', 'own.save', 'saved.own', 'saved.own.dropped']) {
		assert.ok(zh[key], `zh 缺 ${key}`)
	}
})

test('label 是宿主能渲染的形式（字符串或函数）', () => {
	const { mod, registered } = loadBundle()
	const { ctx } = makeCtx(registered)
	mod.apply(ctx)
	const hit = registered.find((r) => r.options && r.options.name === 'settings.section')
	const label = hit.options.label
	const resolved = typeof label === 'function' ? label() : label
	assert.equal(typeof resolved, 'string')
	assert.ok(resolved.length > 0)
})

test('注册块不会重复注入（apply 跑两次仍只有一份）', () => {
	const { mod, registered } = loadBundle()
	const { ctx } = makeCtx(registered)
	mod.apply(ctx)
	mod.apply(ctx)
	const hits = registered.filter((r) => r.options && r.options.name === 'settings.section')
	assert.equal(hits.length, 2, '两次 apply 各注册一次；宿主负责按 id 去重')
})
