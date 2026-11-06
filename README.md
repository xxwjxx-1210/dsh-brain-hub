# dsh-brain-hub

给 DeepSeek Harness 用的「第二大脑」：**Markdown 当数据库，git 当同步**。不用数据库、不用云服务，记忆就是你磁盘上的一堆 `.md` 文件。

[English](README.en.md)

## 它解决什么问题

你在网页版和 DSH 之间来回贴东西：网页版聊得深、DSH 能干活，但两边记忆不通。这个插件把三件事做进一个包：

| 层 | 干什么 |
| --- | --- |
| **记忆库** | `MEMORY.md` 核心记忆常驻注入系统提示；`notes/*.md` 一张卡一个文件；`index.json` 索引；写一次自动 `commit` + `push` |
| **卡片确认** | 网页版按规则拆好的卡片先进 `inbox/`，**你逐张过一眼**再决定「存到云端」还是「只存本地」 |
| **网页版笔记** | 侧栏网页版对话的进度存成 `progress.md`，旧稿滚进 `history/`（留最近 20 份），正文尾部再回灌进系统提示 |

会话顶栏有一枚脑形图标，点开是四步流水线：

1. **打开网页版** —— 在侧栏打开 `chat.deepseek.com`
2. **让网页版整理成卡片** —— 把提炼规则发给网页版，等它按格式吐出卡片
3. **逐张确认并保存** —— 弹窗里每张卡都有「看看全文 / 保存这张 / 不要了」
4. **备份到云端** —— `commit` + `push`，推到没推完的提交会自动补推

每一步都有状态行（第几步、共几步、当前卡在哪），第 3 步会显示「生成状态：几点生成几张、跳过几张」。

**不查重**：同一主题想存几次就存几次，文件名冲突会自动加 `-2`、`-3` 后缀，不覆盖也不静默跳过。

## 安装

```sh
# 从 npm（推荐）
dsh plugin --profile <profile> add dsh-brain-hub

# 从 GitHub
dsh plugin --profile <profile> add "github:xxwjxx-1210/dsh-brain-hub#main"

# 或从本地 tgz
dsh plugin --profile <profile> add file:/绝对路径/dsh-brain-hub-0.2.6.tgz
```

装完**从系统托盘彻底退出 DSH 再启动**（前端 bundle 只在启动时加载，热重载不会换掉它）。升级插件同理。

## 配置

写在 `<profile>/cordis.patch.yml` 的 `- id: dsh-brain-hub` 下，全部可省：

```yaml
backend: git                     # git | folder | local
memoryDir: 'D:\notes\memory'    # 记忆库（git 仓库）；默认 $DSH_HOME/memory
notesDir: 'D:\notes\webds'      # 网页版笔记；默认 $DSH_HOME/dsh_memory
remote: 'https://github.com/<你>/<私有仓库>.git'
branch: main                    # 默认 main
coreLimit: 3000                 # 核心记忆注入上限（字符）
autoPull: true                  # 启动时 pull --rebase
autoPush: true                  # 写入后自动 push
readOnly: false                 # true 时所有写工具直接拒绝
injectProgress: true            # 把 progress.md 尾部注入系统提示
```

`remote` 空着也能用，只是不推送——纯本地记忆库一样能跑。

> 配置写在 profile 层，不要写进 `node_modules/<包>/cordis.patch.yml`：那个文件会被下次安装覆盖。

## 第一次打开

装完重启 DSH，第一次点会话顶栏那枚脑子图标，会弹一次新手引导：三步用法 + 三种云端存法。选一种会给出可直接粘贴的 YAML 片段，点「知道了，开始用」后不再出现（标记存进 `<memoryDir>/hub.json`）。

## 三种云端存法

`backend` 决定记忆库怎么备份出去：

| backend | 存哪 | 要 git 吗 | 适合谁 |
| --- | --- | --- | --- |
| `git`（默认） | 记忆库目录 → 推自己的私有仓库 | 要 | 多设备同步、想有版本历史 |
| `folder` | 记忆库目录直接放在 OneDrive / 坚果云这类已同步的文件夹 | 不要 | 不想碰 git，让同步盘负责上传 |
| `local` | 只在这台电脑 | 不要 | 内容敏感，不联网备份 |

```yaml
# git
config:
  backend: git
  remote: 'https://github.com/<你>/<私有仓库>.git'

# OneDrive / 同步盘
config:
  backend: folder
  memoryDir: 'C:\Users\<你>\OneDrive\brain-hub'

# 只存本机
config:
  backend: local
```

`folder` 模式下第 4 步不会执行 `git commit`，只提示文件已保存到同步盘。

## 两张卡：云端 / 本地

确认窗口里每张卡都有两个按钮：

- **存到云端** → `notes/`，进 git，会推送。
- **只存本地** → `private/`，`.gitignore` 里永久排除，**任何情况下都不会被推送**。

判断标准很简单：**这张卡被同事或客户看到，你会不会紧张？** 会紧张就只存本地（真实客户名、报价、联系方式、未公开项目）；方法论、判断标准、脱敏案例走云端。

## 手动兜底

如果网页版那边卡住（没登录、弹「使用环境异常」、侧栏没加载完），菜单里还有两条不依赖自动注入的路：

- **复制整理规则** —— 把提炼规则复制到剪贴板，你自己粘到网页版发出去；
- **收进网页版最后的回答** —— 直接读当前对话正文、拆卡片、进第 3 步确认。

也就是说：就算第 2 步彻底不通，流程仍然走得完。

## 数据格式

```markdown
---
id: 20261105-120000-标题
title: "标题"
tags: 标签A, 标签B
created: 2026-11-05T12:00:00.000Z
updated: 2026-11-05T12:00:00.000Z
uploaded: true
---
# 标题

正文
```

`notes/` 的格式与 `dsh-memory-github` 兼容，可以直接接手旧库；`private/` 同格式，只是不进 git。

## 工具（给模型用的）

`memory_write` · `memory_search` · `memory_read` · `memory_list` · `memory_stats` · `memory_core` · `memory_update` · `memory_forget` · `memory_sync`

`readOnly: true` 时写类工具直接返回拒绝文案，不产生提交。

## RPC

`POST /api/plugin-rpc/brain-hub`，信封 `{ type:"client-request", rpcId, method, payload:{ endpoint, payload } }`。

端点：`status` `hub.settings` `hub.rename` `cards.list` `cards.save` `cards.read` `cards.update` `cards.discard` `cards.upload` `progress.save` `progress.read` `progress.history` `memory.sync` `prompt.get` `prompt.save`。

## 已知限制

- **网页版那一半靠侧栏浏览器自动化**：需要你先在侧栏里登录 `chat.deepseek.com`，且 DSH 每次重启都要重新登录一次。DeepSeek 有时会对内嵌环境弹「使用环境异常」提示，这种情况下第二步会失败，插件会把失败阶段、页面地址、输入框状态一起显示出来。
- 拆卡质量取决于提示词。规则在 `<memoryDir>/prompts/distill.md`，面板里可直接改，**改完立刻生效，不用重启**。
- 只支持单仓库单分支。多人协作要靠 git 自己解决冲突。
- 不做向量检索，搜索是标题/标签/正文加权打分。

## 开发

```powershell
cd dsh-brain-hub
node test\harness.mjs        # 宿主：假 ctx + 临时 git 仓库 + bare 远端，45 项
node test\client-apply.mjs   # 客户端：伪造 ModuleLoader，8 项
npm pack                      # 出 tgz，再 pnpm 装进 profile
```

无构建步骤、零运行时依赖，`dist/` 就是源码。

MIT License.
