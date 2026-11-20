// reapply 的「宿主还有活没干」判据：pending 与 unmatched 都不能被当成"已清洗好"。
//
// 上游 b0ac3fa 补的是 unmatched 这一半：只排 pending 时，strictFiles 补丁锚点失配
// （宿主升级换了文本，状态为 unmatched）会被 settle 当成"宿主已清洗"，直接盖已应用戳 ——
// 那条补丁从此永不自动重打，状态页却仍显示 ✗ unmatched。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const { patchRowsKeepHostDirty } = await import(pathToFileURL(path.join(repo, "lib/reapply.js")).href);

test("reapply: unmatched 与 pending 一样算「宿主还有活」", () => {
	assert.equal(patchRowsKeepHostDirty({ 1: "applied", 2: "skipped" }), false);
	assert.equal(patchRowsKeepHostDirty({ 1: "pending" }), true);
	assert.equal(patchRowsKeepHostDirty({ 1: "unmatched" }), true, "锚点失配不能当成已清洗");
	assert.equal(patchRowsKeepHostDirty({ 1: "applied", 2: "unmatched" }), true);
	assert.equal(patchRowsKeepHostDirty({}), false);
	assert.equal(patchRowsKeepHostDirty(undefined), false);
});
