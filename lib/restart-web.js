import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { envForDetachedSpawn, findDshHome } from "./core.js";

/**
 * 过渡期兼容文件（1.1.91）。
 *
 * 自动重启已经下线：`lib/web.js` 的 `scheduleRestart()` 只回一份手动重启说明，
 * 不会再 spawn 这个文件。保留它只有一个原因 —— **用户机器上还跑着旧版内存代码**：
 * 老代码在 apply / 更新 / 点「重启」时仍会 detached 拉起 `lib/restart-web.js`，
 * 然后自己 `process.exit(0)`。文件不在了的话，那次点击就会把 web 弄死且没人拉起。
 *
 * 所以这里只做一件事：等端口释放 → 用 payload 里的 argv 把 `dsh web` 拉回来 → 退出。
 * 不杀进程、不扫端口、不做「交接成功」的判断（那些花样正是 1.1.91 删掉的东西）。
 * 下一版（1.1.92）可以直接删文件。
 */

const LOG_MAX = 64 * 1024;

function logFile() {
	try {
		const dir = path.join(findDshHome(), "dsh-purge");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, "restart.log");
	} catch {
		return path.join(os.tmpdir(), "dsh-purge-restart.log");
	}
}

const LOG_PATH = logFile();

function log(line) {
	const text = `${new Date().toISOString()} [legacy-restart:${process.pid}] ${line}\n`;
	try {
		try {
			if (fs.statSync(LOG_PATH).size > LOG_MAX) fs.writeFileSync(LOG_PATH, "");
		} catch { /* 文件还不存在 */ }
		fs.appendFileSync(LOG_PATH, text);
	} catch { /* ignore */ }
	try { process.stderr.write(text); } catch { /* ignore */ }
}

const encoded = process.env.DSH_PURGE_RESTART;
if (!encoded) process.exit(1);

let info;
try {
	info = JSON.parse(encoded);
} catch {
	process.exit(1);
}

const port = Number(info.port) || 3080;
const host = typeof info.host === "string" && info.host ? info.host : "127.0.0.1";
log(`兼容垫片启动：旧版宿主触发了自动重启；port=${port} argv=${JSON.stringify(info.argv)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portFree() {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host, port }, () => {
			socket.destroy();
			resolve(false);
		});
		socket.on("error", () => resolve(true));
	});
}

async function waitFree(timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await portFree()) return true;
		await sleep(150);
	}
	return false;
}

const free = await waitFree(15000);
if (!free) {
	log(`端口 ${port} 一直不释放，放弃拉起（旧 server 可能还活着）`);
	process.exit(1);
}

if (!info.execPath || !Array.isArray(info.argv) || !info.argv.length) {
	log("payload 缺 execPath/argv，无法拉起");
	process.exit(1);
}

let outFd = null;
try { outFd = fs.openSync(path.join(path.dirname(LOG_PATH), "web-stdout.log"), "a"); } catch { outFd = null; }

try {
	const child = spawn(info.execPath, info.argv, {
		detached: true,
		stdio: ["ignore", outFd ?? "ignore", outFd ?? "ignore"],
		cwd: info.cwd || process.cwd(),
		env: envForDetachedSpawn(),
		windowsHide: true,
		shell: false,
	});
	if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
	log(`已拉起 dsh web pid=${child.pid}；以后请手动重启（关掉窗口再执行 dsh web）`);
	child.unref();
} catch (e) {
	if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
	log(`拉起失败：${e && e.message}`);
	process.exit(1);
}

await sleep(400);
process.exit(0);
