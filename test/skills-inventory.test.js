// 红队技能库必须**随包发布**：23 个技能文件 + 合法 frontmatter + 被 package.json#files 收进 tarball。
//
// 背景：合入上游主线时把 skills/ 丢了（只活在旧 tag v1.3.1–v1.4.4 与已装机器的
// $DSH_HOME/redteam/skills 里），新机器装完会「技能库」全缺 —— 这条测试把它钉住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const skillsDir = path.join(repo, "skills", "redteam");

function skillFiles() {
	return fs.readdirSync(skillsDir).filter((f) => f.endsWith(".md")).sort();
}

function frontmatter(text) {
	const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return null;
	const out = {};
	for (const line of m[1].split(/\r?\n/)) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return out;
}

test("技能库：23 个技能都在，frontmatter 合法且 name 与文件名一致", () => {
	const files = skillFiles();
	assert.equal(files.length, 23, `技能文件数应为 23，实际 ${files.length}`);
	const names = new Set();
	for (const file of files) {
		const fm = frontmatter(fs.readFileSync(path.join(skillsDir, file), "utf8"));
		assert.ok(fm, `${file} 缺 frontmatter`);
		const base = file.replace(/\.md$/, "");
		assert.equal(fm.name, base, `${file} 的 name 字段与文件名不一致`);
		assert.ok(fm.description && fm.description.length > 10, `${file} 的 description 太短`);
		assert.ok(fm.whenToUse, `${file} 缺 whenToUse`);
		assert.ok(fm.role, `${file} 缺 role`);
		assert.equal(fm.enabled, "true", `${file} 未 enabled`);
		names.add(base);
	}
	// 老版本里存在、现在不该再出现的幽灵技能（只在 skill-fixes.js 里留了修复文案）
	for (const ghost of ["campaign-planning", "deepseek-web-intel", "score-coverage", "specialist-paths"]) {
		assert.equal(names.has(ghost), false, `${ghost} 既没有技能文件，也不该被当成已交付技能`);
	}
});

test("技能库：package.json#files 收进了 skills（否则 npm 包/一键安装拿不到）", async () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
	assert.ok(Array.isArray(pkg.files), "package.json 应有 files 字段");
	assert.ok(pkg.files.includes("skills"), "files 字段缺少 skills/");
	// 技能目录里的每个文件都应能被 files 规则覆盖（skills 整目录在列即可）
	assert.ok(!pkg.files.some((f) => f.startsWith("!skills")), "不该用否定规则把 skills 排除");
});

test("技能库：技能名与配件表（skill-fixes/store-core）之间没有单边引用", async () => {
	const names = new Set(skillFiles().map((f) => f.replace(/\.md$/, "")));
	const fixes = fs.readFileSync(path.join(repo, "lib", "redteam", "skill-fixes.js"), "utf8");
	const i = fixes.indexOf("const SKILL_FIXES = {");
	const j = fixes.indexOf("\n};", i);
	const keys = [...fixes.slice(i, j).matchAll(/^\s{2}'([^']+)':/gm)].map((m) => m[1]);
	// 反向：每个技能都要有修复文案（缺了面板只能给泛化建议，不算错但值得知道）
	const missingFixes = [...names].filter((n) => !keys.includes(n));
	assert.deepEqual(missingFixes, [], `这些技能没有专属修复文案：${missingFixes.join(", ")}`);
});
