// 宿主快照 / 回滚：apply 会改宿主里几十个文件，逐条 revert 只能撤补丁，
// 撤不掉「被人手改过」「被别的插件动过」的现场。这里按文件做整树快照。
//
// 目录：$DSH_HOME/dsh-purge/snapshots/<id>/
//   manifest.json   { id, createdAt, host, aiBase, label, files:[{rel, size, sha256}] }
//   files/<rel>     原文件内容（相对 aiBase 的路径）
//
// 只快照 targetFiles() 里的宿主文件（不是整个 node_modules），默认保留 5 份。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { targetFiles } from "./core.js";
import { atomicWriteSync } from "./atomic-files.js";
import { removeTreeNoFollowSync } from "./remove-tree.js";

export const SNAPSHOT_KEEP = 5;
const MAX_FILES = 400;
const MAX_BYTES = 64 * 1024 * 1024;

function dshHomeOf(explicit) {
	const home = String(explicit || process.env.DSH_HOME || "").trim();
	return home || path.join(os.homedir(), ".dsh");
}

export function snapshotsRoot(dshHome) {
	return path.join(dshHomeOf(dshHome), "dsh-purge", "snapshots");
}

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

function newId() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString("hex")}`;
}

function allTargetPaths(aiBase) {
	const files = targetFiles(aiBase);
	const out = [];
	for (const v of Object.values(files)) {
		for (const fp of Array.isArray(v) ? v : [v]) if (fp && !out.includes(fp)) out.push(fp);
	}
	return out;
}

function isInside(root, fp) {
	const rel = path.relative(root, fp);
	return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 创建快照。返回 { ok, id, files, bytes, dir } 或 { ok:false, error }。
 */
export function createSnapshot(aiBase, options = {}) {
	const home = dshHomeOf(options.dshHome);
	if (!aiBase || !fs.existsSync(aiBase)) return { ok: false, error: "找不到宿主目录" };
	const id = options.id || newId();
	const dir = path.join(snapshotsRoot(home), id);
	const root = path.resolve(aiBase);
	const files = [];
	let bytes = 0;
	/* 默认快照 targetFiles() 的整组宿主文件；测试/定向场景可以传 paths 只快照指定文件。 */
	const candidates = Array.isArray(options.paths) && options.paths.length
		? options.paths.map((p) => path.resolve(p))
		: allTargetPaths(root);
	for (const fp of candidates) {
		if (files.length >= MAX_FILES) break;
		let buf;
		try {
			buf = fs.readFileSync(fp);
		} catch {
			continue;
		}
		if (!isInside(root, path.resolve(fp))) continue;
		if (bytes + buf.length > MAX_BYTES) break;
		const rel = path.relative(root, path.resolve(fp));
		const dest = path.join(dir, "files", rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
		fs.writeFileSync(dest, buf);
		files.push({ rel, size: buf.length, sha256: sha256(buf) });
		bytes += buf.length;
	}
	if (!files.length) return { ok: false, error: "没有可快照的宿主文件（补丁还没定位到宿主？）" };
	const manifest = {
		id,
		createdAt: new Date().toISOString(),
		label: String(options.label || ""),
		host: String(options.host || ""),
		aiBase: root,
		files,
		bytes,
	};
	fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	return { ok: true, id, files: files.length, bytes, dir };
}

export function readManifest(dirOrId, dshHome) {
	const dir = path.isAbsolute(dirOrId) ? dirOrId : path.join(snapshotsRoot(dshHome), String(dirOrId));
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
		return { manifest, dir };
	} catch {
		return null;
	}
}

export function listSnapshots(dshHome) {
	const root = snapshotsRoot(dshHome);
	let entries = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const out = [];
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const hit = readManifest(e.name, dshHome);
		if (!hit) continue;
		out.push({
			id: hit.manifest.id,
			createdAt: hit.manifest.createdAt,
			label: hit.manifest.label,
			host: hit.manifest.host,
			files: (hit.manifest.files || []).length,
			bytes: hit.manifest.bytes || 0,
			dir: hit.dir,
		});
	}
	out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
	return out;
}

/**
 * 回滚到某个快照（id 省略 = 最新）。逐个文件校验再原子替换。
 * 返回 { ok, restored, skipped, errors }。
 */
export function restoreSnapshot(aiBase, id, options = {}) {
	const home = dshHomeOf(options.dshHome);
	const list = listSnapshots(home);
	if (!list.length) return { ok: false, error: "没有任何快照" };
	const target = id ? list.find((s) => s.id === String(id)) : list[0];
	if (!target) return { ok: false, error: `找不到快照 ${id}` };
	const hit = readManifest(target.dir, home);
	if (!hit) return { ok: false, error: "快照清单损坏" };
	const manifest = hit.manifest;
	const root = path.resolve(aiBase || manifest.aiBase || "");
	if (!root || !fs.existsSync(root)) return { ok: false, error: "找不到宿主目录" };

	const restored = [];
	const skipped = [];
	const errors = [];
	for (const f of manifest.files || []) {
		const src = path.join(hit.dir, "files", f.rel);
		const dest = path.join(root, f.rel);
		if (!isInside(root, path.resolve(dest))) {
			skipped.push({ rel: f.rel, reason: "越出宿主目录" });
			continue;
		}
		let buf;
		try {
			buf = fs.readFileSync(src);
		} catch (e) {
			errors.push({ rel: f.rel, error: `读快照失败: ${e.message}` });
			continue;
		}
		if (sha256(buf) !== f.sha256) {
			errors.push({ rel: f.rel, error: "快照内容校验失败（sha256 不匹配）" });
			continue;
		}
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			// 原子替换：tmp + rename 退避（目标被宿主/面板拿着句柄时不再一次失败就作废）。
			atomicWriteSync(dest, buf);
			restored.push(f.rel);
		} catch (e) {
			errors.push({ rel: f.rel, error: `写入失败: ${e.message}` });
		}
	}
	return { ok: errors.length === 0, id: target.id, restored: restored.length, skipped, errors };
}

/** 只保留最新 keep 份。返回被删掉的 id 列表。 */
export function pruneSnapshots(dshHome, keep = SNAPSHOT_KEEP) {
	const list = listSnapshots(dshHome);
	const drop = list.slice(Math.max(0, keep));
	for (const s of drop) {
		try {
			// 快照目录里可能留着手工放的 junction/符号链接：只删链接本身，树外目标不动。
			removeTreeNoFollowSync(s.dir, { fs, maxRetries: 2, retryDelay: 80 });
		} catch {
			/* 删不掉就留着 */
		}
	}
	return drop.map((s) => s.id);
}
