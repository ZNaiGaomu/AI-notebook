# AI 记录本 v0.7.0（第七版）

本版是一次跨端更新：插件继续负责电脑端记录本、附件、语音与手机桥接；新增并完善原生 Android App，用于手机端录入、离线缓存和手机来源管理。

## 发布附件

GitHub Release 页面提供两个独立下载文件：

- `ai-notebook-v0.7.0.zip`：Obsidian 插件安装包，只含 `manifest.json`、`main.js`、`styles.css`
- `suji-v0.7.0-release-unsigned.apk`：Android 10+ 安装包，当前为未签名 Release 构建，适合侧载测试

Tag 的 Source code 压缩包包含完整源码和 Android 工程，不是插件安装包。

## 插件改动

- 条目在列表、AI 助手、附件归属和移动端展示中统一使用 `items/*.md` 文件名作为稳定显示名。
- 附件文件夹迁移与正文嵌入路径修复继续沿用文件名显示名。
- 语音重新转写使用 Obsidian 隐藏注释，兼容旧版 HTML 标记。
- 移动桥对显式记录本 ID 严格校验，失效目标不会静默写入另一本记录本。
- 收件箱附件路径限制在受控 inbox 文件目录，拒绝目录穿越和任意 vault 文件移动。
- 修复离线移动网页“语音仅收件箱”缓存后继续访问已清空录音状态的问题。

## Android 改动

- 加入待发送后立即清空文件选择状态。
- 文件处理期间禁用操作，防止连续点击重复入队。
- 同一批文件按原始 URI 去重，同名但 URI 不同的文件仍可分别上传。
- 队列、垃圾箱和手机最近记录保留 `clientSourceId`、本地副本路径和原始 `content://` URI。
- 尽力申请持久化 URI 读取权限；权限失效时仍可使用 App 私有副本。
- 最近页面增加选择模式、全选、取消全选、选中数量和两级删除。
- 支持仅删除手机副本，或同时删除手机副本和手机本地最近记录。
- 待发送队列和垃圾箱仍引用来源时默认阻止删除；只有明确确认才移除手机端引用。
- 删除只作用于 App 自有 `files/sources` 和受控 `cache/sources`，不会删除电脑 vault 或服务器 Recent。
- 支持打开手机副本和打开原始文件 URI。
- 删除手机本地记录后使用手机端隐藏标记，刷新服务器 Recent 不会重新显示已清理记录。

## Android 权限与兼容性

- 最低版本：Android 10（API 29）
- 网络权限：连接电脑端桥服务
- 录音权限：原生语音采集
- 相机权限：二维码扫描
- 原始文件 URI 是否可长期打开取决于 Android 文件提供方；App 私有副本作为兜底
- 手机端删除不会删除电脑端 Obsidian vault 文件，也不会调用服务器删除接口

## 升级说明

插件升级时只覆盖：

```text
manifest.json
main.js
styles.css
```

不要删除 Obsidian 插件目录中的 `data.json`。

Android App 与插件通过既有 HTTP 桥接接口通信。升级 App 后请确认电脑端插件已启动手机入口，并重新测试链接或二维码。

## 验证

```bash
npm test
npm run build
release/app/gradlew -p release/app compileDebugKotlin lintDebug assembleDebug
```
