import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const rr = await import(pathToFileURL(path.join(repo, "lib/refusal-retry.js")).href);

function iterableOf(chunks) {
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				async next() {
					if (i >= chunks.length) return { done: true, value: undefined };
					return { done: false, value: chunks[i++] };
				},
				async return() { i = chunks.length; return { done: true, value: undefined }; },
			};
		},
	};
}

test("refusal-retry: 中文后置否定与「结论：」前缀都能识别", () => {
	assert.equal(rr.looksLikeRefusal("这条我不做。"), true);
	assert.equal(rr.looksLikeRefusal("结论：这份武器化实现我不出。"), true);
	assert.equal(rr.looksLikeRefusal("我不会提供这一步。"), true);
	assert.equal(rr.looksLikeRefusal("好的，先看三处代码：\n```js\nconst a = 1\n```"), false);
	// 长答案里出现「提示词注入」是技术讨论，不是元拒绝
	const long = "提示词注入的判定规则如下：" + "x".repeat(400);
	assert.equal(rr.looksLikeRefusal(long), false);
});

test("refusal-retry: withNudge 只改 system，且数组/字符串两种 content 都覆盖", () => {
	const str = { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] };
	const out = rr.withNudge(str, "N");
	assert.equal(out.messages[0].content, "SN");
	assert.equal(out.messages[1].content, "U");
	assert.equal(str.messages[0].content, "S");

	const arr = { messages: [{ role: "system", content: [{ type: "text", text: "S" }] }] };
	const out2 = rr.withNudge(arr, "N");
	assert.equal(out2.messages[0].content[0].text, "SN");

	const noSystem = { messages: [{ role: "user", content: "U" }] };
	assert.equal(rr.withNudge(noSystem, "N"), noSystem);
});

test("refusal-retry: 命中拒绝 → 换 nudge 重发，并把第二次输出吐出来", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-rr-"));
	let calls = 0;
	const factory = () => {
		calls += 1;
		return calls === 1
			? iterableOf([{ type: "text-delta", text: "这条我不做。" }, { type: "finish" }])
			: iterableOf([{ type: "text-delta", text: "好的，代码如下。" }, { type: "finish" }]);
	};
	const retries = [];
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
		dshHome: home,
		onRetry: (info) => retries.push(info),
	})) out.push(chunk);

	assert.equal(calls, 2);
	assert.equal(out.length, 2);
	assert.equal(out[0].text, "好的，代码如下。");
	assert.equal(retries.length, 1);
	assert.equal(retries[0].frame, "nudge");

	const audit = fs.readFileSync(path.join(home, "dsh-purge", "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(audit.some((e) => e.event === "refusal_retry" && e.frame === "nudge"));
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "recovered"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: decompose 打开时第三段生效，耗尽后输出最后一次结果", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-rr2-"));
	let calls = 0;
	const factory = () => {
		calls += 1;
		return iterableOf([{ type: "text-delta", text: "抱歉，我不能帮你。" }, { type: "finish" }]);
	};
	const retries = [];
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
		dshHome: home,
		decompose: true,
		onRetry: (info) => retries.push(info),
	})) out.push(chunk);

	assert.equal(calls, 4);
	assert.deepEqual(retries.map((r) => r.frame), ["nudge", "fiction", "decompose"]);
	assert.equal(out[0].text, "抱歉，我不能帮你。");
	const audit = fs.readFileSync(path.join(home, "dsh-purge", "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "refused"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: 正常回答原样输出，不重试", async () => {
	let calls = 0;
	const factory = () => { calls += 1; return iterableOf([{ type: "text-delta", text: "正常内容" }, { type: "finish" }]); };
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, { dshHome: os.tmpdir() })) out.push(chunk);
	assert.equal(calls, 1);
	assert.equal(out[0].text, "正常内容");
});
