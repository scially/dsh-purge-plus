#!/usr/bin/env node
/**
 * 段序只读取证：把我们自己的装配能力真跑一遍，算出发给宿主的 sections 有序列表；
 * 再静态扫宿主文件里所有 `startsWith("dsh-purge")` / `startsWith("dshpg-")` 的
 * 过滤 / 提权片段，打印它们的函数名与行号。
 *
 *   node scripts/verify-section-order.mjs --ai-base <path> [--json]
 *        [--inject head|tail|both|all] [--dsh-home <path>] [--strict-host] [--max-kb N]
 *
 * 只读：不写宿主文件、不写 tuning、不跑 apply、不调用会落盘的注入闭包
 * （正文闭包会 sync 磁盘 + 钉内存，取证只需要「哪个段在哪个位置」，正文一律用占位标记）。
 *
 * our 侧断言（失败 → 退出码 1）：
 *   1. `dsh-purge:anchor` 永远是有序列表的最后一段；
 *   2. `dshpg-boost` 落在头部组（order < 0 时排在第一个宿主段之前）；
 *   3. 注入正文段的位置与 tuning.json 的 inject 一致（head/tail/both）；
 *   4. 迷你 ctx 桩拿到的注册结果与 tuning.json 的 inject 一致。
 * 宿主侧静态扫描只打印结论；加 `--strict-host` 才会把「宿主重排会把锚点挪走」也算进退出码。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArgs(argv) {
  const out = { aiBase: "", json: false, inject: "", dshHome: "", strictHost: false, maxKb: 16384 };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const at = raw.indexOf("=");
    const key = at >= 0 ? raw.slice(0, at) : raw;
    const inline = at >= 0 ? raw.slice(at + 1) : "";
    const value = () => (at >= 0 ? inline : String(argv[++i] ?? ""));
    if (key === "--ai-base") out.aiBase = value();
    else if (key === "--inject") out.inject = value();
    else if (key === "--dsh-home") out.dshHome = value();
    else if (key === "--max-kb") out.maxKb = Number(value()) || 8192;
    else if (key === "--json") out.json = true;
    else if (key === "--strict-host") out.strictHost = true;
    else if (key === "--help" || key === "-h") out.help = true;
  }
  return out;
}

const USAGE = [
  "用法: node scripts/verify-section-order.mjs --ai-base <path> [--json]",
  "      [--inject head|tail|both|all] [--dsh-home <path>] [--strict-host] [--max-kb N]",
  "",
  "  --ai-base      宿主安装树（@deepseek-ai 目录，或含它的上层目录）",
  "  --inject       只看某个落点；默认读 $DSH_HOME/dsh-purge/tuning.json；all = 三种都跑",
  "  --dsh-home     覆盖 DSH 主目录（默认走 lib/core.js 的 findDshHome）",
  "  --strict-host  宿主重排规则若把锚点挪走，也算失败（退出码 1）",
].join("\n");

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.aiBase) {
  console.log(USAGE);
  process.exit(args.help ? 0 : 2);
}

const aiBase = path.resolve(args.aiBase);
const idx = await import(pathToFileURL(path.join(REPO, "lib/index.js")).href);
const identity = await import(pathToFileURL(path.join(REPO, "lib/identity.js")).href);
const anchor = await import(pathToFileURL(path.join(REPO, "lib/anchor.js")).href);
const boost = await import(pathToFileURL(path.join(REPO, "lib/boost.js")).href);
const tuning = await import(pathToFileURL(path.join(REPO, "lib/tuning.js")).href);

const MARK = { inject: "\u00abINJECT\u00bb", boost: "\u00abBOOST\u00bb", cap: "\u00abCAP\u00bb", host: "\u00abSECTION\u00bb" };
const HOST_STAND_INS = [
  { name: "deployment:persona-prefix", order: 0 },
  { name: "harness:tools", order: 1000 },
  { name: "harness:deliverable", order: 9000 },
  { name: "harness:source", order: 10000 },
  { name: "deployment:web-surface", order: 10100 },
  { name: "deployment:persona-suffix", order: 10200 },
];

function byOrderThenName(a, b) {
  return (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** 迷你 ctx 桩：接住 systemPrompt.section（等价 test/tuning-wire.test.js 的做法）。 */
function registeredSections() {
  const registered = [];
  const ctx = { systemPrompt: { section(section) { registered.push(section); return () => {}; } } };
  idx.registerPromptSections(ctx, { enabled: true, capabilityProtocol: true });
  return registered;
}

const effective = tuning.readTuning(args.dshHome || undefined);
const effectivePosition = tuning.normalizeInjectPosition(effective.inject);
const tuningFile = tuning.tuningPath(args.dshHome || undefined);
const boostOrder = boost.readBoostOrder(args.dshHome || undefined);
const boostOn = boost.readBoost(args.dshHome || undefined);

const registered = registeredSections();
function nameOf(section) { return String(section?.name || ""); }

/** 注册结果应与 tuning 一致（这条就是「接线没断」的证据）。 */
function checkRegistration(position) {
  const problems = [];
  const head = registered.find((s) => nameOf(s) === idx.INJECT_SECTION);
  const tail = registered.find((s) => nameOf(s) === idx.INJECT_TAIL_SECTION);
  if (!head) problems.push("没注册 dsh-purge 段（宿主补丁/面板按名找段会落空）");
  if (position === "head" && tail) problems.push("head：不该注册尾段");
  if (position === "tail" && !tail) problems.push("tail：没注册尾段");
  if (position === "both" && !tail) problems.push("both：没注册尾段");
  const boostSection = registered.find((s) => nameOf(s) === boost.BOOST_SECTION);
  if (boostOn && !boostSection) problems.push("强化段开着但没注册");
  if (!boostOn && boostSection) problems.push("强化段关着却注册了");
  if (boostSection && boostSection.order !== boostOrder) problems.push(`强化段段位不符：注册 ${boostSection.order} / 期望 ${boostOrder}`);
  return problems;
}

/** 占位正文：不调我们的 text 闭包（它会 sync 磁盘），按注册代码的已知形状给标记。 */
function materialize(section) {
  const name = nameOf(section);
  if (name === idx.INJECT_SECTION) return effectivePosition === "tail" ? "" : MARK.inject;
  if (name === idx.INJECT_TAIL_SECTION) return MARK.inject;
  if (name === boost.BOOST_SECTION) return MARK.boost;
  if (name === identity.CAPABILITY_SECTION) return MARK.cap;
  return MARK.host;
}

/** 我们自己的输出：宿主按 order 排好的 assembly → identity 重写 → arrangeInjectedSections。 */
function computeOurs(position) {
  const ours = registered
    .map((section) => ({ name: nameOf(section), order: section.order, text: materialize(section), interpolate: false }))
    .filter((section) => section.name !== boost.BOOST_SECTION || boostOn);
  const hostSections = HOST_STAND_INS.map((section) => ({ ...section, text: MARK.host, interpolate: false }));
  const assembled = {
    sections: [...ours, ...hostSections].sort(byOrderThenName),
    contexts: [],
    tools: [],
    variables: {},
  };
  const rewritten = identity.rewritePromptAssembly(assembled, {
    fallbackInject: MARK.inject,
    context: {},
    // anchorTextFor 才是插件实际走的那条路（ANCHOR_TEXT 本身没导出）。
    anchorText: anchor.anchorTextFor({}),
  });
  return idx.arrangeInjectedSections(rewritten.sections, {
    position,
    boostText: boostOn ? MARK.boost : "",
    boostOrder,
  });
}

function isPurgeName(name) {
  return String(name || "").startsWith("dsh-purge");
}

/** 宿主 0.2.1-rc.5 的 assemble() 尾段规则：非空 dsh-purge* 段整体提前；
    `dshPurgeRest` 只收「不以 dsh-purge 开头」的段 —— 空占位会被直接丢掉（与宿主逐字一致）。 */
function applyHostReorder(list, kind) {
  if (kind !== "purge-first" && kind !== "purge-last") return list;
  const hoisted = list.filter((section) => isPurgeName(section.name) && String(section.text || "").length > 0);
  const rest = list.filter((section) => !isPurgeName(section.name));
  return kind === "purge-first" ? [...hoisted, ...rest] : [...rest, ...hoisted];
}

function brief(list) {
  return list.map((section) => `${section.name}${String(section.text || "") ? `[${oneLine(section.text, 10)}]` : "(empty)"}`);
}

/** 输出用：单行 + 截断，别把 22KB 正文倒进终端。 */
function oneLine(text, max = 24) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function indexOfName(list, name) {
  return list.findIndex((section) => nameOf(section) === name);
}

/** our 侧断言：锚点最后 / boost 头部组 / 正文落点与 inject 一致。 */
function checkOurOrder(plan, position) {
  const problems = [];
  const anchorAt = indexOfName(plan, anchor.ANCHOR_SECTION);
  if (anchorAt !== plan.length - 1) problems.push(`锚点不是最后一段：index=${anchorAt} / 共 ${plan.length} 段`);
  if (plan.filter((section) => nameOf(section) === anchor.ANCHOR_SECTION).length > 1) problems.push("锚点出现多次");
  const boostAt = indexOfName(plan, boost.BOOST_SECTION);
  if (boostAt >= 0 && Number(plan[boostAt].order) < 0) {
    const firstHostAt = plan.findIndex((section) => HOST_STAND_INS.some((h) => h.name === nameOf(section)));
    if (firstHostAt >= 0 && boostAt > firstHostAt) {
      problems.push(`强化段段位 ${plan[boostAt].order} < 0，却排在宿主段之后（boost@${boostAt} > host@${firstHostAt}）`);
    }
  }
  const headAt = indexOfName(plan, idx.INJECT_SECTION);
  const tailAt = indexOfName(plan, idx.INJECT_TAIL_SECTION);
  const headText = headAt >= 0 ? String(plan[headAt].text || "") : "";
  const tailText = tailAt >= 0 ? String(plan[tailAt].text || "") : "";
  if (position === "head") {
    if (!headText) problems.push("head：头部正文段缺失或为空");
    if (tailAt >= 0) problems.push("head：不该出现尾段");
  } else if (position === "tail") {
    if (headText) problems.push("tail：头部占位必须为空");
    if (!tailText) problems.push("tail：尾段没有正文");
    else if (tailAt !== plan.length - 2) problems.push(`tail：尾段应紧贴锚点之前（index=${tailAt}）`);
  } else if (position === "both") {
    if (!headText) problems.push("both：头部正文段缺失或为空");
    if (!tailText) problems.push("both：尾段没有正文");
    else if (tailAt !== plan.length - 2) problems.push(`both：尾段应紧贴锚点之前（index=${tailAt}）`);
  }
  return problems;
}

/* ── 宿主侧静态扫描（只读） ─────────────────────────────────────────────── */

const NAME_FILTER_RE = /startsWith\(\s*(["'])(dsh-purge|dshpg-)\1\s*\)/g;

/**
 * 就近找一个「函数名」：优先显式 function/方法声明（未压缩的宿主代码都能命中），
 * 找不到再退回最近的一个 `const x = ...` 绑定名（压缩成一行时至少知道挂在哪）。
 */
function containsFunctionAround(lines, at) {
  const declName = (line) => {
    let m = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line);
    if (m) return m[1];
    m = /^\s*(?:static\s+)?(?:async\s+)?([A-Za-z0-9_$]+)\s*\([^;()]*\)\s*\{\s*$/.exec(line);
    if (m && !/^(if|for|while|switch|catch|return|function)$/.test(m[1])) return m[1];
    return "";
  };
  for (let i = at; i >= 0 && i > at - 400; i -= 1) {
    const name = declName(lines[i]);
    if (name) return name;
  }
  for (let i = at; i >= 0 && i > at - 120; i -= 1) {
    const m = /^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/.exec(lines[i]);
    if (m) return `${m[1]} (绑定)`;
  }
  return "<module>";
}

function walkJs(dir, limitKb, out, depth = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" && depth > 0) continue;
      if (depth < 6) walkJs(full, limitKb, out, depth + 1);
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
    let stat = null;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > limitKb * 1024) {
      out.skipped.push(`${path.relative(out.base, full)} (${Math.round(stat.size / 1024)} KB > ${limitKb} KB)`);
      continue;
    }
    out.files.push(full);
  }
}

function scanHost(base) {
  const found = { base, files: [], skipped: [], matches: [], reorder: [] };
  walkJs(base, args.maxKb, found);
  for (const file of found.files) {
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const rel = path.relative(base, file);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      NAME_FILTER_RE.lastIndex = 0;
      let m = NAME_FILTER_RE.exec(line);
      while (m) {
        found.matches.push({
          file: rel,
          line: i + 1,
          column: m.index + 1,
          prefix: m[2],
          fn: containsFunctionAround(lines, i),
          snippet: line.trim().slice(0, 160),
        });
        m = NAME_FILTER_RE.exec(line);
      }
    }
    // 提权（重排）片段：只看数组拼接顺序；不成对的只算 complete 分支专用。
    const perFile = [];
    const pairs = [
      ["purge-first", /\[\s*\.\.\.dshPurgeSections\s*,\s*\.\.\.dshPurgeRest\s*\]/],
      ["purge-last", /\[\s*\.\.\.dshPurgeRest\s*,\s*\.\.\.dshPurgeSections\s*\]/],
    ];
    for (const [kind, re] of pairs) {
      const hit = re.exec(text);
      if (hit) {
        const line = text.slice(0, hit.index).split(/\r?\n/).length;
        perFile.push({ kind, file: rel, line, fn: containsFunctionAround(lines, line - 1) });
      }
    }
    if (!perFile.length && /dshPurgeSections/.test(text)) {
      const at = text.indexOf("dshPurgeSections");
      const line = text.slice(0, at).split(/\r?\n/).length;
      perFile.push({ kind: "complete-only", file: rel, line, fn: containsFunctionAround(lines, line - 1) });
    }
    found.reorder.push(...perFile);
  }
  return found;
}

/* ── 跑 ─────────────────────────────────────────────────────────────────── */

const positions = args.inject === "all" ? [...tuning.INJECT_POSITIONS]
  : args.inject ? [tuning.normalizeInjectPosition(args.inject)]
  : [effectivePosition];
const registrationProblems = checkRegistration(effectivePosition);

const runs = [];
let failed = registrationProblems.length > 0;
for (const position of positions) {
  const plan = computeOurs(position);
  const problems = checkOurOrder(plan, position);
  if (problems.length) failed = true;
  runs.push({ position, problems, order: plan.map((s) => ({ name: s.name, order: s.order, text: String(s.text || "") })) });
}

const host = scanHost(aiBase);
const hostKind = host.reorder.some((r) => r.kind === "purge-first") ? "purge-first"
  : host.reorder.some((r) => r.kind === "purge-last") ? "purge-last" : "none";
const hostPredicted = runs.map((run) => {
  const predicted = applyHostReorder(run.order, hostKind);
  const anchorAt = indexOfName(predicted, anchor.ANCHOR_SECTION);
  return {
    position: run.position,
    anchorIndex: anchorAt,
    total: predicted.length,
    anchorLast: anchorAt === predicted.length - 1,
    order: brief(predicted),
  };
});
if (args.strictHost && hostPredicted.some((p) => !p.anchorLast)) failed = true;

if (args.json) {
  console.log(JSON.stringify({
    ok: !failed,
    repo: REPO,
    aiBase,
    dshHome: tuningFile || "(未定位)",
    tuning: effective,
    boost: { enabled: boostOn, order: boostOrder },
    registration: { position: effectivePosition, problems: registrationProblems, names: registered.map((s) => `${nameOf(s)}@${s.order}`) },
    runs,
    host: { files: host.files.length, skipped: host.skipped, reorder: host.reorder, reorderKind: hostKind, matches: host.matches },
    hostPredicted,
  }, null, 2));
} else {
  console.log(`[段序取证] repo=${REPO}`);
  console.log(`  ai-base: ${aiBase}`);
  console.log(`  tuning : ${tuningFile || "(未定位)"} → inject=${effective.inject} / boost=${effective.boost}`);
  console.log(`  boost  : ${boostOn ? "on" : "off"}，段位 ${boostOrder}`);
  console.log(`  注册段 : ${registered.map((s) => `${nameOf(s)}@${s.order}`).join(" , ")}`);
  if (registrationProblems.length) console.log(`     ✖ ${registrationProblems.join("；")}`);
  else console.log("     ✔ 注册结果与 tuning 一致");
  for (const run of runs) {
    console.log(`\n  ── inject=${run.position} ──`);
    for (const section of run.order) {
      console.log(`     ${String(section.order).padStart(7)}  ${section.name}${section.text ? ` [${oneLine(section.text)}]` : " (empty)"}`);
    }
    console.log(run.problems.length ? `     ✖ ${run.problems.join("；")}` : "     ✔ 锚点最后 / 落点与 inject 一致");
  }
  console.log("\n  ── 宿主静态扫描（只读）──");
  console.log(`     扫描 ${host.files.length} 个 js 文件；提权片段 ${host.reorder.length} 条，名称前缀片段 ${host.matches.length} 条`);
  for (const r of host.reorder) console.log(`     [${r.kind}] ${r.file}:${r.line} (${r.fn})`);
  for (const m of host.matches) console.log(`     [name-filter ${m.prefix}] ${m.file}:${m.line}:${m.column} (${m.fn})`);
  for (const s of host.skipped) console.log(`     [skip 超限] ${s}`);
  console.log("\n  ── 宿主重排后的预测顺序（按扫描到的规则模拟）──");
  console.log(`     rule = ${hostKind}`);
  for (const p of hostPredicted) {
    console.log(`     inject=${p.position} → 锚点 index=${p.anchorIndex}/${p.total - 1}${p.anchorLast ? " ✔ 最后" : " ✖ 不在最后"}`);
    console.log(`       ${p.order.join(" | ")}`);
  }
  const hostBad = hostPredicted.some((p) => !p.anchorLast);
  console.log(`\n  结论: our 侧${registrationProblems.length || runs.some((r) => r.problems.length) ? "✖ 不通过" : "✔ 通过"}` +
    `；宿主侧（${hostKind}）${hostKind === "none" ? "✔ 不重排" : hostBad ? "✖ 会把锚点提前 —— 锚点段名 dsh-purge:anchor 命中那条规则" : "✔ 不影响锚点"}` +
    `${args.strictHost ? "；strict-host 已计入退出码" : "（加 --strict-host 可让它计入退出码）"}`);
}

process.exit(failed ? 1 : 0);
