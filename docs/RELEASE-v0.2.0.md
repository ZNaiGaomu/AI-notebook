# AI 记录本 v0.2.0

第二版发行：浮层助手真写入、媒体嵌入、多模型回退、对话附件与完整文档。

## 安装

1. 下载下方 **`ai-notebook-v0.2.0.zip`**
2. 解压得到 `manifest.json` / `main.js` / `styles.css`
3. 复制到：`<库>/.obsidian/plugins/ai-notebook/`
4. 启用社区插件「AI 记录本」（更新时保留 `data.json`）

也可使用仓库目录：`release/ai-notebook/`

## 相对 0.1.x 的主要变化

### 浮层助手
- 默认可收为右下角按钮；可拖拽缩放并记住尺寸
- 助手可真正修改条目（正文/字段）、新建条目
- 图片/视频 `embed_in_body` 写入正文（`![[path]]`，可预览/播放）
- 本轮附件与历史上传隔离；拖拽/粘贴上传
- 按条目的会话历史；「新对话」真正新建线程
- 排队 / 引导两种追加模式

### AI 路由
- 规划 / 助手 / 语音：各 3 档有序回退（服务商 + 模型）
- 视觉能力失败时自动切换候选模型

### 附件与设置
- 上传即落盘；历史「附件…」多选打开/下载
- 对话上传路径可选电脑任意文件夹；附件保留默认永久

### 文档与工程
- README 结构化重写
- `npm run build` 自动同步 `release/ai-notebook`

## 校验

- `npm test`：62 passed  
- `npm run package`：已生成 `release/history/v0.2.0/`

## 链接

- 仓库：https://github.com/ZNaiGaomu/AI-notebook  
- 标签：`v0.2.0`  
- 完整说明：见仓库根目录 [README.md](https://github.com/ZNaiGaomu/AI-notebook/blob/main/README.md)
