#!/usr/bin/env node
/**
 * 本地与 CI 共用的一道闸：编译检查 → 模块图 → 构建一致性 → 打包产物。
 *
 *   node scripts/ci-verify.mjs            全跑（与 `npm run verify` 的前半段等价）
 *   node scripts/ci-verify.mjs syntax     逐文件 node --check（parse 层，等于「能不能编译」）
 *   node scripts/ci-verify.mjs link       真 import 一遍每个入口（模块图 / 导出名连得起来）
 *   node scripts/ci-verify.mjs build      重跑 build:client，断言没有额外写盘（产物与源码一致）
 *   node scripts/ci-verify.mjs pack       npm pack --dry-run 的产物文件表 + 版本一致性
 *
 * 任一步失败 → 退出码 1，多余输出留在上面。全部只读，除了 build 那步会重跑两个
 * 幂等脚本（它们本来就该零写入；真写了就是源码与产物不同步，正是要抓的东西）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STEPS = ["syntax", "link", "build", "pack"];

/* 不进语法扫描的目录：第三方、版本库、外部下载、本地草稿。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".scratch", "_archive", "toolkit"]);
const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs"]);

const failures = [];
let step = "";

function fail(msg) {
	failures.push(`${step}: ${msg}`);
	console.log(`  FAIL ${msg}`);
}

function ok(msg) {
	console.log(`  ok   ${msg}`);
}

function skip(msg) {
	console.log(`  skip ${msg}`);
}

/* ------------------------------------------------------------------ helpers */

function runNode(args, options = {}) {
	return spawnSync(process.execPath, args, {
		cwd: root,
		encoding: "utf8",
		timeout: options.timeout ?? 120000,
	});
}

/** npm 的可执行入口：npm 脚本里跑就用 npm_execpath，否则退回 PATH 上的 npm。 */
function runNpm(args) {
	const execpath = String(process.env.npm_execpath || "").trim();
	if (execpath && fs.existsSync(execpath)) {
		return spawnSync(process.execPath, [execpath, ...args], { cwd: root, encoding: "utf8", timeout: 300000 });
	}
	return spawnSync("npm", args, { cwd: root, encoding: "utf8", timeout: 300000, shell: process.platform === "win32" });
}

function walk(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isSymbolicLink()) continue;
		const fp = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(fp, out);
			continue;
		}
		if (!entry.isFile()) continue;
		if (entry.name.endsWith(".bak")) continue;
		if (SCRIPT_EXT.has(path.extname(entry.name))) out.push(fp);
	}
	return out;
}

const rel = (fp) => path.relative(root, fp).replace(/\\/g, "/");

function gitAvailable() {
	const r = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
	return r.status === 0 && String(r.stdout).trim() === "true";
}

function gitStatusPorcelain() {
	const r = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
	if (r.status !== 0) return null;
	return String(r.stdout || "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

/* -------------------------------------------------------------------- steps */

/** parse 层：每个 JS 文件都过一遍 node --check。 */
function stepSyntax() {
	const files = walk(root).sort();
	const bad = [];
	for (const fp of files) {
		const r = runNode(["--check", fp], { timeout: 60000 });
		if (r.status !== 0) bad.push({ file: rel(fp), out: `${r.stdout || ""}${r.stderr || ""}`.trim() });
	}
	if (bad.length) {
		for (const b of bad) fail(`${b.file}\n${b.out.split("\n").slice(0, 6).join("\n")}`);
		return false;
	}
	ok(`${files.length} 个 JS/MJS 文件全部通过 node --check`);
	return true;
}

/** 包装层：package.json 声明的入口 + 核心模块真的 import 一遍。 */
const LINK_EXTRA = [
	"lib/core.js",
	"lib/diagnose.js",
	"lib/desktop.js",
	"lib/host-variants.js",
	"lib/identity.js",
	"lib/maintenance.js",
	"lib/refusal-retry.js",
	"lib/skills.js",
	"lib/snapshot.js",
	"lib/update.js",
];

/* 浏览器产物：`exports["./client"]` 指向它，顶层就要 window/document。
   它在 test/settings-section.test.js 里用 DOM 桩真加载过一遍，这里不重复。 */
const LINK_BROWSER = new Set(["client.js"]);

function entryPoints() {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	const wanted = new Set();
	const add = (v) => {
		if (typeof v === "string" && (v.endsWith(".js") || v.endsWith(".mjs"))) {
			const clean = v.replace(/^\.\//, "");
			if (clean !== "package.json" && !LINK_BROWSER.has(clean)) wanted.add(clean);
		}
	};
	add(pkg.main);
	for (const v of Object.values(pkg.exports ?? {})) {
		if (typeof v === "string") add(v);
		else if (v && typeof v === "object") for (const s of Object.values(v)) add(s);
	}
	for (const rel of LINK_EXTRA) wanted.add(rel);
	return [...wanted].sort();
}

/** 宿主侧依赖（@deepseek-ai/*）在裸仓库里本来就没有，命中即跳过，不算失败。 */
function needsHost(err) {
	const msg = `${err?.message ?? err}`;
	return /cannot resolve @deepseek-ai\/|Cannot find package '@deepseek-ai\//.test(msg);
}

async function stepLink() {
	const base = failures.length;
	const entries = entryPoints();
	let linked = 0;
	let skipped = 0;
	for (const rel of entries) {
		const fp = path.join(root, rel);
		if (!fs.existsSync(fp)) {
			fail(`${rel} 在 package.json 里声明了，但文件不存在`);
			continue;
		}
		try {
			await import(pathToFileURL(fp).href);
			linked += 1;
		} catch (err) {
			if (needsHost(err)) {
				skipped += 1;
				console.log(`  ..   ${rel}（需要宿主的 @deepseek-ai/* 依赖，跳过）`);
				continue;
			}
			fail(`${rel} import 失败: ${err?.message ?? err}`);
		}
	}
	for (const browser of LINK_BROWSER) {
		if (fs.existsSync(path.join(root, browser))) console.log(`  ..   ${browser}（浏览器产物，由 test/settings-section.test.js 覆盖）`);
	}
	if (failures.length > base) return false;
	ok(`${linked} 个入口 import 成功${skipped ? `，${skipped} 个依赖宿主跳过` : ""}`);
	return true;
}

/** 跑一个构建脚本，失败即报错；返回是否成功。 */
function runBuildScript(script) {
	const r = runNode([script], { timeout: 180000 });
	const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
	if (r.status !== 0) {
		fail(`${script} 退出码 ${r.status}\n${out.split("\n").slice(0, 8).join("\n")}`);
		return false;
	}
	if (out) console.log(`  ..   ${script}: ${out.split("\n").pop()}`);
	return true;
}

/** 本轮相对上一轮的「新脏」已跟踪文件（?? 未跟踪不算）。 */
function newlyDirty(before, after) {
	const seen = new Set(before ?? []);
	return (after ?? []).filter((line) => !seen.has(line) && !line.startsWith("??"));
}

/**
 * 构建层：重跑两个幂等脚本。
 *   1) 第一轮相对命令开始前的 git 状态比对 —— 脏了就说明 client.js（或设置块）与源码不同步；
 *   2) 第二轮相对第一轮的比对 —— 再脏说明构建不幂等。
 */
function stepBuild() {
	const tracked = gitAvailable();
	if (!tracked) skip("不是 git 工作树，只跑构建，不比对写盘");
	const baseline = tracked ? gitStatusPorcelain() : null;

	for (const script of ["scripts/build-client.mjs", "scripts/patch-settings-ui.mjs"]) {
		if (!runBuildScript(script)) return false;
	}
	if (!tracked) return true;

	const afterFirst = gitStatusPorcelain();
	const drifted = newlyDirty(baseline, afterFirst);
	if (drifted.length) {
		fail(`构建改写了已跟踪文件 —— 产物与源码不同步，把重建结果一起提交：\n${drifted.join("\n")}`);
		return false;
	}
	if (!runBuildScript("scripts/build-client.mjs")) return false;
	const afterSecond = gitStatusPorcelain();
	const unstable = newlyDirty(afterFirst, afterSecond);
	if (unstable.length) {
		fail(`重复构建又写了盘 —— 构建不幂等：\n${unstable.join("\n")}`);
		return false;
	}
	ok("client.js 与 lib/redteam/client.js 一致，重复构建零写入");
	return true;
}

const PACK_REQUIRED = [
	"package.json",
	"client.js",
	"cordis.patch.yml",
	"lib/index.js",
	"lib/core.js",
	"lib/redteam/client.js",
	"bin/dsh-purge.js",
	"README.md",
	"LICENSE",
	"NOTICE",
];

const PACK_FORBIDDEN = [
	"lib/default-prompt-inject.md",
	"test/",
	".github/",
	"toolkit/",
];

/** 打包层：产物文件表 + release-notes 首行与版本号一致（发布脚本会硬校验这一条）。 */
function stepPack() {
	const base = failures.length;
	const r = runNpm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
	if (r.error && r.error.code === "ENOENT") {
		skip("找不到 npm，跳过打包检查");
		return true;
	}
	if (r.error) {
		fail(`npm pack 跑不起来: ${r.error.message}`);
		return false;
	}
	const out = String(r.stdout || "").trim();
	if (r.status !== 0 || !out.startsWith("[")) {
		fail(`npm pack --dry-run 失败（退出码 ${r.status}）\n${`${r.stdout || ""}${r.stderr || ""}`.trim().split("\n").slice(0, 8).join("\n")}`);
		return false;
	}
	let info;
	try {
		info = JSON.parse(out)[0];
	} catch (err) {
		fail(`npm pack --json 输出解析失败: ${err.message}`);
		return false;
	}
	const paths = new Set((info.files ?? []).map((f) => String(f.path)));
	for (const want of PACK_REQUIRED) {
		if (!paths.has(want)) fail(`产物缺少 ${want}`);
	}
	for (const bad of PACK_FORBIDDEN) {
		const hit = [...paths].find((p) => p === bad || p.startsWith(`${bad}`));
		if (hit) fail(`产物不该包含 ${hit}（检查 .npmignore / files）`);
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	if (info.filename !== `${pkg.name}-${pkg.version}.tgz`) {
		fail(`产物名 ${info.filename} 与 package.json 的 ${pkg.name}@${pkg.version} 对不上`);
	}
	const notes = fs.readFileSync(path.join(root, "release-notes.md"), "utf8").split(/\r?\n/)[0]?.trim();
	if (notes !== `# ${pkg.version}`) {
		fail(`release-notes.md 首行必须是 "# ${pkg.version}"，现在是 "${notes}"`);
	}
	if (failures.length > base) return false;
	ok(`${paths.size} 个文件，${info.filename}（${(info.size / 1024).toFixed(0)} KB），release-notes 与版本一致`);
	return true;
}

/* --------------------------------------------------------------------- main */

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const steps = wanted.length ? wanted : STEPS;
for (const name of steps) {
	if (!STEPS.includes(name)) {
		console.error(`未知步骤: ${name}（可选 ${STEPS.join(" / ")}）`);
		process.exit(2);
	}
}

console.log(`dsh-purge ci-verify  root=${root}  node=${process.version}`);
for (const name of steps) {
	step = name;
	console.log(`\n[${name}]`);
	if (name === "syntax") stepSyntax();
	else if (name === "link") await stepLink();
	else if (name === "build") stepBuild();
	else if (name === "pack") stepPack();
}

console.log("");
if (failures.length) {
	console.log(`失败 ${failures.length} 项：`);
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
console.log(`全部通过（${steps.join(" / ")}）`);
