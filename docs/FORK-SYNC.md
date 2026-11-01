# 本 fork 与上游的关系、保留清单、升级流程

本仓库 `scially/dsh-purge-plus` 是 [`YuJunZhiXue/dsh-purge`](https://github.com/YuJunZhiXue/dsh-purge) 的 fork。
除下面「保留清单」里的改动外，其余代码一律跟随上游，**不自行发明轮子**。

- `upstream` → `git@github.com:YuJunZhiXue/dsh-purge.git`（只读，取上游）
- `origin` → `git@github.com:scially/dsh-purge-plus.git`（本 fork，可写）

> **第一条原则：先看上游做了什么，再决定要不要自己动手。**
> 2026-11 那次 `#32`/`#53` 就是教训：本地花了不少功夫适配 rc.5 的新布局，
> 结果上游 `af47342` 早就做了，而且更全（连 `LEGACY_` prefix 和
> `Current DeepSeek Harness ... URL` 都覆盖了）。重复劳动，最后整段丢弃。

---

## 1. 保留清单

这些是**有意的本地改动**，升级时不要被上游覆盖掉。

| commit | 内容 | 为什么必须保留 |
|---|---|---|
| `4506a9b` | 恢复「本地靶场」外部 IP 名单：`writeAllowText` 真正落盘、`permittedHost` 查名单、公网门禁先查名单再查私网、面板补回编辑框 | 上游 1.1.73「open-source local-lab only」把这块收成了空壳（`writeAllowText` 不写盘、`permittedHost` 恒 false），靶场只能填内网 IP |
| `a735867` | 把清洗面板注册进宿主「设置」菜单（`settings.section`） | 上游只提供 dock 浮层入口，没有设置页 |
| `b5a6e63` | 重启交接全程写 `restart.log`；settle 分支等到真实监听再退出 | 上游 helper 是纯黑盒（`stdio: "ignore"` + 零落盘），失败时完全无法定位 |
| `c5b9a07` | EPIPE 对照实验脚本 `scripts/verify-epipe.mjs` | 见下方第 4 节 |
| `5f98386` | `scripts/patch-dryrun.mjs`（只读诊断）、`build:client` 串上 `patch-settings-ui.mjs` | 诊断工具上游没有；`build:client` 必须重贴设置块，否则每次重建 `client.js` 都会丢 |
| `bf5ec0d` | `.gitattributes` 统一 LF | 跨平台一致 |
| 本地测试 | `test/net-scope.test.js`、`test/settings-section.test.js` + `package.json` 的 `test` 脚本 | 上游 1.1.87 把**整个 `test/` 目录和 test 脚本都删了**（理由：审计清理、删死代码）。本地这两个测试覆盖的是本地独有功能，保留 |

**已撤回的本地偏离：**

- `dshTarget`（曾改成 `0.2.1-rc.5`）。上游 1.1.88 改用
  `dshTarget: "0.2.1-rc.2"` + `dshTargets: ["0.2.1-rc.2", "0.2.1-rc.5"]`，
  且 `hostCompat` 变成 `targets.some(...)`，多版本声明更准确。
  **本地已改回跟随上游**，不要再单独改 `dshTarget`。

**有意与上游保持一致、不做的改动：**

- `#71 LIANGSHEN_IDENTITY_LINE` 的 `optional: true` —— 上游没加，本地也不加。
  未安装 `@linxin666/dsh-liangshen` 时它会显示 `missing_file`（内部状态，界面归到 `skipped`），
  不影响「已就绪」判定（`patchStatusReady("missing_file")` 返回 `true`）。
  真正的隐患是**装了梁神且其预设模板改版**时 `strictFiles` 会硬失败，届时再议。

---

## 2. 升级流程

历史血缘已在 `5f98386` 这一次接回上游（旧历史原本 clone 自
`JeffKeeping/dsh-purge-plus`，与上游无共同祖先，只能 reset + cherry-pick 重建）。
**现在 `main` 的祖先是上游 commit，普通 merge 即可，不需要再 force push。**

```powershell
git fetch upstream
git log --oneline HEAD..upstream/master        # 看这次带了什么
git merge upstream/master                      # 有共同祖先，能直接 merge
```

### 冲突高发文件

按历史经验，这几个文件必需要人工看一眼：

| 文件 | 原因 |
|---|---|
| `lib/restart-web.js` | 上游 `#197` 重写过交给逻辑（`web-reclaim.js`）；本地叠加了日志与 stdio 落文件 |
| `lib/web.js` | 同上，本地在 `spawnRestartHelper` 内加了落盘日志 |
| `lib/core.js` | 补丁定义区（`PATCHES` / `targetFiles`）几乎每次发版都动；**冲突时优先上游** |
| `client.js` | 上游改 UI 文案/CSS 的高发区；本地只在 `apply()` 末尾有一段标记块 |

### 冲突处理原则

1. **上游优先**。只有在「保留清单」里明确列出的行为才坚持本地版本。
2. `client.js` 里本地的设置页注册块被冲掉时，直接拿上游版本再跑一次：
   ```powershell
   git checkout --theirs client.js
   node scripts/patch-settings-ui.mjs        # 幂等，重复跑只替换不重复插入
   ```
   该脚本带作用域自检：注册块若被插到 `apply(ctx)` 外面（`ctx` 未定义、会被 try/catch 静默吞掉）会直接拒绝写入。
3. `lib/restart-web.js` 的 `stdio` **必须保持落文件**，不能退回上游的 `pipe`（原因见第 4 节）。

---

## 3. 升级后的验证

```powershell
node --test                                   # 本地两个测试（上游已删自己的 test 目录）
node scripts/patch-dryrun.mjs                 # 只读：逐 pattern 在宿主上试匹配，不写宿主
node scripts/verify-restart.mjs               # 用真实 spawn 参数在空闲端口(3997)跑一遍交接，不碰 3080
```

`patch-dryrun.mjs` 的读法：

- `compat: OK` —— 宿主版本命中 `dshTargets` 列表里的任意一项
- **`pending`** —— pattern 能命中，只是还没 apply，点一次 Apply 即可
- **`drifted`** —— 一条 pattern 都命中不了，上游改文案了，需要更新 pattern
- `missing_file` —— 目标组件没装（如梁神），一般无需处理

> 上游每次发版常会为新宿主版本**追加 pattern**，所以刚 merge 完出现几条 `pending` 是正常的
> （例：1.1.88 为 rc.5 补了 `#36`/`#50`/`#53`/`#57`/`#62`）。点一次 Apply 即可。

---

## 4. 两个已修复的坑（升级时别踩回去）

### 4.1 EPIPE：重启看着成功，几秒后挂掉

旧 helper 用 `stdio: ["ignore", "pipe", "pipe"]` 起新进程，只为读那行带 token 的 URL。
读完就 `process.exit(0)`，**管道读端随之关闭**；而 `dsh web` 会持续往 stdout 写日志，
下一次写就是 `EPIPE: broken pipe, write` → 进程直接死。

所以现象是：页面打开了、看着重启成功，**几秒后突然挂掉**。日志对得上：

```
17:24:11.895  new process listening on 3080
17:24:12.396  reported url
17:24:12.500  helper exit(0)      <- 管道读端消失
              ...下一次写 stdout -> EPIPE -> 崩
```

对照实验（`scripts/verify-epipe.mjs`，同一个持续写 stdout 的模拟进程）：

```
A. stdio: pipe   -> uncaughtException: EPIPE: broken pipe, write -> exit 7
B. stdio: <fd>   -> 正常存活，日志持续增长
```

修法：新进程 stdout/stderr 落到 `$DSH_HOME/dsh-purge/web-stdout.log`，
URL 改为**增量扫描该文件**获取（扫描起点是 spawn 前的文件末尾，避免读到上一次的旧 token）。

### 4.2 helper 全静默，失败零痕迹

旧 helper `stdio: "ignore"` 且不落任何文件，父进程 250ms 后 `process.exit(0)`。
一旦交接失败，用户只看到 `dsh web` 退出再也没回来，**任何日志里都查不到原因**。

现在全程写 `$DSH_HOME/dsh-purge/restart.log`，包含 payload、`waitFree` 轮询、
`taskkill`/回收结果、新进程 pid、`spawn error`、是否真的监听端口、退出码。
另外做了「端口是否被占用」探测，用来区分「新进程没起来」和「起来了但没监听」。

排查重启问题时先看这两个文件：

```powershell
Get-Content "$env:USERPROFILE\.dsh\dsh-purge\restart.log"   -Tail 40
Get-Content "$env:USERPROFILE\.dsh\dsh-purge\web-stdout.log" -Tail 40
```

---

## 5. 已知的上游问题（本地暂不修，保持与上游一致）

### 5.1 `info.url` 是死代码，「端口杀不掉时重开页面」实际不生效

上游在 `restart-web.js` 的 `waitFree` 失败分支里写了：

```js
openBrowser(info.url || "");   // 想「把页面重新打开」，避免 web 服务凭空消失
```

但 `lib/web.js` 的 `scheduleRestart()` 组装 payload 时**从来没有 `url` 字段**，
所以 `info.url` 恒为 `undefined` → `openBrowser("")` → 函数开头 `if (!url) return;` 直接返回。
**那段"重开页面"是空操作。**

真要用上，得让 `scheduleRestart` 从 `$DSH_HOME/dsh-purge/web-server-<port>.json`
（`writeRecord` 写的记录，里面有上次的带 token 地址）读出 `url` 一起传过去。
本地选择不修，避免与上游持续冲突。

### 5.2 上游删掉了整个 `test/` 目录

1.1.87 的「审计加固与死代码清理」把 `test/` 和 `package.json` 的 `test` 脚本一并移除
（`patch-status` / `profile-insert` / `score-rules` / `settle-policy` / `zip-extract` /
`web-reclaim` 等用例都没了）。本地保留了自己的两个测试与 `test` 脚本；
以后再 merge 时，若上游又动 `test/`，注意别把自己的测试一起删掉。

---

## 6. 回退

合入上游那次做过历史重建，旧历史完整保存在远端备份分支：

```powershell
git fetch origin
git reset --hard origin/backup/pre-upstream-1.1.86   # 回到合入上游前的状态
```

要撤回**某一次**本地改动，按上面的「保留清单」逐个 `git revert <commit>` 即可，
不必回退整个历史。
