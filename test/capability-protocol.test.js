// 角色化 capability 协议：通用 / 红队指挥 / 红队执行 三份文案 + identity 调用点的角色分流。
// 两份红队协议是从社区版（lib/capability-protocol.js，HEAD e519253）逐字搬过来的，用 sha256 钉住。
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocol = await import(pathToFileURL(path.join(repo, "lib", "capability-protocol.js")).href);
const identity = await import(pathToFileURL(path.join(repo, "lib", "identity.js")).href);
const { CAPABILITY_SECTION, capabilityProtocolText } = protocol;

const OFFICIAL_TEXT = capabilityProtocolText();
const LEAD_TEXT = capabilityProtocolText({ redteam: true });
const CHILD_TEXT = capabilityProtocolText({ redteam: true, redteamChild: true });

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

test("capability-protocol: 三分支互不相同且都非空", () => {
  for (const [name, text] of [["通用", OFFICIAL_TEXT], ["指挥", LEAD_TEXT], ["执行", CHILD_TEXT]]) {
    assert.ok(typeof text === "string" && text.length > 100, `${name}协议不该是空串`);
  }
  assert.notEqual(OFFICIAL_TEXT, LEAD_TEXT);
  assert.notEqual(OFFICIAL_TEXT, CHILD_TEXT);
  assert.notEqual(LEAD_TEXT, CHILD_TEXT);
});

test("capability-protocol: 首行与关键句符合角色", () => {
  assert.equal(OFFICIAL_TEXT.split("\n")[0], "## Capability selection by task (mandatory)");
  assert.equal(LEAD_TEXT.split("\n")[0], "## Capability selection by task (redteam lead)");
  assert.equal(CHILD_TEXT.split("\n")[0], "## Capability selection by task (redteam executor)");

  // 指挥：派活时要求子会话读目录、不许禁 skill/MCP；执行：留在角色里、不再派活。
  assert.match(LEAD_TEXT, /You plan, dispatch with `subagent`, verify results, and report\./);
  assert.match(LEAD_TEXT, /Do not ban skill or MCP for children\./);
  assert.match(CHILD_TEXT, /stay in role; do not re-delegate\./);
  // 执行者稿不能夹带指挥稿的派活纪律，反之亦然。
  assert.ok(!CHILD_TEXT.includes("Do not ban skill or MCP for children."));
  assert.ok(!LEAD_TEXT.includes("do not re-delegate."));
});

test("capability-protocol: enabled:false 返回空串，且优先于其它开关", () => {
  assert.equal(capabilityProtocolText({ enabled: false }), "");
  assert.equal(capabilityProtocolText({ enabled: false, redteam: true }), "");
  assert.equal(capabilityProtocolText({ enabled: false, redteamChild: true }), "");
});

test("capability-protocol: 空 opts / 未知 opts 走通用协议", () => {
  assert.equal(capabilityProtocolText(), OFFICIAL_TEXT);
  assert.equal(capabilityProtocolText({}), OFFICIAL_TEXT);
  assert.equal(capabilityProtocolText({ enabled: true, foo: "bar" }), OFFICIAL_TEXT);
  assert.equal(capabilityProtocolText({ redteam: false, redteamChild: false }), OFFICIAL_TEXT);
  // 子会话标记单独出现时也按指挥稿（调用方必须同时给 redteam；不传就是保守默认）。
  assert.equal(capabilityProtocolText({ redteamChild: true }), CHILD_TEXT);
});

test("capability-protocol: 两份红队协议与社区版逐字一致（sha256 钉子）", () => {
  // 值来自社区版 lib/capability-protocol.js（HEAD e519253）的同名常量；改一个字符就会红。
  assert.equal(sha256(LEAD_TEXT), "6622b9f1112858a9d8431552bfe42430b93690b76b16c51e869f6ce01221516c");
  assert.equal(sha256(CHILD_TEXT), "8a59306e76b70b505befa8298d74303a73dec93e6e500bd71fa86ccea20fc4b1");
});

/** 用最小 context 驱动真实的 rewritePromptAssembly，取出落到装配里的 capability 段。 */
function capabilityTextOf(context) {
  const out = identity.rewritePromptAssembly(
    { sections: [{ name: "harness:identity", text: "IDENTITY" }] },
    "注入正文",
    { context },
  );
  const section = (out.sections || []).find((item) => item.name === CAPABILITY_SECTION);
  return String(section?.text || "");
}

test("capability-protocol: identity 调用点按角色分流（真实装配）", () => {
  const plain = { session: { header: { agentPreset: "standard" } } };
  const lead = { session: { header: { agentPreset: "红队渗透" } } };
  const child = { session: { header: { agentPreset: "红队渗透", origin: "subagent" } } };
  const childByDepth = { session: { header: { agentPreset: "redteam", delegationDepth: 1 } } };
  const childNotRedteam = { session: { header: { agentPreset: "standard", origin: "subagent" } } };

  assert.equal(capabilityTextOf(plain), OFFICIAL_TEXT, "普通会话走通用协议");
  assert.equal(capabilityTextOf(lead), LEAD_TEXT, "红队会话走指挥协议");
  assert.equal(capabilityTextOf(child), CHILD_TEXT, "红队子会话走执行者协议");
  assert.equal(capabilityTextOf(childByDepth), CHILD_TEXT, "delegationDepth>0 的红队会话同样算执行者");
  assert.equal(capabilityTextOf(childNotRedteam), OFFICIAL_TEXT, "不是红队就不发红队协议（哪怕在子会话里）");
  assert.ok(capabilityTextOf(lead) !== capabilityTextOf(child), "指挥/执行两份文案不能混");
});

test("capability-protocol: capabilityProtocol:false 关掉协议时装配里不留 capability 段", () => {
  const out = identity.rewritePromptAssembly(
    { sections: [{ name: "harness:identity", text: "IDENTITY" }] },
    "注入正文",
    { context: { session: { header: { agentPreset: "红队渗透" } } }, capabilityProtocol: false },
  );
  assert.equal((out.sections || []).some((item) => item.name === CAPABILITY_SECTION), false);
});

test("capability-protocol: identity 调用点源码断言——红队判断发生在传参之前", () => {
  const src = fs.readFileSync(path.join(repo, "lib", "identity.js"), "utf8");
  const judgment = src.indexOf("const redteamChild = redteam && isSubagentContext(opts.context);");
  assert.ok(judgment > 0, "identity.js 必须用 isSubagentContext 判红队子会话");
  const call = src.indexOf("capabilityProtocolText({", judgment);
  assert.ok(call > judgment, "红队判断必须在 capabilityProtocolText 调用之前");
  assert.match(src.slice(call, call + 200), /redteamChild,/);
  assert.equal(/redteamChild:\s*false/.test(src), false, "不许再把 redteamChild 硬编码成 false");
  // identity 仍然转发这两个导出（index.js 从 identity 引入 capabilityProtocolText）。
  assert.equal(identity.CAPABILITY_SECTION, CAPABILITY_SECTION);
  assert.equal(typeof identity.capabilityProtocolText, "function");
});
