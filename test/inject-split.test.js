/**
 * 拆段契约：同一份注入正文被摆到 head（dsh-purge）或 tail（dshpg-inject-tail）时，
 * 条款一条都不能少，而且能完整还原成原文。
 *
 * `inject: head|tail|both` 的实现分散在两处（见 lib/index.js）：
 *   - registerPromptSections：按落点注册段（tail 模式头部留空占位）；
 *   - arrangeInjectedSections：装配返回前按落点摆位。
 * 这里用真实摆位函数 + 真实出厂正文做纯函数验证，不起宿主。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHOR_ORDER, ANCHOR_SECTION } from "../lib/anchor.js";
import { BOOST_SECTION, BOOST_TEXT } from "../lib/boost.js";
import { CAPABILITY_SECTION, GLOBAL_PROMPT_ORDER, peelChatmlEnvelope } from "../lib/identity.js";
import { INJECT_SECTION, INJECT_TAIL_SECTION, arrangeInjectedSections } from "../lib/index.js";
import { INJECT_POSITIONS } from "../lib/tuning.js";
import * as table from "../lib/asset-table.js";
import { openSlot } from "../lib/table-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures/inject-clauses.json"), "utf8"));
/** 真正被注入的是运行时形态（identity.js 归一转 LF、补闭合）。 */
const body = peelChatmlEnvelope(openSlot({ SLOT: table.SLOT, MASK: table.MASK, TAG: table.TAG, IV: table.IV }));

const norm = (value) => String(value).replace(/\s+/g, " ").trim();

/** 复制一份出厂形态的段列表（head 段先带全量正文，摆位函数会按 position 重排）。 */
function sectionsFor() {
  return [
    { name: INJECT_SECTION, text: body, order: GLOBAL_PROMPT_ORDER, interpolate: false },
    { name: CAPABILITY_SECTION, text: "«CAP»", order: GLOBAL_PROMPT_ORDER + 1, interpolate: false },
    { name: BOOST_SECTION, text: BOOST_TEXT, order: -50000, interpolate: false },
    { name: "deployment:persona-prefix", text: "«HOST»", order: 0, interpolate: false },
    { name: "deployment:persona-suffix", text: "«HOST-SUFFIX»", order: 10200, interpolate: false },
    { name: ANCHOR_SECTION, text: "«ANCHOR»", order: ANCHOR_ORDER, interpolate: false },
  ];
}

function planFor(position) {
  return arrangeInjectedSections(sectionsFor(), {
    position,
    boostText: BOOST_TEXT,
    boostOrder: -50000,
  });
}

/** 落在这两个段名上的正文片（空占位不算）。 */
function injectPieces(plan) {
  return plan
    .filter((section) => section.name === INJECT_SECTION || section.name === INJECT_TAIL_SECTION)
    .map((section) => String(section.text || ""))
    .filter((text) => text.length > 0);
}

function missingClauses(text) {
  const hay = norm(text);
  return fixture.clauses.filter((clause) => !hay.includes(norm(clause.phrase)));
}

test("head：正文只有一份，落在 dsh-purge 段里", () => {
  const plan = planFor("head");
  const pieces = injectPieces(plan);
  assert.deepEqual(pieces, [body], "head 模式必须只有 head 段带正文");
  assert.equal(plan.find((s) => s.name === INJECT_TAIL_SECTION), undefined, "head 模式不该有尾段");
  assert.deepEqual(missingClauses(pieces.join("\n\n")).map((c) => c.id), [], "条款一条不少");
});

test("tail：头部是空占位，正文整体在尾段（条款不丢、可还原）", () => {
  const plan = planFor("tail");
  const head = plan.find((s) => s.name === INJECT_SECTION);
  const tail = plan.find((s) => s.name === INJECT_TAIL_SECTION);
  assert.equal(head.text, "", "tail 模式头部必须是空占位（渲染时被丢弃）");
  assert.equal(tail.text, body, "尾段正文必须与原文逐字节一致");
  const pieces = injectPieces(plan);
  assert.deepEqual(pieces, [body], "非空正文片只有一份");
  assert.deepEqual(missingClauses(pieces.join("\n\n")).map((c) => c.id), [], "条款一条不少");
});

test("both：两头各一份、逐字节相同，合起来仍等于原文", () => {
  const plan = planFor("both");
  const head = plan.find((s) => s.name === INJECT_SECTION);
  const tail = plan.find((s) => s.name === INJECT_TAIL_SECTION);
  assert.equal(head.text, body);
  assert.equal(tail.text, body);
  const pieces = injectPieces(plan);
  assert.equal(pieces.length, 2, "both 模式应该有两份正文片");
  const unique = [...new Set(pieces)];
  assert.deepEqual(unique, [body], "两份必须逐字节相同（合起来 == 原文）");
  assert.deepEqual(missingClauses(unique.join("\n\n")).map((c) => c.id), [], "条款一条不少");
});

test("三种落点的条款覆盖完全一致（不因拆分而分化）", () => {
  const coverage = INJECT_POSITIONS.map((position) => {
    const pieces = [...new Set(injectPieces(planFor(position)))];
    return { position, missing: missingClauses(pieces.join("\n\n")).map((c) => c.id) };
  });
  for (const row of coverage) assert.deepEqual(row.missing, [], `${row.position} 丢了条款`);
  const total = coverage.map((row) => row.missing.length);
  assert.deepEqual(total, total.map(() => 0), "三种落点都必须是零丢失");
});

test("拆段不得改写正文：两份正文片都比原文短不了", () => {
  for (const position of INJECT_POSITIONS) {
    for (const piece of injectPieces(planFor(position))) {
      assert.equal(piece.length, body.length, `${position}：正文片长度与原文不一致（被截断或加了壳）`);
      assert.equal(norm(piece), norm(body), `${position}：正文片内容与原文不一致`);
    }
  }
});

test("条款检查器能发现「只留一半」的拆分（负样本自检）", () => {
  const half = Math.floor(body.length / 2);
  const headOnly = body.slice(0, half);
  const tailOnly = body.slice(half);
  assert.ok(missingClauses(headOnly).length > 0, "只剩前半段必须报丢条款");
  assert.ok(missingClauses(tailOnly).length > 0, "只剩后半段必须报丢条款");
  assert.deepEqual(missingClauses(`${headOnly}\n\n${tailOnly}`).map((c) => c.id), [], "两半拼回原文后不丢条款");
});
