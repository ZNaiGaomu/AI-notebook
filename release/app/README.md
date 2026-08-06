# 高木的速记工坊-obsidian

Android 客户端：对齐电脑 Obsidian 插件「手机网页入口」的采集能力，并支持**原生语音**（不受 HTTP 局域网禁麦限制）。

- 包名：`com.gaomu.suji.workshop`
- minSdk：29（Android 10+）
- 工程位置：本目录（`release/app`）

## 用 Android Studio 打开（推荐）

1. 打开 **Android Studio**
2. **File → Open**，选择本目录：
   `C:\Users\zn217\Desktop\obsidian插件开发\release\app`
3. 等待 Gradle Sync
   - 若提示缺少 **Android SDK Platform 34**：打开 **Settings → Languages & Frameworks → Android SDK**，勾选 **Android 14.0 (API 34)** 的 Platform，Apply 安装
   - 若提示接受许可：全部 Accept
4. 手机打开 **开发者选项 → USB 调试**，用数据线连接
5. 顶部设备列表选中手机，点绿色 **Run**

也可菜单 **Build → Build Bundle(s) / APK(s) → Build APK(s)**，产物一般在：

`app/build/outputs/apk/debug/app-debug.apk`

可复制到 `dist/` 方便保存。

## GitHub Release 安装包

第七版 Release 页面提供独立 Android 安装包：

`suji-v0.7.0-preview.apk`

这是使用 Android 测试密钥签名的可安装 Preview 构建，适合 Android 10+ 侧载体验。它不是正式生产签名包；未来切换到正式签名版本时，Android 可能要求先卸载 Preview，卸载会清除 App 本地队列和手机副本。安装包不会包含在 Git 源码提交中，源码工程仍保留在本目录。

## 使用步骤

1. 电脑：Obsidian 打开库，启用 AI 笔记插件，**启动手机网页入口**
2. 复制 Tailscale / 局域网完整链接（含 `?t=` 令牌）
3. 手机：安装本 App → 右上角 **设置**
   - **方式 A**：粘贴完整链接 → 保存 → 测试连接
   - **方式 C**：扫描二维码（若电脑端展示了码，或你把链接做成码）
4. 顶栏显示 **已连接电脑** 后，在「录入」发文字 / 录音 / 文件
5. 离线时用「加入待发送」，恢复网络后在「待发送」批量发送

## 功能一览

| Tab | 能力 |
|-----|------|
| 录入 | 记录本/条目选择与新建；文字；原生录音；文件；三按钮（待发送 / 立即发送并整理 / 仅收件箱） |
| 待发送 | 本地队列、勾选发送、删到垃圾箱 |
| 垃圾箱 | 30 天、恢复/永久删除/清空 |
| 最近 | 电脑端最近写入刷新 |
| 设置 | 粘贴链接、扫码、分栏主机端口令牌、语音 M4A/WAV、测试连接 |

## 命令行编译（可选）

需本机已有 Gradle 8.2.1（Android Studio 首次同步后通常会有缓存）：

```bat
set JAVA_HOME=C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot
cd /d C:\Users\zn217\Desktop\obsidian插件开发\release\app
gradlew.bat assembleDebug
```

若 `gradlew` 缺少 `gradle/wrapper/gradle-wrapper.jar`，用 Android Studio 打开工程一次即可自动补齐。

## 与电脑插件的关系

App **只调用** 已有 HTTP 桥 API（`/api/text|voice|file|…`），不在手机跑 AI。
浏览器入口可继续使用，互不影响。

## 文档

- [ENV-CHECK.md](./ENV-CHECK.md) — 环境检测
- [PLAN.md](./PLAN.md) — 完整方案与阶段
