# GitHub CI：跑什么、怎么在本地重放

`.github/workflows/ci.yml` 把「能不能编译、能不能测」压成一条闸，push（含本 fork 的 `main`）与 PR 都跑。
仓库零运行时依赖，测试只用 `node:` 内置模块，所以 CI 里**没有 `npm install`**，一个格子几十秒。

## 1. verify 矩阵

| 平台 | Node |
|---|---|
| ubuntu-latest | 22 / 24 / 26 |
| windows-latest | 26 |
| macos-latest | 26 |

每个格子跑 `.github/actions/verify`，内容就是本地这两条：

```bash
npm run check     # scripts/ci-verify.mjs
npm test          # node --test（test/*.test.js）
```

`npm run verify` = 两条连着跑（CI 用 composite action 分两步，日志好读）。

### 每步在防什么

| 步骤 | 做什么 | 防的是 |
|---|---|---|
| `syntax` | 每个 `.js/.mjs` 过一遍 `node --check` | 改崩了语法，连 parse 都过不去 |
| `link` | 真 `import` `package.json` 声明的入口 + 核心模块 | 入口路径写错、导出名拼错、模块图断链（浏览器产物 `client.js`、需要宿主 `@deepseek-ai/*` 的 `lib/redteam/tools.js` 明确列出并跳过） |
| `build` | 重跑 `build:client` + `patch-settings-ui`，比对 git 状态 | 改了 `lib/redteam/client.js` 却忘了重建 `client.js`；构建不幂等（第二轮又写盘） |
| `pack` | `npm pack --dry-run` 文件表 + `release-notes.md` 首行 = 版本号 | 发布包少文件；把 `lib/default-prompt-inject.md`、`test/`、`.github/` 打进包；版本与发版说明不一致（发布脚本本来就会硬失败） |
| `test` | `node --test` | 行为回归 |

单独跑某一步：

```bash
npm run check:syntax
npm run check:build
npm run check:pack
```

## 2. 真宿主锚点巡检（手动触发）

`Actions → CI → Run workflow`，`host_versions` 填宿主版本（逗号分隔；留空 = `package.json` 里最新的 `dshTargets`）。
本地等价命令：

```bash
node scripts/ci-host-anchor.mjs --versions 0.2.2-rc.5,0.2.1-rc.5
node scripts/ci-host-anchor.mjs --version 0.2.2-rc.5 --apply     # 连 apply 幂等性一起测
node scripts/ci-host-anchor.mjs --dir <...>/node_modules/@deepseek-ai   # 用现成宿主树，不装
```

这步会 `npm i --ignore-scripts` 装一份真宿主到临时目录（约 1.1 GB / 1 分钟），再用插件自己的补丁表
对它做只读诊断，结果与 `.github/host-baseline.json` 比：

- `matched`（= `pending + applied`）掉到 `minMatched` 以下 → 红；
- 出现 `allowedDriftedIds` 之外的失配补丁 → 红（数量没超也会红）；
- 该版本没有基线条目 → 只报告，不阻断。

`--apply` 会往那份**临时**宿主树真写一遍，然后要求：第一轮 `failed 0`、应用后 `0 pending / 0 drifted`、
第二轮 `0 写盘`。这就是 `FORK-SYNC.md` 里「Apply 一轮 → 再 Apply 一轮」那条人工验收标准的自动化版本。
加 `--keep` 保留临时目录（宿主树 + 隔离的 `DSH_HOME`）方便翻文件，跑完打印路径。

### 更新基线

宿主发新版、或有意改了补丁表之后：

```bash
npm run check:host -- --versions 0.2.2-rc.5 --keep
```

看输出的 `matched` 与失配 id，写回 `.github/host-baseline.json`（留点余量，别卡到分毫）。

## 3. 发布也要先过闸

`.github/workflows/release.yml` 增加了一个 `verify` job（同一个 composite action），`release` 排在它后面：
测试不过就不发版，不再只做一次 `node --check`。两个 job 都保留原有的
`github.repository == 'YuJunZhiXue/dsh-purge'` 判定，本 fork 上不会误触发发布。
