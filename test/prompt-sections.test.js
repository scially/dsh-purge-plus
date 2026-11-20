/**
 * 段名 / 段位契约：我们注册进 systemPrompt 的段必须“能被宿主正确摆放”。
 *
 * 背景（真机事实，见 scripts/verify-section-order.mjs 的取证）：
 *   0.2.1-rc.5 的宿主补丁在 assemble() 返回前，会把**非空且以 `dsh-purge` 开头**的段整体提到数组最前。
 *   所以只有「必须钉最前」的注入正文才配 `dsh-purge` 前缀；cap / boost / tail inject / anchor
 *   一律 `dshpg-`，才能按 order 待在该在的位置。
 *
 * 这份盯「命名与注册」，摆位在 test/section-order.test.js，别在这里重复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHOR_ORDER, ANCHOR_SECTION, CHILD_ANCHOR_CONTEXT, CHILD_ORDER, registerAnchor } from "../lib/anchor.js";
import { BOOST_ORDER_ENV, BOOST_SECTION, DEFAULT_BOOST_ORDER } from "../lib/boost.js";
import { CAPABILITY_SECTION, GLOBAL_PROMPT_ORDER } from "../lib/identity.js";
import {
  INJECT_SECTION,
  INJECT_TAIL_ORDER,
  INJECT_TAIL_SECTION,
  registerPromptSections,
} from "../lib/index.js";
import { tuningPath } from "../lib/tuning.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/prompt-sections.json"), "utf8"));

const expected = new Map(fixture.sections.map((row) => [row.name, row]));
const documented = new Set([...expected.keys(), ...fixture.knownExceptions.map((row) => row.name)]);

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-sections-"));
  t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
  });
  return home;
}

/** DSH_HOME + 段位环境变量：设置并还原（同一文件内的用例共享进程环境）。 */
function isolateEnv(t, home) {
  const saved = { DSH_HOME: process.env.DSH_HOME, [BOOST_ORDER_ENV]: process.env[BOOST_ORDER_ENV] };
  process.env.DSH_HOME = home;
  delete process.env[BOOST_ORDER_ENV];
  t.after(() => {
    for (const key of ["DSH_HOME", BOOST_ORDER_ENV]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function stubCtx() {
  const sections = [];
  const contexts = [];
  const ctx = {
    systemPrompt: {
      section(spec) { sections.push(spec); return () => {}; },
      context(spec) { contexts.push(spec); return () => {}; },
    },
  };
  return { ctx, sections, contexts };
}

function writeTuning(home, patch) {
  fs.mkdirSync(path.dirname(tuningPath(home)), { recursive: true });
  fs.writeFileSync(tuningPath(home), `${JSON.stringify(patch, null, 2)}\n`, "utf8");
}

function namesOf(sections) {
  return sections.map((section) => String(section.name));
}

test("夹具与代码里的常量一一对齐（改常量必须先改夹具）", () => {
  assert.equal(INJECT_SECTION, "dsh-purge");
  assert.equal(INJECT_TAIL_SECTION, expected.get(INJECT_TAIL_SECTION).name);
  assert.equal(CAPABILITY_SECTION, "dshpg-capabilities");
  assert.equal(BOOST_SECTION, "dshpg-boost");
  assert.equal(ANCHOR_SECTION, "dshpg-anchor");

  assert.equal(expected.get(INJECT_SECTION).order, GLOBAL_PROMPT_ORDER);
  assert.equal(expected.get(CAPABILITY_SECTION).order, GLOBAL_PROMPT_ORDER + 1);
  assert.equal(expected.get(INJECT_TAIL_SECTION).order, INJECT_TAIL_ORDER);
  assert.equal(expected.get(BOOST_SECTION).order, DEFAULT_BOOST_ORDER);
  assert.equal(expected.get(ANCHOR_SECTION).order, ANCHOR_ORDER);
  assert.equal(fixture.contexts[0].name, CHILD_ANCHOR_CONTEXT);
  assert.equal(fixture.contexts[0].order, CHILD_ORDER);
});

test("注册契约：head/tail/both 三态下的段名集合与段位", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);

  const expectByPosition = {
    head: [INJECT_SECTION, CAPABILITY_SECTION, BOOST_SECTION],
    tail: [INJECT_SECTION, INJECT_TAIL_SECTION, CAPABILITY_SECTION, BOOST_SECTION],
    both: [INJECT_SECTION, INJECT_TAIL_SECTION, CAPABILITY_SECTION, BOOST_SECTION],
  };
  for (const [position, names] of Object.entries(expectByPosition)) {
    writeTuning(home, { inject: position });
    const stub = stubCtx();
    registerPromptSections(stub.ctx, { enabled: true });
    const got = namesOf(stub.sections).sort();
    assert.deepEqual(got, [...names].sort(), `${position} 模式注册的段名不对`);

    for (const section of stub.sections) {
      const row = expected.get(String(section.name));
      assert.ok(row, `${position}：段 ${section.name} 没登记在夹具里`);
      assert.equal(section.order, row.order, `${position}：段 ${section.name} 的段位与夹具不一致`);
    }
    assert.equal(new Set(got).size, got.length, `${position}：段名不能重复注册`);
  }
});

test("前缀策略：只有 head inject 用 dsh-purge，其余一律 dshpg-（才不会被宿主提权）", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  for (const position of ["head", "tail", "both"]) {
    writeTuning(home, { inject: position });
    const stub = stubCtx();
    registerPromptSections(stub.ctx, { enabled: true });
    for (const section of stub.sections) {
      const name = String(section.name);
      if (name === INJECT_SECTION) continue;
      assert.ok(
        name.startsWith(fixture.policy.keepOrderPrefix),
        `${position}：${name} 必须用 ${fixture.policy.keepOrderPrefix} 前缀（${fixture.policy.rule}）`,
      );
    }
    assert.ok(
      namesOf(stub.sections).includes(INJECT_SECTION),
      `${position}：head inject 段必须存在（宿主补丁/面板按名找它）`,
    );
  }
});

test("锚点：唯一一份 section、段位落在尾部区间；子锚点是 context 不是 section", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  const stub = stubCtx();
  registerAnchor(stub.ctx, {});
  registerAnchor(stub.ctx, {}); // 二次注册：同名段由宿主去重（这里只验我们的请求形态）

  const anchorSections = stub.sections.filter((section) => String(section.name) === ANCHOR_SECTION);
  assert.equal(anchorSections.length, 2, "两次调用各注册一次（宿主按名字去重）", );
  assert.equal(new Set(namesOf(stub.sections)).size, 1, "锚点只注册一个段名");
  assert.equal(anchorSections[0].order, ANCHOR_ORDER);

  const anchorRow = expected.get(ANCHOR_SECTION);
  assert.ok(anchorRow.order > 10100, "锚点必须排在宿主 WEB_SURFACE(10100) 之后");
  assert.ok(anchorRow.order < 10200, "锚点必须排在 persona-suffix(10200) 之前");
  assert.ok(anchorRow.order > INJECT_TAIL_ORDER, "锚点必须排在尾段落点之后（它要压最后）");

  const childContexts = stub.contexts.filter((context) => String(context.name) === CHILD_ANCHOR_CONTEXT);
  assert.equal(childContexts.length, 2, "子锚点按 context 注册（sections 重排管不到它）");
  assert.equal(childContexts[0].order, CHILD_ORDER);
});

test("段位互不冲突：五个段两两不同，且顺序符合设计", () => {
  const orders = expected.size === 5 ? [...expected.values()].map((row) => row.order) : [];
  assert.equal(new Set(orders).size, orders.length, `段位有冲突：${JSON.stringify(orders)}`);
  const injectOrder = expected.get(INJECT_SECTION).order;
  const capOrder = expected.get(CAPABILITY_SECTION).order;
  const boostOrder = expected.get(BOOST_SECTION).order;
  assert.ok(injectOrder < capOrder, "注入正文要排在能力协议之前");
  assert.ok(capOrder < boostOrder, "强化段排在能力协议之后、宿主段之前（实测默认 -50000）");
  assert.ok(boostOrder < 0, "默认段位必须是负数（宿主区间从 0 起，负数才在 persona 之前）");
  assert.ok(INJECT_TAIL_ORDER < ANCHOR_ORDER, "尾段落点要排在锚点之前");
});

test("未登记的段会被抓出来：注册名必须全部出现在夹具（sections + knownExceptions）里", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  const stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true, postPrompt: "extra tail text", postPromptOrder: 5100 });
  registerAnchor(stub.ctx, {});

  const unknown = namesOf(stub.sections).filter((name) => !documented.has(name));
  assert.deepEqual(unknown, [], `这些段没登记在 fixtures/prompt-sections.json：${unknown.join(", ")}`);
});

test("postPrompt 段：默认不启用；启用后用 dshpg- 前缀，宿主提权不影响它的段位", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);

  const plain = stubCtx();
  registerPromptSections(plain.ctx, { enabled: true });
  assert.ok(!namesOf(plain.sections).includes("dshpg-post"), "postPrompt 默认空 → 不该注册这个段");

  const withPost = stubCtx();
  registerPromptSections(withPost.ctx, { enabled: true, postPrompt: "extra tail text", postPromptOrder: 5100 });
  const post = withPost.sections.find((section) => String(section.name) === "dshpg-post");
  assert.ok(post, "配了 postPrompt 就要注册 dshpg-post");
  assert.equal(post.order, 5100);

  // 夹具里不该再有例外：段名策略对注册段是全覆盖的（knownExceptions 只留结构，不再有内容）。
  assert.deepEqual(fixture.knownExceptions, [], "注册段都已按 dshpg- 策略命名，不该再有例外");

  /* 宿主提权规则模拟：非空 `dsh-purge*` 段被整体提前。
     post 段用 dshpg- 前缀 → 不命中 → order 5100 在 0.2.1-rc.5 上照样生效。 */
  const plan = [
    { name: INJECT_SECTION, text: "«INJECT»", order: GLOBAL_PROMPT_ORDER },
    { name: "deployment:persona-prefix", text: "«HOST»", order: 0 },
    { name: "dshpg-post", text: "extra tail text", order: 5100 },
  ];
  const hoisted = [
    ...plan.filter((section) => section.name.startsWith("dsh-purge") && section.text.length > 0),
    ...plan.filter((section) => !section.name.startsWith("dsh-purge")),
  ];
  const personaAt = hoisted.findIndex((section) => section.name === "deployment:persona-prefix");
  const postAt = hoisted.findIndex((section) => section.name === "dshpg-post");
  assert.ok(postAt > personaAt, "dshpg-post 必须留在宿主段之后（order 生效）");
});
