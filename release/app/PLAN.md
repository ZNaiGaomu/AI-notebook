# 高木的速记工坊-obsidian · 可执行方案（基础完整版）

> 状态：环境已就绪，可进入编码。
> 工程目录：`release/app`（本文件所在目录）
> 不发布 GitHub（后期你自行决定）

---

## 1. 产品定义（已锁定）

| 项 | 决定 |
|----|------|
| 显示名 | **高木的速记工坊-obsidian** |
| 包名 | `com.gaomu.suji.workshop` |
| 平台 | 仅 Android，minSdk **29** |
| 本质 | 手机网页「AI 速记」的 **原生套壳客户端**，把内容传到电脑 Obsidian 插件桥 |
| 相对浏览器增量 | **原生麦克风录音**（不受 HTTP 局域网禁麦限制） |
| 浏览器 | 继续可用，互不影响 |
| 传输 | 优先 **Tailscale**（手机已装且连通即可）；兼容同 Wi‑Fi / 公网链接 |
| AI | **不做在 App 内**；整理/转写全在电脑插件 |
| UI | 自行设计：深色、简洁、好用；信息架构对齐网页四 Tab，不 1:1 抄像素 |

---

## 2. 功能范围（基础版 = 完整对齐网页 + 语音）

### 2.1 设置 / 连接（A + C 并存）

- **A. 粘贴完整链接**
  解析 `http(s)://host:port/?t=token` → 得到 `baseUrl` + `token`
- **C. 扫描二维码**
  扫电脑插件链接窗口中的二维码（或你生成的含同一 URL 的码）→ 同样写入 baseUrl + token
- 设置页可展开：**主机 / 端口 / token** 分栏微调（A 的补充，非唯一入口）
- **测试连接**：`GET /api/ping` 或 `/api/status` → 顶部状态「已连接电脑 / 未连通」

### 2.2 目标选择

- 选择记录本（`GET /api/notebooks`）
- 新建记录本（名称 + 模板：空白/文献/灵感/会议/收藏向）`POST /api/notebooks`
- 记住默认记录本 `POST /api/notebook`
- 选择条目：新建（发送时生成）或追加到已有 `GET /api/items`
- 新建条目（标题 + 可选正文）`POST /api/items`

### 2.3 录入 Tab

| 类型 | 能力 | 三按钮 |
|------|------|--------|
| 文字 | 多行输入 | 加入待发送 / 立即发送并整理 / 仅收件箱 |
| 语音 | 原生录音 + 计时；默认 **M4A(AAC)**，设置可切 **WAV** | 同上 |
| 文件 | 系统选择器，多选 文档/图/音视频 | 同上 |

对应 API：

- `POST /api/text` · `POST /api/voice` · `POST /api/file`
- 鉴权头：`X-Bridge-Token`（或 URL `?t=`）

### 2.4 待发送 Tab（本地 Room，对齐网页 IndexedDB）

- 全选 / 取消全选
- 发送勾选 / 全部发送
- 取消勾选的发送 / 删除勾选 → 垃圾箱
- 发送进度、可边发边追加、失败保留在队列

### 2.5 垃圾箱 Tab（30 天）

- 恢复 / 永久删除勾选 / 清空
- 超时自动清理（与网页 `30 * 24h` 一致）

### 2.6 最近写入 Tab

- `GET /api/recent` + 手动刷新

---

## 3. 技术栈

| 层 | 选型 |
|----|------|
| 语言 | Kotlin |
| UI | Jetpack Compose + Material 3（深色） |
| 异步 | Kotlin Coroutines + Flow |
| 网络 | OkHttp + kotlinx.serialization（或 Moshi） |
| 本地库 | Room（queue / trash） |
| 设置 | DataStore Preferences |
| 录音 | MediaRecorder → m4a；可选 PCM/WAV 导出 |
| 扫码 | CameraX + ML Kit Barcode（或 ZXing） |
| 构建 | Gradle Kotlin DSL，AGP 与 AS 2026.1 匹配 |
| 最低系统 | minSdk 29 / compileSdk 36 或 37 / targetSdk 36 或 37 |

SDK 本机路径（写入 `local.properties`，勿依赖全局 ANDROID_HOME）：

```properties
sdk.dir=C\:\\Users\\zn217\\AppData\\Local\\Android\\Sdk
```

---

## 4. 工程目录（将创建于 `release/app`）

```
release/app/
├── ENV-CHECK.md              # 环境检测
├── PLAN.md                   # 本方案
├── README.md                 # 使用与编译说明
├── settings.gradle.kts
├── build.gradle.kts
├── gradle.properties
├── gradle/wrapper/
├── local.properties          # sdk.dir（本机）
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/gaomu/suji/workshop/
│       │   ├── SujiApp.kt
│       │   ├── MainActivity.kt
│       │   ├── ui/
│       │   │   ├── theme/          # 深色主题
│       │   │   ├── navigation/     # 四 Tab + 设置
│       │   │   ├── compose/        # 录入
│       │   │   ├── queue/          # 待发送
│       │   │   ├── trash/          # 垃圾箱
│       │   │   ├── recent/         # 最近写入
│       │   │   └── settings/       # 链接 A / 扫码 C / 音频格式
│       │   ├── data/
│       │   │   ├── db/             # Room Entity/Dao
│       │   │   ├── prefs/          # baseUrl, token, audioFormat
│       │   │   └── repo/
│       │   ├── net/
│       │   │   ├── BridgeApi.kt    # 对齐插件 /api/*
│       │   │   ├── AuthInterceptor.kt
│       │   │   └── Dto.kt
│       │   ├── voice/
│       │   │   └── AudioRecorder.kt
│       │   └── util/
│       │       ├── LinkParser.kt   # 粘贴链接解析
│       │       └── QrScan*.kt
│       └── res/
└── dist/                     # 产出 APK 复制到此（可选脚本）
```

---

## 5. 与电脑插件 API 对照（实现时严格遵守）

| App 动作 | 方法 | 路径 | 要点 |
|----------|------|------|------|
| 心跳 | GET | `/api/ping` | `{ ok, pong }` |
| 状态/本列表 | GET | `/api/status` | notebooks, notebookId, autoOrganize |
| 最近写入 | GET | `/api/recent` | items[] |
| 记录本列表 | GET | `/api/notebooks` | |
| 设默认本 | POST | `/api/notebook` | `{ notebook_id }` |
| 新建本 | POST | `/api/notebooks` | `{ name, templateId }` |
| 条目列表 | GET | `/api/items?notebook_id=` | |
| 新建条目 | POST | `/api/items` | `{ notebook_id, title, body?, capturedAt? }` |
| 发文字 | POST | `/api/text` | `{ text, organize, notebook_id?, item_id?, source, capturedAt? }` |
| 发语音 | POST | `/api/voice` | `{ audioBase64, mimeType, organize, notebook_id?, item_id?, … }` |
| 发文件 | POST | `/api/file` | `{ fileBase64, fileName, mimeType, organize, … }` |

鉴权：每个请求带 `X-Bridge-Token: <token>`（解析自链接 `t`）。

语音默认：

- 录制 `audio/mp4`（m4a/aac）→ `mimeType` 与文件名匹配插件分支
- 设置「兼容优先」→ `audio/wav`
- 插件已支持 wav / mp3 / m4a / webm；App **不默认 webm**

---

## 6. 实施阶段（可执行顺序）

### 阶段 0 — 工程骨架（0.5～1 天）

- [ ] 用 Android Studio 或手写 Gradle 创建 Application 工程于 `release/app`
- [ ] 配置 `minSdk 29`、`compileSdk 37`、`applicationId com.gaomu.suji.workshop`
- [ ] 应用名资源：`高木的速记工坊-obsidian`
- [ ] `local.properties` 指向本机 SDK
- [ ] 空壳能 **Run 到真机/模拟器**（验证环境闭环）

**验收：** 手机出现 App 图标与空白主界面。

### 阶段 1 — 连接（A + C）+ 状态（1 天）

- [ ] LinkParser：粘贴完整 URL → baseUrl + token
- [ ] DataStore 持久化
- [ ] 设置页：粘贴框 +「测试连接」
- [ ] 扫码页：解析同一 URL
- [ ] 顶栏连接 pill（ping/status）

**验收：** 粘贴 Tailscale 链接或扫码后显示「已连接电脑」。

### 阶段 2 — 文字主路径 + 记录本/条目（1～2 天）

- [ ] 拉 notebooks / items
- [ ] 新建记录本、新建条目
- [ ] 文字三按钮对接 `/api/text`
- [ ] 错误中文提示（token 无效、电脑未开入口等）

**验收：** 手机发一段字，电脑 Vault 出现笔记/收件箱。

### 阶段 3 — 原生语音（1 天）**【核心增量】**

- [ ] 录音权限、前台录音 UI + 计时
- [ ] 默认 m4a → base64 → `/api/voice`
- [ ] 设置切换 wav
- [ ] 三按钮与文字一致

**验收：** 无 HTTPS 公网也能录音并在电脑转写（需电脑 voice Provider 已配置）。

### 阶段 4 — 文件上传（0.5～1 天）

- [ ] Activity Result 文件选择（多选）
- [ ] base64 + `/api/file`

**验收：** 图片/文档进入电脑附件或收件箱逻辑与网页一致。

### 阶段 5 — 待发送 / 垃圾箱 / 进度（1～2 天）

- [ ] Room 表 queue / trash
- [ ] 离线可「加入待发送」
- [ ] 批量发送、取消、删到垃圾箱、30 天清理
- [ ] 进度条 UI

**验收：** 断网攒几条，恢复 Tailscale 后全部发出。

### 阶段 6 — 最近写入 + 打磨 + APK（1 天）

- [ ] 最近写入列表
- [ ] 主题、空态、加载态、权限说明
- [ ] `assembleDebug` / `assembleRelease`（debug 可先日常用）
- [ ] APK 复制到 `release/app/dist/`
- [ ] README：安装、填链接、权限、与电脑插件配合步骤

**验收：** 可日常替代浏览器采集；语音稳定。

---

## 7. 权限（AndroidManifest）

- `INTERNET`
- `RECORD_AUDIO`
- `CAMERA`（仅扫码；可声明可选）
- `READ_MEDIA_*` / legacy 存储按 targetSdk 选择（文件选择器用 SAF 可减少权限）
- 网络明文：若只连 `http://100.x`，需 `usesCleartextTraffic` 或 networkSecurityConfig 允许 100.64.0.0/10 与局域网（**Tailscale 多为 http**）

---

## 8. 安全

- token 仅存本机 DataStore，不上传第三方
- 不在日志打印完整 token
- README 提醒：链接=写入入口，勿发公开群
- 不内嵌 API Key（AI 密钥只在电脑插件）

---

## 9. 明确不做（基础版）

- iOS
- 应用商店上架流程
- App 内跑大模型
- 通用浏览器内核
- 修改电脑插件（除非联调发现 API 缺陷，再最小补丁）
- GitHub 发布

---

## 10. 你如何验收「能用了」

1. 电脑：Obsidian 开着，插件启用「手机网页入口」
2. 手机：Tailscale 已连，能访问 `http://100.x:27124`
3. App：粘贴或扫码链接 → 已连接
4. 发文字 → 电脑出笔记
5. 录音发送 → 电脑转写（Provider 正常时）
6. 离线加入待发送 → 联网后批量发送

---

## 11. 下一步（等你一句话）

回复 **「开始搭工程」** 或 **「按 PLAN 阶段 0 执行」**，即在 `release/app` 创建 Gradle/Compose 骨架并做到真机可安装的空 App。
