# AI 记录本（ai-notebook）

把「随时想到的一句话、一段录音、一张截图」稳定地写进 **Obsidian 库里的 Markdown**，并且让每一本记录本可以像小插件一样 **用蓝图定义自己的字段与视图**。电脑端插件是真相源；Android App 是口袋里的采集端。两边共用同一套记录本 / 条目 / 附件约定，而不是各写各的笔记系统。

| | |
|---|---|
| **当前版本** | `0.8.0`（第八版） |
| **插件 ID** | `ai-notebook` |
| **仓库** | [ZNaiGaomu/AI-notebook](https://github.com/ZNaiGaomu/AI-notebook) |
| **最低 Obsidian** | `1.5.0` |
| **Android** | 10+（API 29），Preview APK |
| **规格** | [`docs/V1-蓝图定稿.md`](docs/V1-蓝图定稿.md) |
| **本版说明** | [`docs/RELEASE-v0.8.0.md`](docs/RELEASE-v0.8.0.md) |

开源后欢迎继续开发，把新版本传到自己的 GitHub；他人可通过仓库地址在插件内一键导入 / 切换安装包。  
**QQ 群：1084160459** — 欢迎加入。

---

## 1. 最短安装

**插件运行时只要 3 个文件**，不必 clone 整个仓库。

```text
<库>/.obsidian/plugins/ai-notebook/
  ├── manifest.json
  ├── main.js
  └── styles.css
```

| 来源 | 做法 |
|------|------|
| **推荐** | [Releases](https://github.com/ZNaiGaomu/AI-notebook/releases/latest) 下载 `ai-notebook-v0.8.0.zip`，解压即上述三文件 |
| 仓库内 | 只用 [`release/ai-notebook/`](release/ai-notebook/) |
| Tag 源码包 | 解压后**只进入**其中的 `release/ai-notebook/`，不要把整个源码目录当插件 |

启用：设置 → 社区插件 → 关闭受限模式 → 启用 **AI 记录本**。  
更新：只覆盖这三文件，**保留**同目录 `data.json`（你的 Key 与设置）。

**Android：** 同一 Release 页下载 `suji-v0.8.0-preview.apk` 侧载。电脑插件启动手机入口 → App 设置里粘贴含 `?t=` 的链接或扫码 → 测试连接。

> Preview 为测试签名。将来若换正式签名，系统可能要求先卸载 Preview（会清空 App 本地队列与手机副本，请先发完或备份）。

---

## 2. 它解决什么问题

### 故事 A：开会时手机记，回电脑能接上

你在地铁上用 App 对着「空白本66 / 条目 qq」追加一句「客户要下周演示」。电脑 Obsidian 里，同一条 `items/qq.md` 末尾多了一段；附件若有录音，也落在该条目目录下。  
**痛点：** 很多速记 App 把内容锁在自己云里，或只丢进一个巨大收件箱再人工搬家。  
**这里：** 手机可选**记录本 + 已有条目**定向追加；离线先进待发送，联网再发。电脑端永远是可搜索的 Markdown。

### 故事 B：条目改名，附件别散架

资源管理器里把 `items/66-66-66.md` 改成 `666.md`。旧方案常留下 `attachments/.../66-66-66/`、`chat-uploads/.../66-66-66/`，甚至再长出 `666-2`。  
**0.8.0：** 改名触发全量同步——托管附件、收藏柜文件、对话上传树、未入索引残留目录一起迁到 `.../items/666/`，正文嵌入与聊天历史路径跟着改；**同一条目不会**为了「目录还在」再造 `666-2`。

### 故事 C：录了音，转写在，播放键却是灰的

桌面录音转写成功，但嵌入路径指向一次失败的迁移目标。  
**0.8.0：** 移动 / 改写 `audio_path` 前必须确认物理文件存在（fail-closed）。有字没文件时，宁可不改路径，也不写悬空 `![[...]]`。

### 故事 D：本子结构各异，但不想装十个插件

文献本要「作者 / DOI / 摘要」；会议本要「决议 / 待办」；灵感本只要时间流。  
**做法：** 每本记录本一份可版本化 **Blueprint**（字段、视图、能力开关）。「改功能」用自然语言生成蓝图 → Diff → 提交新版本。**回滚蓝图不改写已有笔记正文**（未映射 frontmatter 保留）。

### 故事 E：手机「最近」里找到上周那张图

0.7 起有原生 App；0.8 把最近页收成三层：**记录本 → 条目 → 该条写入历史**。一行一个实体，右侧进入下一级；删除在记录行上。点「打开文件」时，用 `clientSourceId` 精确对上本地副本，而不是「同名就开第一个」。

---

## 3. 系统全景

### 3.1 双端角色

```text
┌──────────────────────────┐         HTTP 桥 + token          ┌──────────────────────────┐
│  Obsidian 插件（电脑）    │ ◄──────────────────────────────► │  Android App / 手机网页   │
│  · 记录本 / 蓝图 / 条目   │                                   │  · 录入文字·录音·文件     │
│  · AI 助手 / 改功能 / STT │                                   │  · 待发送 / 垃圾箱        │
│  · 附件与收藏柜真相源     │                                   │  · 最近（只读电脑写入）   │
│  · vault 内全部 Markdown  │                                   │  · 本地副本 + 原 URI      │
└──────────────────────────┘                                   └──────────────────────────┘
                │
                ▼
        你的 Obsidian 库（本地优先；同步方式由你自己选）
```

- **插件**写库、跑 AI、管附件路径、开桥服务。  
- **App**不持有第二套笔记库；发送成功后以电脑 vault 为准。手机删除**只**动 App 私有副本与本地最近元数据，**不删**电脑文件。

### 3.2 仓库目录地图

```text
src/
  main.ts                 插件入口；vault 改名/移动事件（含 items/*.md → 全量同步）
  domain/                 类型、蓝图 schema、模板、设置默认、用途路由、能力 changelog
  services/               业务服务（见下表）
  bridge/                 手机 HTTP API + 内置网页 HTML + 公网隧道辅助
  ui/                     NotebookView、浮层助手、设置、历史切换、录音/链接模态框
  infra/                  vault 抽象、路径约定、AI HTTP、zip、音频 WAV、用户配置
  runtime/                运行时装配

release/
  ai-notebook/            ★ 可直接安装的运行时三文件
  history/vX.Y.Z/         每次 package 留下的历史安装包
  app/                    Android 工程（Kotlin · Compose）；dist/ 为本地构建产物（gitignore）

docs/                     规格与各版 RELEASE 说明
tests/                    Vitest（插件）+ Android unit tests（在 release/app）
scripts/                  build / sync-release / package / android preview·publish
```

**`src/services/` 职责（按域）**

| 服务 | 职责 |
|------|------|
| `notebookService` / `itemService` / `versionService` | 记录本与条目生命周期、蓝图版本提交/恢复 |
| `attachmentService` | 托管附件索引、按条目标签分目录、嵌入重写 |
| `itemFolderSync` **(0.8)** | 改名时编排附件 + 收藏柜 + chat-uploads + 残留目录 |
| `cabinetService` | 收藏柜 links/files；0.8 起参与条目目录同步 |
| `voicePipeline` / `voiceRetranscribe` / `voiceService` | 录音、STT、润色、阅读视图重转写 |
| `organizeService` / `inboxService` | AI 整理、收件箱吸收 |
| `assistantActions` / `featureOrchestrator` | 浮层助手写笔记、自然语言改蓝图 |
| `chatHistoryStore` / `chatUploadStore` | 按条目会话；对话上传落盘 |
| `githubReleaseService` / `pluginPackageArchive` | 多来源拉取安装包、本地备份与切换 |
| `providerResolver` | 用途 → 服务商有序回退 |

**Android（`release/app/...`）**

| 区域 | 职责 |
|------|------|
| `ui/compose` | 录入：选本/条目、文字、录音、文件 |
| `ui/queue` · `ui/trash` | 待发送、垃圾箱 |
| `ui/recent` | 三层最近导航、打开文件、行内删除 |
| `ui/settings` | 链接 / 扫码 / 主机端口令牌 |
| `data/repo` | 队列、本地最近、严格来源匹配 |
| `net/BridgeClient` | 对接电脑桥 API |

### 3.3 Vault 里长什么样

```text
AI Notebooks/
  <记录本名>/
    _notebook.md              # 本元数据
    blueprints/vNNNN.json     # 功能蓝图版本
    items/<条目标签>.md       # 用户笔记（可搜索、可同步）
    attachments/index.json    # 本内附件索引（若启用）
    cabinet/                  # 收藏柜索引

attachments/ai-notebook/
  <记录本名>/items/<条目标签>/{voice,file,...}/

attachments/ai-notebook/chat-uploads/   # 或设置中的对话上传根
  <记录本>/items/<条目标签>/chat/

AI Inbox/
  pending/ ...                # 手机「仅收件箱」等
  files/ ...                  # 收件箱二进制
```

条目标签 = `items/*.md` 文件名主干（`itemDisplayName`）。列表、助手、附件目录、手机展示都认它，而不是可被 AI 改来改去的标题字段。

### 3.4 几条关键数据流

**桌面语音**  
录音 → 写入托管 voice 附件 → STT（用途链 fan-out）→ 正文 + 隐藏标记 + `audio_path`。指派到条目或改名迁移时：**源文件存在且目标确认后**才改嵌入。

**条目改名（0.8）**  
`items/旧.md` → `items/新.md` 事件 → `syncAllItemFolderLayouts` → 多树移动 + rewrites → 保存条目、刷新叶子视图。

**手机定向发送**  
App 选 notebookId / itemId → 桥 API → 新建条目或**追加正文末尾**；文件进附件或收件箱；`clientSourceId` 写入最近，供手机回看与打开。

**最近 · 打开文件（0.8）**  
服务器最近行 + 本地 `local_recent` → 精确 ID 匹配 → 有未删副本则打开副本，否则校验原 URI 元数据再 `ACTION_VIEW`。

---

## 4. 能力地图

按「你日常会碰到的事」分域；细节命令见第 6 节。

| 域 | 你能做什么 | 关键版本 |
|----|------------|----------|
| **多本记录** | 多实例并行；模板：空白 / 文献 / 灵感 / 会议 / 收藏向；列表·表格·看板由蓝图 `views` 驱动 | 0.1+ |
| **Markdown 真相** | 条目即 `items/*.md`；手工丢进文件夹会自动吸收；非 MD 可生成引用型条目 | 0.4 |
| **蓝图 / 改功能** | 自然语言改字段与视图 → Diff → 版本历史；回滚**不砍**正文 | 0.1–0.2 |
| **浮层助手** | 针对**当前条目**改正文、插图视频、描述画面；按条目接续会话 | 0.2 |
| **多模型路由** | 改功能 / 整理·助手 / 语音 分用途；每用途 1·2·3 有序回退；OpenAI 兼容 | 0.2–0.3 |
| **语音** | 浏览器协商容器、可选 16k WAV、STT + 润色、阅读视图重转写、诊断命令 | 0.3–0.7 |
| **附件** | 与收藏柜分离；按本/条目标签分目录；嵌入预览；删除登记默认不删实体 | 0.6 |
| **改名一致** | 附件 + 柜 + chat-uploads + 残留 + 历史路径一次同步；同条目不伪碰撞 | **0.8** |
| **收藏柜** | 显式「进收藏柜」的链接/文件，与随便上传分开 | 0.1 / 0.6 |
| **收件箱** | `AI Inbox`；跨本/指定条目整理；媒体整理后可预览 | 0.6 |
| **手机网页桥** | 局域网 / Tailscale / 可选公网隧道；选本·选条·新建 | 0.1–0.5 |
| **Android App** | 原生麦、待发送、垃圾箱、扫码；来源双通道 | **0.7** |
| **最近体验** | 三层导航、行内删除、严格「打开文件」 | **0.8** |
| **插件包历史** | 多 GitHub 来源；Release 附件优先于 Tags 源码；本地备份一键切换；不碰 `data.json` | 0.3 |

---

## 5. 快速上手

1. Ribbon **AI 记录本**（或命令「打开 AI 记录本」）→ **新建记录本** → 选模板。  
2. 在本内新建条目，或直接在 `items/` 里新建 `.md`。  
3. 右下角 **助手**：针对当前条提问、插图、整理。  
4. 需要改字段/视图 → 切 **改功能** → 看 Diff → 应用。  
5. **语音录入**或手机 App / 网页入口往本或指定条目写。  
6. **历史版本**：本内蓝图一条线；插件安装包（GitHub / 本地备份）另一条线。

### Android 四步

1. 电脑启动手机入口，复制完整 URL（含 token）或出示二维码。  
2. 安装 Preview APK → 设置里保存链接 / 扫码 → 测试连接。  
3. **录入**选记录本与条目 → 文字 / 录音 / 文件 → 立即发送或进待发送。  
4. **最近**：打开条目 → 打开记录 → 「打开文件」或行内删除。

### 常用命令

| 命令 | 作用 |
|------|------|
| 打开 / 新建 / 选择记录本 | 多实例入口 |
| 用语言改功能 | 蓝图编译 + Diff |
| 语音录入到记录本 / 诊断语音转写 | 录音链路 |
| AI 整理当前条目 | 结构化当前条 |
| 手机速记 / 处理收件箱 | 收件箱 |
| 显示·启动·停止手机网页入口 | 桥服务 |
| 生成任意网络手机链接 | 公网隧道辅助 |

---

## 6. 设置与路径

| 项 | 默认 / 说明 |
|----|-------------|
| 记录本根目录 | `AI Notebooks` |
| 附件根 | `attachments/ai-notebook` |
| 对话上传位置 | `{附件根}/chat-uploads` |
| 手机收件箱 | `AI Inbox` |
| AI 服务商 | 设置内多行配置；Key 只在本机 `data.json` |
| 语音格式（App） | M4A / WAV 等 |

**隐私边界**

| 内容 | 是否进 GitHub 仓库 |
|------|-------------------|
| 源码与安装包 | 是 |
| 你的 API Key | **否**（`data.json` gitignore） |
| 你的笔记 / 录音 / 上传 | **否**（只在你的库与手机） |

离开本机的情况：你主动调用所配 AI 服务商；或拉取公开 GitHub 安装包元数据 / zip（不上传笔记）。

---

## 7. 开发与打包

```bash
npm install
npm test
npm run dev           # watch，自动同步 release/ai-notebook
npm run build         # 类型检查 + 生产包 + sync
npm run package       # build + history/vX.Y.Z
npm run android:preview   # → release/app/dist/suji-vX.Y.Z-preview.apk
npm run android:publish -- vX.Y.Z   # 校验 tag=HEAD 后上传 APK 到已有 Release
```

Android 工程也可用 Android Studio 打开 `release/app/`。单元测试若在中文路径下 ClassNotFound，可复制到 ASCII 临时目录再跑 Gradle（CI/脚本按此处理）。

---

## 8. 版本史（增量，不重复总览）

| 版本 | 增量一句话 |
|------|------------|
| **0.8.0** | 改名全量同步（附件/柜/chat-uploads/残留）；语音 fail-closed；Android 最近三层导航 + 严格打开文件 + 行内删除 |
| **0.7.0** | 原生 Android App；稳定条目标签；来源双通道；队列与最近清理保护 |
| **0.6.0** | 独立附件体系；收件箱跨本整理与媒体预览 |
| **0.5.0** | 手机定向追加已有条目；手机新建本/命名条目 |
| **0.4.0** | 手工文件吸收为条目；Tailscale 入口 |
| **0.3.x** | 插件包多来源历史与切换安全；语音流水线增强 |
| **0.2.0** | 浮层助手真写入；媒体嵌入；用途级多模型 |
| **0.1.x** | 多本、蓝图、改功能、收藏柜、收件箱与网页桥雏形 |

各版展开说明见 `docs/RELEASE-v*.md`。GitHub 上 **旧 Release / Tag 均保留**；Latest 指向当前版。

---

## 9. 许可与社区

许可见仓库 `LICENSE`。  
问题与建议：[Issues](https://github.com/ZNaiGaomu/AI-notebook/issues)。  
**QQ 群：1084160459**。
