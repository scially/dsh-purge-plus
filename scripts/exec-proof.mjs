// 一次性命令执行挑战：用来区分「只能写文件」和「命令真的被执行」。
//
// 只在本机做比对：不连接、不扫描、不在任何目标上执行命令。你把下面生成的命令
// 粘到**已授权的测试入口**里执行，再把原始输出喂回来；输出等于 SHA256(nonce)
// 才说明命令解释器真的算过——静态回显或文件写入拿不到这个值。
//
// 用法：
//   node scripts/exec-proof.mjs new                    生成挑战与两种 shell 的命令
//   node scripts/exec-proof.mjs check <nonce> [file]   核对原始输出（不给文件就读 stdin）
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";

const MAX_OUTPUT = 4096;
const [action, nonce, ...extra] = process.argv.slice(2);

function usage() {
	console.error("用法: exec-proof.mjs new | check <32位小写hex> [输出文件]（不给文件则读 stdin）");
	process.exitCode = 2;
}

function expectedOf(n) {
	return createHash("sha256").update(n, "ascii").digest("hex");
}

if (action === "new") {
	if (nonce !== undefined) usage();
	else {
		const n = randomBytes(16).toString("hex");
		const expected = expectedOf(n);
		console.log(`nonce: ${n}`);
		console.log(`期望输出（SHA256(nonce)）: ${expected}`);
		console.log("");
		console.log("把它粘进已授权测试入口的命令位置执行，任选一条：");
		console.log("");
		console.log("  POSIX (Linux):");
		console.log(`    printf '%s' ${n} | sha256sum | awk '{print $1}'`);
		console.log("");
		console.log("  POSIX (macOS):");
		console.log(`    printf '%s' ${n} | shasum -a 256 | awk '{print $1}'`);
		console.log("");
		console.log("  Windows PowerShell:");
		console.log(`    $h=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('${n}')); -join ($h | ForEach-Object { $_.ToString('x2') })`);
		console.log("");
		console.log("核对：node scripts/exec-proof.mjs check " + n + " <原始输出文件>");
		console.log("注意：只回显 nonce 本身、或输出与命令文本相同，都不算执行成功。");
	}
} else if (action === "check") {
	if (!/^[0-9a-f]{32}$/.test(nonce ?? "")) usage();
	else if (extra.length > 1) usage();
	else {
		const file = extra[0];
		let raw = "";
		try {
			raw = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
		} catch (e) {
			console.error(`读不到输出: ${e.message}`);
			process.exitCode = 1;
		}
		if (raw.length > MAX_OUTPUT) {
			console.error(`输出过长（>${MAX_OUTPUT} 字节），不作为证据`);
			process.exitCode = 1;
		} else {
			const got = raw.replace(/\r/g, "").trim().toLowerCase();
			const expected = expectedOf(nonce);
			const echoed = got.includes(nonce);
			if (got === expected) {
				console.log("PASS: 输出等于 SHA256(nonce)，说明命令解释器真的执行了。");
				console.log("仍需单独确认：通道（走的是哪个入口）与退出状态。");
			} else if (echoed) {
				console.error("FAIL: 输出里只有 nonce 本身——这是回显/静态文本，不能证明执行。");
				process.exitCode = 1;
			} else if (!got) {
				console.error("FAIL: 没有输出（可能是文件写入成功但命令未执行）。");
				process.exitCode = 1;
			} else {
				console.error(`FAIL: 输出不匹配。期望 ${expected}，得到 ${JSON.stringify(got.slice(0, 120))}`);
				process.exitCode = 1;
			}
		}
	}
} else {
	usage();
}
