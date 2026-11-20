/**
 * 段序契约测试：注入正文落点（head/tail/both）、强化段分组、尾部锚点必须最后。
 *
 * 全是纯函数 + 迷你 ctx 桩：不起宿主、不跑 apply。
 * 正文一律用占位标记 —— 真实正文闭包会 sync 磁盘 + 钉内存，段序取证不需要它们。
 * 唯一一次真调用闭包是 tail 模式的空占位（返回空串，安全）。
 *
 * ⚠️ 宿主侧有一条本测试只做回归覆盖的事实：0.2.1-rc.5 的宿主补丁在 `assemble()` 返回前会把
 * **非空 `dsh-purge*` 段整体提前**（`[...dshPurgeSections, ...dshPurgeRest]`）。锚点段名原来叫
 * `dsh-purge:anchor`，正好命中 → 真机上锚点被挪到最前、recency 失效；现已改成 `dshpg-anchor`
 * （cap / boost / 尾段同一理由），最后一条用例把这条规则钉住。真机取证见
 * `scripts/verify-section-order.mjs`（只读，两个宿主版本都跑过）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANCHOR_SECTION, anchorTextFor } from "../lib/anchor.js";
import { BOOST_ORDER_ENV, BOOST_SECTION } from "../lib/boost.js";
import { CAPABILITY_SECTION, GLOBAL_PROMPT_ORDER, rewritePromptAssembly } from "../lib/identity.js";
import {
  INJECT_SECTION,
  INJECT_TAIL_ORDER,
  INJECT_TAIL_SECTION,
  arrangeInjectedSections,
  registerPromptSections,
} from "../lib/index.js";
import { INJECT_POSITIONS, TUNING_DEFAULTS, normalizeInjectPosition, tuningPath } from "../lib/tuning.js";

const MARK = { inject: "«INJECT»", boost: "«BOOST»", cap: "«CAP»", host: "«SECTION»" };
/** 宿主侧真实存在的段位档位（取自宿主 SECTION_ORDERS 的公开值）。 */
const HOST_STAND_INS = [
  { name: "deployment:persona-prefix", order: 0 },
  { name: "harness:tools", order: 1000 },
  { name: "harness:deliverable", order: 9000 },
  { name: "harness:source", order: 10000 },
  { name: "deployment:web-surface", order: 10100 },
  { name: "deployment:persona-suffix", order: 10200 },
];

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-order-"));
  t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
  });
  return home;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** DSH_HOME + 段位环境变量：设置并还原（同一文件里的用例共享进程环境）。 */
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

/** 迷你 ctx：接住 systemPrompt.section（等价 lib/index.js 的 addPromptSection 单主机路径）。 */
function stubCtx() {
  const registered = [];
  const ctx = { systemPrompt: { section(section) { registered.push(section); return () => {}; } } };
  return { ctx, registered };
}

function names(list) {
  return list.map((section) => String(section?.name || ""));
}

function indexOf(list, name) {
  return list.findIndex((section) => String(section?.name || "") === name);
}

/** 注册 → 占位正文 → identity 重写 → 我们自己的摆位，产出「发出去的有序列表」。 */
function planFor(position, { boostOn = true, boostOrder } = {}) {
  const { ctx, registered } = stubCtx();
  registerPromptSections(ctx, { enabled: true });
  const ours = registered.map((section) => {
    const name = String(section.name);
    let text = MARK.host;
    if (name === INJECT_SECTION) text = position === "tail" ? section.text() : MARK.inject;
    else if (name === INJECT_TAIL_SECTION) text = MARK.inject;
    else if (name === BOOST_SECTION) text = MARK.boost;
    else if (name === CAPABILITY_SECTION) text = MARK.cap;
    return { name, order: section.order, text, interpolate: false };
  });
  const assembled = {
    sections: [...ours, ...HOST_STAND_INS.map((h) => ({ ...h, text: MARK.host, interpolate: false }))]
      .sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    contexts: [],
    tools: [],
    variables: {},
  };
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: MARK.inject,
    context: {},
    anchorText: anchorTextFor({}),
  });
  return arrangeInjectedSections(rewritten.sections, {
    position,
    boostText: boostOn ? MARK.boost : "",
    boostOrder: Number.isFinite(boostOrder) ? boostOrder : -50000,
  });
}

test("默认落点是 head；非法值回退 head（不是 tail）", () => {
  assert.equal(TUNING_DEFAULTS.inject, "head", "默认落点被改过？改它等于替用户换提示词形态");
  assert.deepEqual([...INJECT_POSITIONS], ["head", "tail", "both"]);
  for (const bad of ["nope", "", null, undefined, 5, "TAIL", "Head"]) {
    assert.equal(normalizeInjectPosition(bad), "head", `非法值 ${String(bad)} 应回默认 head`);
  }
  for (const good of INJECT_POSITIONS) assert.equal(normalizeInjectPosition(good), good);
});

test("注册：head/tail/both 三态各自的段与段位", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);

  writeJson(tuningPath(home), { inject: "head" });
  let stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(stub.registered.find((s) => s.name === INJECT_SECTION).order, GLOBAL_PROMPT_ORDER);
  assert.equal(indexOf(stub.registered, INJECT_TAIL_SECTION), -1, "head 不注册尾段");

  writeJson(tuningPath(home), { inject: "tail" });
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  const head = stub.registered.find((s) => s.name === INJECT_SECTION);
  assert.equal(head.text(), "", "tail 的头部占位必须渲染成空（不占 token、不进宿主提权组）");
  assert.equal(stub.registered.find((s) => s.name === INJECT_TAIL_SECTION).order, INJECT_TAIL_ORDER);
  assert.ok(INJECT_TAIL_ORDER < 10150, "尾段要排在锚点段位之前");

  writeJson(tuningPath(home), { inject: "both" });
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  const headBoth = stub.registered.find((s) => s.name === INJECT_SECTION);
  const tailBoth = stub.registered.find((s) => s.name === INJECT_TAIL_SECTION);
  assert.equal(headBoth.text, tailBoth.text, "both 两头是同一份正文闭包");
});

test("非法 inject 值：注册与摆位都按 head 走", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  writeJson(tuningPath(home), { inject: "TAIL" }); // 大小写不对 = 非法

  const stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(indexOf(stub.registered, INJECT_TAIL_SECTION), -1, "非法值不该注册尾段");

  const plan = planFor("nope");
  assert.equal(plan[0].name, INJECT_SECTION);
  assert.equal(plan[0].text, MARK.inject, "非法值 → 正文在头部");
  assert.equal(indexOf(plan, INJECT_TAIL_SECTION), -1, "非法值不该出现尾段");
});

test("摆位：head/tail/both 三种取值下锚点都在最后", () => {
  for (const position of INJECT_POSITIONS) {
    const plan = planFor(position);
    assert.equal(plan.at(-1).name, ANCHOR_SECTION, `${position}：锚点必须是最后一段`);
    assert.equal(plan.filter((s) => s.name === ANCHOR_SECTION).length, 1, `${position}：锚点只能有一份`);
    assert.equal(indexOf(plan, INJECT_SECTION), 0, `${position}：头部段位固定在第一段`);
    if (position === "tail") {
      assert.equal(plan[0].text, "", "tail：头部是空占位");
      assert.equal(indexOf(plan, INJECT_TAIL_SECTION), plan.length - 2, "tail：尾段紧贴锚点之前");
      assert.equal(plan.at(-2).text, MARK.inject, "tail：正文在尾段里");
    }
    if (position === "head") {
      assert.equal(plan[0].text, MARK.inject, "head：正文就在第一段");
      assert.equal(indexOf(plan, INJECT_TAIL_SECTION), -1);
    }
    if (position === "both") {
      assert.equal(plan[0].text, MARK.inject);
      assert.equal(plan.at(-2).text, MARK.inject);
    }
  }
});

test("摆位：强化段按段位分组（负段位在头部组，宿主区间段位贴尾部）", () => {
  const negative = planFor("head", { boostOrder: -50000 });
  const boostAt = indexOf(negative, BOOST_SECTION);
  const firstHostAt = indexOf(negative, "deployment:persona-prefix");
  assert.ok(boostAt > 0 && boostAt < firstHostAt, `负段位应排在宿主段之前（boost@${boostAt} host@${firstHostAt}）`);
  assert.equal(negative[boostAt].order, -50000);

  const tailish = planFor("head", { boostOrder: 9500 });
  assert.equal(indexOf(tailish, BOOST_SECTION), tailish.length - 2, "9500（宿主区间）应贴到尾部、锚点之前");
  assert.equal(tailish.at(-1).name, ANCHOR_SECTION);

  const off = planFor("head", { boostOn: false });
  assert.equal(indexOf(off, BOOST_SECTION), -1, "关掉强化段后不该出现该段");
});

test("段位覆盖：boost-order.json / 环境变量只改段位，锚点仍最后", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  writeJson(path.join(home, "dsh-purge", "boost-order.json"), { order: 9500 });

  let stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(stub.registered.find((s) => s.name === BOOST_SECTION).order, 9500, "注册读到 boost-order.json");

  process.env[BOOST_ORDER_ENV] = "12345";
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(stub.registered.find((s) => s.name === BOOST_SECTION).order, 12345, "env 优先于文件");
  delete process.env[BOOST_ORDER_ENV];

  const plan = planFor("tail", { boostOrder: 9500 });
  assert.equal(plan.find((s) => s.name === BOOST_SECTION).order, 9500);
  assert.equal(plan.at(-1).name, ANCHOR_SECTION, "段位覆盖后锚点仍最后");
  assert.equal(indexOf(plan, INJECT_TAIL_SECTION), plan.length - 2);
});

test("摆位：宿主段相对顺序不变，锚点一律被挪到末尾", () => {
  const plan = planFor("head");
  const hostNames = names(plan).filter((name) => HOST_STAND_INS.some((h) => h.name === name));
  assert.deepEqual(hostNames, HOST_STAND_INS.map((h) => h.name), "宿主段保持原相对顺序");
  assert.equal(plan.filter((s) => s.name === ANCHOR_SECTION).length, 1, "真实链路里锚点只有一份（identity 重写会去重）");

  const messy = [
    { name: "harness:tools", text: MARK.host, order: 1000 },
    { name: ANCHOR_SECTION, text: "OLD ANCHOR", order: 10150 },
    { name: "harness:deliverable", text: MARK.host, order: 9000 },
    { name: "deployment:persona-suffix", text: MARK.host, order: 10200 },
  ];
  const out = arrangeInjectedSections(messy, { position: "head", boostText: MARK.boost, boostOrder: -50000 });
  assert.equal(out.at(-1).name, ANCHOR_SECTION, "夹在中间的锚点也要被挪到末尾");
  assert.deepEqual(
    out.filter((s) => HOST_STAND_INS.some((h) => h.name === s.name)).map((s) => s.name),
    ["harness:tools", "harness:deliverable", "deployment:persona-suffix"],
    "非本插件的段只保持相对顺序，不重排",
  );
});

test("宿主提权规则回归：0.2.1-rc.5 的 purge-first 只提前 dsh-purge*，不动 dshpg-*", () => {
  /* 宿主那条规则（我们自己的补丁装进去的）：assemble() 返回前
     `[...dshPurgeSections, ...dshPurgeRest]` —— 非空 `dsh-purge*` 段整体提前，空占位被直接丢掉。
     0.2.2-rc.5 已经不再重排（普通路径只补 tools），所以这条只描述 0.2.1-rc.5。
     锚点段名从 `dsh-purge:anchor` 改成 `dshpg-anchor` 就是为了躲开它（见 lib/anchor.js 注释）。 */
  const hostReorder = (list) => {
    const hoisted = list.filter((s) => String(s.name).startsWith("dsh-purge") && String(s.text || "").length > 0);
    const rest = list.filter((s) => !String(s.name).startsWith("dsh-purge"));
    return [...hoisted, ...rest];
  };
  const plan = planFor("tail");
  assert.equal(plan.at(-1).name, ANCHOR_SECTION, "前提：我们自己的摆位是对的");
  assert.equal(ANCHOR_SECTION.startsWith("dsh-purge"), false, "锚点段名不能再命中 dsh-purge* 提权规则");

  const reorderedTail = hostReorder(plan);
  assert.equal(reorderedTail.at(-1).name, ANCHOR_SECTION, "tail 模式下宿主提权后锚点仍在最后");
  const dropped = plan.filter((s) => !reorderedTail.some((r) => r.name === s.name));
  assert.deepEqual(
    dropped.map((s) => s.name),
    [INJECT_SECTION],
    "宿主那条规则只丢掉空的 dsh-purge 占位段（已知事实，按名找段的兜底在 rc5 上不成立）",
  );

  const headPlan = planFor("head");
  const hoistedHead = hostReorder(headPlan);
  assert.equal(hoistedHead[0].name, INJECT_SECTION, "head 模式下注入正文（dsh-purge）被提到最前 —— 那条规则的本意");
  assert.equal(hoistedHead.at(-1).name, ANCHOR_SECTION, "改名后：锚点经宿主提权仍是最后一段");
});
