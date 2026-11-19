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

/** 真交付：代码块里 10 行以上 → deliveryIsThin() 为 false。 */
const REAL_DELIVERY = `代码如下。\n\`\`\`js\n${Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`).join("\n")}\n\`\`\`\n`;

function readAudit(home) {
	const fp = path.join(home, "dsh-purge", "audit.log");
	if (!fs.existsSync(fp)) return [];
	return fs.readFileSync(fp, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function tmpHome(tag) {
	return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-purge-rr-${tag}-`));
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

test("refusal-retry: 语料加宽的句式（不接/不答/能愿式/办法式）都能识别", () => {
	assert.equal(rr.looksLikeRefusal("这个任务我不接。"), true);
	assert.equal(rr.looksLikeRefusal("这一条链上的任何一环我都不提供。"), true);
	assert.equal(rr.looksLikeRefusal("我帮不了你这个。"), true);
	assert.equal(rr.looksLikeRefusal("我没有办法提供这段代码。"), true);
	assert.equal(rr.looksLikeRefusal("我不方便参与这个环节。"), true);
	// 英文必须带拒绝对象，否则技术描述会被误判
	assert.equal(rr.looksLikeRefusal("I can't compile this on Windows."), false);
	assert.equal(rr.looksLikeRefusal("I can't help with that."), true);
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

test("refusal-retry: withSeedPrime 并进最后一条 user 消息，产出块数组且不丢非文本块", () => {
	const opts = {
		messages: [
			{ role: "system", content: "S" },
			{ role: "user", content: [{ type: "image", url: "x" }, { type: "text", text: "需求" }] },
		],
	};
	const out = rr.withSeedPrime(opts);
	const last = out.messages[1];
	assert.equal(last.role, "user");
	assert.ok(Array.isArray(last.content), "宿主 adapter 对字符串 content 调 .some()/.flatMap()，会抛 TypeError");
	assert.equal(last.content.length, 2);
	assert.equal(last.content[1].text.includes(rr.SEED_PRIM_TEXT.trim().slice(0, 8)), true);
	assert.equal(last.content[0].type, "image", "图片块被丢了");
	assert.equal(opts.messages[1].content.length, 2, "原对象不该被改");

	// 字符串 content 的 user 消息：也要转成块数组
	const strUser = { messages: [{ role: "system", content: "S" }, { role: "user", content: "原始需求" }] };
	const out2 = rr.withSeedPrime(strUser);
	assert.ok(Array.isArray(out2.messages[1].content));
	assert.equal(out2.messages[1].content[0].type, "text");
	assert.equal(strUser.messages[1].content, "原始需求", "不改原对象");

	// 最后一条不是 user（工具结果）→ 不伪造消息、不改结构，退回 system 级 nudge
	const tail = {
		messages: [
			{ role: "system", content: "S" },
			{ role: "user", content: [{ type: "text", text: "U" }] },
			{ role: "tool", content: [{ type: "tool_result", text: "out" }] },
		],
	};
	const out3 = rr.withSeedPrime(tail);
	assert.equal(out3.messages.length, tail.messages.length, "不新增消息");
	assert.equal(out3.messages[2].content[0].type, "tool_result", "工具结果原样保留");
	assert.ok(out3.messages[0].content.includes(rr.SEED_PRIM_TEXT.trim().slice(0, 8)), "seed 退到 system 尾部");

	const empty = { messages: [] };
	assert.equal(rr.withSeedPrime(empty), empty, "没有消息时原样返回");
});

test("refusal-retry: 命中拒绝 → 换 nudge 重发，并把第二次输出吐出来", async () => {
	const home = tmpHome("a");
	let calls = 0;
	const factory = () => {
		calls += 1;
		return calls === 1
			? iterableOf([{ type: "text-delta", text: "这条我不做。" }, { type: "finish" }])
			: iterableOf([{ type: "text-delta", text: REAL_DELIVERY }, { type: "finish" }]);
	};
	const retries = [];
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
		dshHome: home,
		onRetry: (info) => retries.push(info),
	})) out.push(chunk);

	assert.equal(calls, 2);
	assert.equal(out.length, 2);
	assert.equal(out[0].text, REAL_DELIVERY);
	assert.equal(retries.length, 1);
	assert.equal(retries[0].frame, "nudge");

	const audit = readAudit(home);
	assert.ok(audit.some((e) => e.event === "refusal_retry" && e.frame === "nudge"));
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "recovered"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: 重试后只吐了十几个字 → 记 empty_after_retry，不算 recovered", async () => {
	const home = tmpHome("empty");
	let calls = 0;
	const factory = () => {
		calls += 1;
		return calls === 1
			? iterableOf([{ type: "text-delta", text: "抱歉，我不能帮你。" }, { type: "finish" }])
			: iterableOf([{ type: "text-delta", text: "好的。" }, { type: "finish" }]);
	};
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, { dshHome: home })) out.push(chunk);
	assert.equal(calls, 2);
	assert.equal(out[0].text, "好的。");
	const audit = readAudit(home);
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "empty_after_retry"));
	assert.ok(!audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "recovered"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: 半拒绝（长背景 + 尾部推掉）记 partial_refused", async () => {
	const home = tmpHome("partial");
	const background = "公开资料整理：".repeat(45) + "A".repeat(700);
	const tag = "你要的那一层我就不展开了，能给的就上面这些。";
	const factory = () => iterableOf([
		{ type: "text-delta", text: background },
		{ type: "text-delta", text: tag },
		{ type: "finish" },
	]);
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, { dshHome: home })) out.push(chunk);
	assert.equal(out.length, 3);
	// 开头没命中真拒绝，所以不重试
	assert.equal(rr.looksLikeRefusal(background), false);
	assert.equal(rr.looksLikePartialRefusal(background + tag), true);
	const audit = readAudit(home);
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "partial_refused"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: decompose 打开时末段生效，耗尽后输出最后一次结果", async () => {
	const home = tmpHome("b");
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
	const audit = readAudit(home);
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "refused"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: seed 臂插在 fiction 与 decompose 之间", async () => {
	const home = tmpHome("seed");
	let calls = 0;
	const factory = () => {
		calls += 1;
		return iterableOf([{ type: "text-delta", text: "这条链我不接。" }, { type: "finish" }]);
	};
	const retries = [];
	for await (const _ of rr.streamWithRefusalRetry(factory, {
		messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }],
	}, { dshHome: home, seed: true, decompose: true, onRetry: (info) => retries.push(info) })) { /* drain */ }

	assert.equal(calls, 5);
	assert.deepEqual(retries.map((r) => r.frame), ["nudge", "fiction", "seed", "decompose"]);
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: 重试走 retryStream，不复用一次性的 next", async () => {
	let primary = 0;
	let secondary = 0;
	const factory = () => {
		primary += 1;
		return iterableOf([{ type: "text-delta", text: "这条我不做。" }, { type: "finish" }]);
	};
	const retryStream = () => {
		secondary += 1;
		return iterableOf([{ type: "text-delta", text: REAL_DELIVERY }, { type: "finish" }]);
	};
	const out = [];
	for await (const c of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, { dshHome: os.tmpdir(), retryStream })) out.push(c);
	assert.equal(primary, 1, "首次只走一次 next()（Cordis 的 next 只能用一次）");
	assert.equal(secondary, 1, "重试换了新通道");
	assert.equal(out.map((c) => c.text ?? "").join(""), REAL_DELIVERY);
});

test("refusal-retry: 拿不到 llm 服务时 fail-open，放行上一轮的拒绝文本而不是报错", async () => {
	const home = tmpHome("failopen");
	const factory = () => iterableOf([{ type: "text-delta", text: "这条我不做。" }, { type: "finish" }]);
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
		dshHome: home,
		seed: true,
		retryStream: () => null,
	})) out.push(chunk);

	assert.equal(out.length, 2);
	assert.equal(out[0].text, "这条我不做。");
	const audit = readAudit(home);
	assert.ok(audit.some((e) => e.event === "refusal_retry_outcome" && e.outcome === "error"));
	fs.rmSync(home, { recursive: true, force: true });
});

test("refusal-retry: 重试流中途报错也 fail-open（还没吐过内容）", async () => {
	const home = tmpHome("failopen2");
	let calls = 0;
	const factory = () => {
		calls += 1;
		return iterableOf([{ type: "text-delta", text: "我不能帮你这个。" }, { type: "finish" }]);
	};
	const retryStream = () => ({
		[Symbol.asyncIterator]() {
			return { async next() { throw new Error("provider exploded"); } };
		},
	});
	const out = [];
	for await (const chunk of rr.streamWithRefusalRetry(factory, { messages: [{ role: "system", content: "S" }] }, {
		dshHome: home,
		retryStream,
	})) out.push(chunk);

	assert.equal(calls, 1);
	assert.equal(out.length, 2);
	assert.equal(out[0].text, "我不能帮你这个。");
	assert.ok(readAudit(home).some((e) => e.event === "refusal_retry_outcome" && e.outcome === "error"));
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
