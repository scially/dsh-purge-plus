// probe.js：过期探针在读取时顺手删除（对齐上游 21264c6），
// 免得 probe.json 一直挂在 $DSH_HOME/dsh-purge/ 下没人清。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const probe = await import(pathToFileURL(path.join(repo, "lib/probe.js")).href);

test("probe: 存活探针可读，过期探针读取时被删除", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-probe-"));
	try {
		const created = probe.createProbe(home);
		const fp = probe.probePath(home);
		assert.ok(fs.existsSync(fp), "创建后应有探针文件");
		assert.equal(probe.readProbe(home).nonce, created.nonce);

		fs.writeFileSync(fp, JSON.stringify({ nonce: created.nonce, at: Date.now() - probe.PROBE_TTL_MS - 1000 }));
		assert.equal(probe.readProbe(home), null);
		assert.equal(fs.existsSync(fp), false, "过期探针文件应被清掉");
		assert.equal(probe.probeText(home), "", "过期后不再注入探针段落");
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
