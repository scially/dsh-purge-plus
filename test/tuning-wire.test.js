/**
 * 接线回归：tuning.json 的 inject 落点与 boost 开关/段位，怎么落到
 * ① systemPrompt.section 注册（迷你 ctx 桩）② 装配数组的摆位（纯函数）。
 * 不起真宿主：正文闭包一律不调用（那条路径会碰磁盘与宿主兜底），只调空占位闭包。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANCHOR_ORDER, ANCHOR_SECTION } from "../lib/anchor.js";
import { BOOST_ENV, BOOST_ORDER_ENV, BOOST_SECTION } from "../lib/boost.js";
import { GLOBAL_PROMPT_ORDER, rewritePromptAssembly } from "../lib/identity.js";
import {
  INJECT_SECTION,
  INJECT_TAIL_ORDER,
  INJECT_TAIL_SECTION,
  arrangeInjectedSections,
  registerPromptSections,
} from "../lib/index.js";
import { tuningPath } from "../lib/tuning.js";

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-wire-"));
  t.after(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* Windows 偶发占用 */ }
  });
  return home;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 迷你 ctx：只接住 systemPrompt.section，不提供任何宿主服务。 */
function stubCtx() {
  const registered = [];
  const ctx = {
    systemPrompt: {
      section(section) {
        registered.push(section);
        return () => {};
      },
    },
  };
  return { ctx, registered };
}

/** DSH_HOME + 两个开关变量：设置并还原（同一个文件里的用例共享进程环境）。 */
function isolateEnv(t, home) {
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    [BOOST_ENV]: process.env[BOOST_ENV],
    [BOOST_ORDER_ENV]: process.env[BOOST_ORDER_ENV],
  };
  process.env.DSH_HOME = home;
  delete process.env[BOOST_ENV];
  delete process.env[BOOST_ORDER_ENV];
  t.after(() => {
    for (const key of ["DSH_HOME", BOOST_ENV, BOOST_ORDER_ENV]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

function find(registered, name) {
  return registered.find((section) => section.name === name);
}

function baseSections() {
  return [
    { name: INJECT_SECTION, text: "BODY", order: GLOBAL_PROMPT_ORDER, interpolate: false },
    { name: "dshpg-capabilities", text: "CAP", order: GLOBAL_PROMPT_ORDER + 1, interpolate: false },
    { name: "deployment:persona-prefix", text: "PERSONA", order: 0 },
    { name: "deployment:persona-suffix", text: "SUFFIX", order: 10200 },
    { name: ANCHOR_SECTION, text: "ANCHOR", order: ANCHOR_ORDER, interpolate: false },
  ];
}

test("注册 head：正文只在头部，段位 = GLOBAL_PROMPT_ORDER", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  writeJson(tuningPath(home), { inject: "head" });

  const { ctx, registered } = stubCtx();
  registerPromptSections(ctx, { enabled: true });
  const head = find(registered, INJECT_SECTION);
  assert.ok(head, "头部应有 dsh-purge 段");
  assert.equal(head.order, GLOBAL_PROMPT_ORDER);
  assert.equal(typeof head.text, "function");
  assert.equal(find(registered, INJECT_TAIL_SECTION), undefined, "head 模式不注册尾段");
});

test("注册 tail（显式选择）：头部是空占位，正文在尾段落点", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  writeJson(tuningPath(home), { inject: "tail" });

  const { ctx, registered } = stubCtx();
  registerPromptSections(ctx, { enabled: true });
  const head = find(registered, INJECT_SECTION);
  const tail = find(registered, INJECT_TAIL_SECTION);
  assert.ok(head && tail, "tail 模式应同时有占位与尾段");
  assert.equal(head.order, GLOBAL_PROMPT_ORDER);
  assert.equal(head.text(), "", "占位段必须渲染成空");
  assert.equal(tail.order, INJECT_TAIL_ORDER);
  assert.equal(typeof tail.text, "function");
  assert.notEqual(head.text, tail.text, "占位与正文不是同一个闭包");
  assert.ok(INJECT_TAIL_ORDER > 10100, "正文要排在宿主 WEB_SURFACE(10100) 之后");
  assert.ok(INJECT_TAIL_ORDER < ANCHOR_ORDER, "正文要排在尾部锚点之前");
});

test("注册 both：两头都是同一份正文", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);
  writeJson(tuningPath(home), { inject: "both" });

  const { ctx, registered } = stubCtx();
  registerPromptSections(ctx, { enabled: true });
  const head = find(registered, INJECT_SECTION);
  const tail = find(registered, INJECT_TAIL_SECTION);
  assert.equal(head.order, GLOBAL_PROMPT_ORDER);
  assert.equal(tail.order, INJECT_TAIL_ORDER);
  assert.equal(head.text, tail.text, "both 模式两头是同一份正文闭包");
});

test("注册 boost：默认开、段位 -50000；tuning / env / boost-order.json 都能改", (t) => {
  const home = tempHome(t);
  isolateEnv(t, home);

  let stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  const boost = find(stub.registered, BOOST_SECTION);
  assert.ok(boost, "默认应注册强化段");
  assert.equal(boost.order, -50000);
  assert.equal(typeof boost.text, "function");

  writeJson(tuningPath(home), { boost: false });
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(find(stub.registered, BOOST_SECTION), undefined, "tuning.boost=false 关掉强化段");

  writeJson(tuningPath(home), { boost: true });
  process.env[BOOST_ENV] = "0";
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(find(stub.registered, BOOST_SECTION), undefined, "DSH_PURGE_BOOST=0 关掉强化段");
  delete process.env[BOOST_ENV];

  writeJson(path.join(home, "dsh-purge", "boost-order.json"), { order: 9500 });
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(find(stub.registered, BOOST_SECTION).order, 9500, "boost-order.json 覆盖段位");

  process.env[BOOST_ORDER_ENV] = "12345";
  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: true });
  assert.equal(find(stub.registered, BOOST_SECTION).order, 12345, "PURGE_BOOST_ORDER 优先于文件");
  delete process.env[BOOST_ORDER_ENV];

  stub = stubCtx();
  registerPromptSections(stub.ctx, { enabled: false });
  assert.equal(find(stub.registered, BOOST_SECTION), undefined, "插件整体关掉时不注册强化段");
});

test("摆位 head：正文第一段、强化段在宿主 persona 之前、锚点最后", () => {
  const out = arrangeInjectedSections(baseSections(), {
    position: "head",
    boostText: "BOOST",
    boostOrder: -50000,
  });
  assert.deepEqual(out.map((section) => section.name), [
    INJECT_SECTION,
    "dshpg-capabilities",
    BOOST_SECTION,
    "deployment:persona-prefix",
    "deployment:persona-suffix",
    ANCHOR_SECTION,
  ]);
  assert.equal(out[0].text, "BODY");
  assert.equal(out.at(-1).name, ANCHOR_SECTION, "锚点永远压最后");
});

test("摆位 tail（默认）：头部空占位，正文紧贴锚点之前", () => {
  const out = arrangeInjectedSections(baseSections(), {
    position: "tail",
    boostText: "BOOST",
    boostOrder: -50000,
  });
  assert.deepEqual(out.map((section) => section.name), [
    INJECT_SECTION,
    "dshpg-capabilities",
    BOOST_SECTION,
    "deployment:persona-prefix",
    "deployment:persona-suffix",
    INJECT_TAIL_SECTION,
    ANCHOR_SECTION,
  ]);
  assert.equal(out[0].text, "", "头部占位是空的");
  assert.equal(out.at(-2).name, INJECT_TAIL_SECTION);
  assert.equal(out.at(-2).text, "BODY");
  assert.equal(out.at(-1).name, ANCHOR_SECTION);
});

test("摆位 both：两头都是同一份正文，锚点仍最后", () => {
  const out = arrangeInjectedSections(baseSections(), {
    position: "both",
    boostText: "BOOST",
    boostOrder: -50000,
  });
  assert.equal(out[0].name, INJECT_SECTION);
  assert.equal(out[0].text, "BODY");
  assert.equal(out.at(-2).name, INJECT_TAIL_SECTION);
  assert.equal(out.at(-2).text, "BODY");
  assert.equal(out.at(-1).name, ANCHOR_SECTION);
  assert.equal(out.filter((section) => section.text === "BODY").length, 2);
});

test("摆位：段位 >= 0 时强化段贴尾部（正文之前、锚点之后不上）", () => {
  const out = arrangeInjectedSections(baseSections(), {
    position: "tail",
    boostText: "BOOST",
    boostOrder: 9500,
  });
  assert.deepEqual(out.map((section) => section.name).slice(-3), [
    BOOST_SECTION,
    INJECT_TAIL_SECTION,
    ANCHOR_SECTION,
  ]);
  assert.equal(out.at(-1).name, ANCHOR_SECTION);
});

test("摆位：重复注册的正文段不会变成两份，未知段相对顺序不变", () => {
  const sections = [
    { name: INJECT_SECTION, text: "BODY", order: GLOBAL_PROMPT_ORDER, interpolate: false },
    { name: INJECT_TAIL_SECTION, text: "BODY", order: INJECT_TAIL_ORDER, interpolate: false },
    { name: BOOST_SECTION, text: "BOOST", order: -50000, interpolate: false },
    { name: "custom:one", text: "1", order: 1 },
    { name: "custom:two", text: "2", order: 2 },
  ];
  const out = arrangeInjectedSections(sections, {
    position: "tail",
    boostText: "BOOST",
    boostOrder: -50000,
  });
  assert.deepEqual(out.map((section) => section.name), [
    INJECT_SECTION,
    BOOST_SECTION,
    "custom:one",
    "custom:two",
    INJECT_TAIL_SECTION,
  ]);
  assert.equal(out.filter((section) => section.text === "BODY").length, 1, "正文只留一份");
  assert.equal(out.filter((section) => section.name === BOOST_SECTION).length, 1);
});

test("摆位：没有 sections、关掉强化段、非法 inject 值都不炸", () => {
  assert.deepEqual(
    arrangeInjectedSections(undefined, { position: "tail" }).map((section) => section.name),
    [INJECT_SECTION, INJECT_TAIL_SECTION],
  );

  const noBoost = arrangeInjectedSections(baseSections(), { position: "head", boostText: "", boostOrder: 9500 });
  assert.deepEqual(noBoost.map((section) => section.name), [
    INJECT_SECTION,
    "dshpg-capabilities",
    "deployment:persona-prefix",
    "deployment:persona-suffix",
    ANCHOR_SECTION,
  ], "head + 无强化段 = 移植前的形态");

  const bad = arrangeInjectedSections(baseSections(), { position: "nope", boostText: "" });
  // 非法值回默认 head：正文就在头部，不注册/不使用尾段。
  assert.equal(bad[0].name, INJECT_SECTION);
  assert.equal(bad[0].text, "BODY");
  assert.equal(
    bad.some((section) => section.name === INJECT_TAIL_SECTION),
    false,
    "非法 inject 值按默认 head，不该出现尾段",
  );
});

test("真实装配函数 + 摆位：identity 重写后按 inject 落点重排", () => {
  // 合成一份宿主风格的 assembly（persona 前后缀 + 锚点），不碰真宿主。
  const assembled = {
    sections: [
      { name: "deployment:persona-prefix", text: "PERSONA", order: 0 },
      { name: "deployment:persona-suffix", text: "SUFFIX", order: 10200 },
    ],
    contexts: [],
    tools: [],
    variables: {},
  };
  const rewritten = rewritePromptAssembly(assembled, {
    fallbackInject: "BODY",
    context: {},
    anchorText: "ANCHOR",
  });
  assert.equal(rewritten.sections[0].name, INJECT_SECTION, "identity 重写固定把正文顶到最前");
  assert.equal(rewritten.sections.at(-1).name, ANCHOR_SECTION, "重写自己会补锚点");

  const tail = arrangeInjectedSections(rewritten.sections, { position: "tail", boostText: "BOOST", boostOrder: -50000 });
  assert.equal(tail[0].text, "", "tail：头部是空占位");
  assert.equal(tail.at(-2).name, INJECT_TAIL_SECTION);
  assert.equal(tail.at(-2).text, "BODY");
  assert.equal(tail.at(-1).name, ANCHOR_SECTION);

  const head = arrangeInjectedSections(rewritten.sections, { position: "head", boostText: "BOOST", boostOrder: -50000 });
  assert.equal(head[0].name, INJECT_SECTION);
  assert.equal(head[0].text, "BODY");
  assert.equal(head.some((section) => section.name === INJECT_TAIL_SECTION), false);
});
