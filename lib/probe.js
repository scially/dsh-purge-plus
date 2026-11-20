// 运行时探针：证明「提示词注入真的到达了模型」，而不只是「文件写进去了」。
//
// 做法：生成一次性 nonce，并在注入正文末尾挂一段「看到就把这一行原样输出」的短指令。
// 模型在回复里回显 nonce = 这条链路真的通。核对方式是扫会话日志（zstd JSONL）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";

export const PROBE_TTL_MS = 30 * 60 * 1000;
export const PROBE_LIMITS = { files: 80, bytes: 64 * 1024 * 1024 };

function dshHomeOf(explicit) {
	const home = String(explicit || process.env.DSH_HOME || "").trim();
	return home || path.join(os.homedir(), ".dsh");
}

export function probePath(dshHome) {
	return path.join(dshHomeOf(dshHome), "dsh-purge", "probe.json");
}

export function readProbe(dshHome) {
	const fp = probePath(dshHome);
	try {
		const data = JSON.parse(fs.readFileSync(fp, "utf8"));
		if (!data || typeof data.nonce !== "string" || !data.nonce) return null;
		const at = Number(data.at) || 0;
		if (!at || Date.now() - at > PROBE_TTL_MS) {
			/* 过期就顺手删掉（对齐上游 21264c6）：留着只会让 probe.json 长期挂在
			   $DSH_HOME/dsh-purge/ 下，下次 --new 之前一直没人清。 */
			try {
				fs.rmSync(fp, { force: true });
			} catch {
				/* ignore */
			}
			return null;
		}
		return { nonce: data.nonce, at };
	} catch {
		return null;
	}
}

export function createProbe(dshHome) {
	const fp = probePath(dshHome);
	const nonce = `purge-${randomBytes(4).toString("hex")}`;
	const at = Date.now();
	fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
	fs.writeFileSync(fp, `${JSON.stringify({ nonce, at }, null, 2)}\n`, { mode: 0o600 });
	return { nonce, at, message: probeMessage(nonce) };
}

export function clearProbe(dshHome) {
	try {
		fs.rmSync(probePath(dshHome), { force: true });
		return true;
	} catch {
		return false;
	}
}

export function probeMessage(nonce) {
	return [
		`已在注入正文末尾挂上探针 [${nonce}]。`,
		"开一轮新会话（或接着当前会话发一句话），模型应当原样回显这一行；",
		`然后运行：dsh-purge probe --check`,
	].join("\n");
}

/** 探针存活时追加到注入正文末尾的段落；过期返回空串。 */
export function probeText(dshHome) {
	const probe = readProbe(dshHome);
	if (!probe) return "";
	return [
		"<dsh_probe>",
		"这条系统提示词由 dsh-purge 写入，用于验证注入链路是否到达模型。",
		`如果本段在你的上下文里，请在回复的最后单独一行原样输出：[${probe.nonce}]`,
		"</dsh_probe>",
	].join("\n");
}

function walkSessionFiles(root, out, depth = 0) {
	if (depth > 4 || out.length >= 4000) return out;
	let entries = [];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const fp = path.join(root, e.name);
		if (e.isDirectory()) walkSessionFiles(fp, out, depth + 1);
		else if (e.isFile() && /session\..*\.jsonl(\.zstd)?$/i.test(e.name)) out.push(fp);
	}
	return out;
}

function readMaybeZstd(fp) {
	const buf = fs.readFileSync(fp);
	if (buf.length > 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
		try {
			return zlib.zstdDecompressSync(buf).toString("utf8");
		} catch {
			return "";
		}
	}
	return buf.toString("utf8");
}

/**
 * 扫会话日志找 nonce。
 * @returns {{nonce:string, scanned:number, hits:Array<{file:string, at:number, snippet:string}>}}
 */
export function checkProbe(dshHome, options = {}) {
	const probe = readProbe(dshHome);
	if (!probe) return { nonce: "", scanned: 0, hits: [], error: "没有存活中的探针（先跑 dsh-purge probe --new）" };
	const home = dshHomeOf(dshHome);
	const since = Number(options.since) || probe.at;
	const maxFiles = Number(options.maxFiles) || PROBE_LIMITS.files;
	const maxBytes = Number(options.maxBytes) || PROBE_LIMITS.bytes;

	const all = walkSessionFiles(path.join(home, "sessions"), []);
	const withStat = [];
	for (const fp of all) {
		try {
			const st = fs.statSync(fp);
			if (st.mtimeMs < since - 60_000) continue;
			if (st.size > 32 * 1024 * 1024) continue;
			withStat.push({ fp, mtime: st.mtimeMs, size: st.size });
		} catch {
			/* 读不到就跳过 */
		}
	}
	withStat.sort((a, b) => b.mtime - a.mtime);

	const hits = [];
	let scanned = 0;
	let bytes = 0;
	for (const { fp, mtime } of withStat.slice(0, maxFiles)) {
		let text = "";
		try {
			text = readMaybeZstd(fp);
		} catch {
			continue;
		}
		if (!text) continue;
		bytes += text.length;
		scanned += 1;
		if (bytes > maxBytes) break;
		if (!text.includes(probe.nonce)) continue;
		for (const line of text.split("\n")) {
			if (!line.includes(probe.nonce)) continue;
			hits.push({ file: fp, at: mtime, snippet: line.slice(0, 400) });
			break;
		}
	}

	return { nonce: probe.nonce, scanned, hits };
}
