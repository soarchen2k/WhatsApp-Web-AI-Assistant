# WhatsApp Web AI 助手

[English](README.md) | 中文

一个 Chrome 浏览器插件，可以导出 WhatsApp Web 对话，并使用 Google Gemini AI 生成回复建议。

## 功能特性

- 📤 **导出对话**：提取并下载完整的 WhatsApp 对话为文本文件
- 🤖 **AI 回复生成**：基于 Google Gemini AI 生成符合上下文的回复建议
- ⚙️ **自定义系统指令**：通过自定义指令和预设模板个性化 AI 的表现
- ✨ **智能集成**：将 AI 生成的回复直接插入 WhatsApp 消息输入框
- 📋 **复制到剪贴板**：方便地将生成的回复复制到其他地方使用
- 🔒 **注重隐私**：所有消息处理都在浏览器本地完成（AI 生成阶段除外，见下方"隐私与安全"）

## 安装方法

1. **下载或克隆**本仓库到本地
2. 打开 **Chrome**，进入 `chrome://extensions/`
3. 打开右上角的 **开发者模式**
4. 点击 **"加载已解压的扩展程序"**，选择本插件所在文件夹
5. 将插件**固定**到工具栏，方便随时使用

## 使用前配置

1. **获取 Gemini API Key**：
   - 访问 [Google AI Studio](https://makersuite.google.com/app/apikey)
   - 使用 Google 账号登录
   - 创建一个新的 API Key（有免费额度）

2. **配置插件**：
   - 打开 [WhatsApp Web](https://web.whatsapp.com)
   - 找到右下角的绿色悬浮 AI 按钮
   - 点击按钮，选择"Settings（设置）"
   - 输入你的 Gemini API Key 并保存
   - 可选：自定义系统指令，让 AI 回复风格更符合你的需求

## 使用方法

### 导出对话

1. 打开任意一个 WhatsApp 对话
2. 点击悬浮 AI 按钮
3. 选择"Export Conversation（导出对话）"
4. 对话会被下载为一个文本文件

### 生成 AI 回复

1. 确认已经配置好 API Key
2. 打开任意一个 WhatsApp 对话
3. 点击悬浮 AI 按钮
4. 选择"Generate AI Response（生成 AI 回复）"
5. 等待 AI 分析对话并生成回复
6. 选择复制回复内容，或直接插入到聊天输入框

**重要**：插件只会把生成的文字**填入**输入框，最终点击发送按钮的动作必须由你手动完成，插件本身不会自动发送任何消息。

### 自定义 AI 行为

1. 点击 AI 按钮，进入"Settings（设置）"
2. 在"System Instructions（系统指令）"输入框中填写自定义指令，例如：
   - "始终使用专业的语气回复"
   - "回复要简洁明了"
   - "扮演客服支持人员的角色"
   - "用西班牙语热情地回复"
3. 也可以使用预设按钮，快速套用常见指令模板
4. 保存设置

AI 会根据这些指令来调整它生成的回复内容。

## 工作原理

插件通过一系列 DOM 选择器从 WhatsApp Web 页面中提取消息：

- **收到的消息**：通过 `.message-in` 这个 CSS 类识别
- **发出的消息**：通过 `.message-out` 这个 CSS 类识别
- **消息内容**：从 `.selectable-text` 元素中提取
- **时间戳**：从消息的元数据中获取
- **群聊发送者**：从消息属性中识别

提取到的对话内容会被整理格式化后，发送给 Google 的 Gemini AI 接口，用于生成符合上下文的回复建议。

## 技术细节

### 消息检测
```javascript
// 收到的消息（如 HTML 示例所示）
document.querySelectorAll('.message-in')

// 发出的消息
document.querySelectorAll('.message-out')

// 消息容器
document.querySelectorAll('[data-testid="msg-container"]')
```

### AI 集成
- **模型**：Gemini Flash（推荐用于快速响应）
- **Temperature**：0.7（创造性与稳定性的平衡）
- **最大 Token 数**：1024
- **上下文**：最近 100 条消息

### 支持情况
- ✅ 文本消息
- ✅ 群聊
- ✅ 单聊
- ✅ 消息时间戳
- ✅ 发送者识别
- ⚠️ 媒体消息（即将支持）

## 隐私与安全

- 大部分消息处理（抓取、缓存、格式化）都在浏览器本地完成
- **但生成 AI 回复时，完整的对话文本会发送给 Google 的 Gemini API**，这不属于"纯本地处理"，请在用于真实客户对话前评估是否符合你的数据合规要求（例如是否需要脱敏、是否需要提前告知客户）
- API Key 保存在 Chrome 的 `storage.sync` 中，不会上传到本插件之外的任何服务器
- 对话缓存以明文形式保存在浏览器本地存储中；如果多人共用同一台电脑/同一个浏览器账号，请注意不同客户对话之间可能互相可见
- 插件仅在 `web.whatsapp.com` 域名下生效

## 文件结构

```
whatsapp-web-ai/
├── manifest.json          # 插件配置文件
├── content.js             # 核心功能与 WhatsApp 集成逻辑
├── styles.css             # 界面样式
├── popup.html             # 插件弹出窗口界面
├── popup.js               # 弹出窗口逻辑
├── background.js          # 后台 Service Worker
├── help.html              # 插件内帮助页（通过 _locales 支持中英双语）
├── _locales/
│   ├── en/messages.json    # 英文界面文案
│   └── zh_CN/messages.json # 简体中文界面文案
├── README.md              # 项目说明（英文）
└── README.zh-CN.md        # 项目说明（中文，本文件）
```

插件界面（弹出窗口、悬浮按钮、通知提示、设置面板、帮助页）都通过 Chrome 的 `chrome.i18n` API 做了本地化，会自动跟随浏览器的显示语言切换（目前支持英文和简体中文）。

## 开发

### 前置条件
- Chrome 浏览器
- 基本的 JavaScript/HTML/CSS 知识
- Gemini API Key

### 本地开发流程
1. 克隆仓库
2. 修改源代码
3. 在 `chrome://extensions/` 中重新加载插件
4. 在 WhatsApp Web 上测试

### 核心组件说明

**content.js**：主脚本，负责：
- 使用 CSS 选择器识别 WhatsApp 消息
- 提取对话数据
- 与 Gemini AI 接口交互
- 管理界面交互

**styles.css**：提供以下样式：
- 悬浮操作按钮
- 弹窗对话框
- 响应式布局
- 通知提示

## 常见问题排查

### 插件不生效
- 刷新 WhatsApp Web 页面
- 检查插件是否在 Chrome 中已启用
- 确认当前访问的是 `web.whatsapp.com`

### AI 回复无法生成
- 确认 API Key 输入正确
- 检查网络连接
- 确认没有超出 API 调用限额

### 消息无法提取
- 确保对话已完全加载
- 如需加载更早的消息，尝试向上滚动
- 尝试刷新页面重试

## API 调用限额

Google 的 Gemini API 存在调用限额：
- **免费额度**：每分钟 60 次请求
- **付费额度**：可获得更高的限额

## 参与贡献

1. Fork 本仓库
2. 创建功能分支
3. 进行修改
4. 在 WhatsApp Web 上充分测试
5. 提交 Pull Request

## 许可证

本项目开源，基于 MIT 许可证发布。

## 免责声明

本插件与 WhatsApp 或 Meta 官方没有任何关联，是一个独立开发的工具，旨在通过 AI 集成来增强 WhatsApp Web 的使用体验。

## 支持

如遇到问题、有建议或疑问，欢迎：
- 在 GitHub 仓库中提交 issue
- 查看 `help.zh-CN.html` 获取详细文档
- 参考上方的"常见问题排查"部分

---

**提示**：本插件需要 Google Gemini API Key 才能正常使用，请妥善保管你的 API Key，切勿公开分享。
