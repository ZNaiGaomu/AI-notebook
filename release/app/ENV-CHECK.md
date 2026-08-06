# 开发环境检测记录

检测时间：2026-08-05

## 结论

**可以开始开发「高木的速记工坊-obsidian」。**
核心工具链已齐；缺的是可选增强项（命令行 sdkmanager、系统环境变量），不阻塞 Android Studio 内编译与真机调试。

## 清单

| 组件 | 状态 | 路径 / 版本 |
|------|------|-------------|
| JDK 17 | ✅ | `C:\Program Files\Microsoft\jdk-17.0.20.8-hotspot`（17.0.20 LTS） |
| JAVA_HOME（系统） | ✅ | 已指向上述 JDK |
| Android Studio | ✅ | `C:\Program Files\Android\Android Studio` · 2026.1.3 · build `261.26222.65.2613.15948027` |
| Android SDK | ✅ | `C:\Users\zn217\AppData\Local\Android\Sdk` |
| Android platform | ✅ | `platforms\android-37.0`（API 37） |
| build-tools | ✅ | `build-tools\36.0.0` |
| platform-tools / adb | ✅ | `Sdk\platform-tools\adb.exe` |
| SDK licenses | ✅ | `Sdk\licenses\android-sdk-license` |
| sources | ✅ | `sources\android-37.0` |
| emulator 目录 | ✅ | 已有（真机优先时可不用模拟器） |
| cmdline-tools / sdkmanager | ⚠️ 未装 | 不阻塞 Studio 工程；需要命令行补包时再装 |
| ANDROID_HOME 用户/系统变量 | ⚠️ 未设 | 工程用 `local.properties` 的 `sdk.dir` 即可 |
| 中文语言包 | ⏭ 跳过 | IDE 保持英文，不影响 App 中文 UI |

## 工程约定

- 工程根目录：`C:\Users\zn217\Desktop\obsidian插件开发\release\app`
- `local.properties`（勿提交敏感信息以外内容；本机 SDK）：

```properties
sdk.dir=C\:\\Users\\zn217\\AppData\\Local\\Android\\Sdk
```

- 建议编译参数：
  - `minSdk = 29`（Android 10）
  - `compileSdk = 36` 或 `37`（本机已有 37）
  - `targetSdk = 36` 或 `37`

## 真机调试提醒

1. 手机开启「开发者选项 → USB 调试」
2. 用数据线连接后，在 Studio 或终端执行 `adb devices` 应能看到设备
3. 传输笔记仍依赖：电脑 Obsidian 插件「手机网页入口」运行中 + Tailscale `100.x` 可达
