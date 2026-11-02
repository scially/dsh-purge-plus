# toolkit 本地目录

运行目录，不是 git 内容：扫描器二进制加起来 300MB+，而且本机亚信/火绒会把
`fscan` / `gogo` / `frp` / `chisel` 当场删掉，所以仓库只带下载器
[`scripts/fetch-toolkit.mjs`](../scripts/fetch-toolkit.mjs)，二进制留在工作区并由
`.gitignore` 排除。

## 本机已装

| 工具 | 版本 | 位置 |
|---|---|---|
| nmap | 7.80 | `C:\Program Files (x86)\Nmap`（winget 安装，已加进 binDirs） |
| nuclei | 3.11.1 | 本目录 |
| httpx | 1.12.0 | 本目录 |
| dnsx | 1.3.1 | 本目录 |
| subfinder | 2.17.0 | 本目录 |
| ffuf | 2.3.0 | 本目录 |
| ksubdomain | 2.4.0 | 本目录 |
| suo5 | 2.2.0 | 本目录 |

nuclei 模板：`%USERPROFILE%\nuclei-templates`（46MB，已写进环境适配）。

## 没装上的

| 工具 | 原因 |
|---|---|
| fscan / gogo / frp / chisel | 落盘即被杀软删除（下载成功、文件随即消失） |
| masscan | 官方 release 只有源码，Windows 要 CMake/VS 自编或 WSL |
| impacket | pip 装上了库，但 `Scripts\secretsdump.py` 被杀软删；入口跑不起来 |

要补齐：换一台演练 VM，或给本目录加杀软排除，然后：

```powershell
node scripts/fetch-toolkit.mjs
node scripts/fetch-toolkit.mjs --only fscan,gogo,frp,chisel
node scripts/fetch-toolkit.mjs --list
```

默认输出 `$DSH_HOME/redteam/toolkit`；要拉到本目录用 `--out toolkit`。

## 配进插件

演练台 → `环境适配` 里 `toolkitDir` 已指向本目录、`binDirs` 含 Nmap 目录；当前自检
`8/15`，`ready: true`。
