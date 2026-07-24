# 🎤 AgentChat 项目面试问答集（详解版）

> 模拟面试官视角，针对 AgentChat 项目  
> 每个回答覆盖"是什么 → 为什么 → 怎么做"三层，适合深度学习

---

## 目录

| # | 问题 |
|---|------|
| 1 | AgentChat 是什么？解决了什么核心问题？ |
| 2 | Chrome CDP 是什么？为什么用它驱动 Web AI？ |
| 3 | 中国网络环境下 Chrome 启动为什么会失败？怎么修复的？ |
| 4 | 8 个 AI Provider 的降级链是怎么设计、怎么运行的？ |
| 5 | Provider Factory 模式如何消除 8 个 Adapter 的代码重复？ |
| 6 | Gemini 模型切换为什么需要等待 Angular CDK 渲染？ |
| 7 | 简体中文 UI 适配中发现了哪些 bug？怎么修？ |
| 8 | 订阅感知三级降级（Pro→Flash→ChatGPT）怎么设计？ |
| 9 | Windows 跨平台适配遇到了哪些挑战？ |
| 10 | FreeSubAgent 薄编排器怎么实现 4 角色并发？ |
| 11 | Web-SubAgent-Workflow 串行管道是怎么设计的？ |
| 12 | 你为这个项目贡献了什么？完整流程是怎样的？ |
| 13 | 选择器集中管理（locales 模块）是怎么设计的？ |
| 14 | Python SDK 是怎么实现的？为什么用 subprocess 而不是直接调用？ |
| 15 | 结构化输出（ask_structured + Pydantic）是怎么工作的？ |
| 16 | 多模态输入（ask_with_image）的技术方案经历了什么迭代？ |
| 17 | MCP Server 是怎么把 8 个 AI Provider 暴露为 MCP 工具的？ |
| 18 | 如果要把 AgentChat 扩展为生产级服务，怎么做？ |
| 19 | 项目中遇到了哪些技术难点？怎么解决的？ |
| 20 | 你在这个项目中最大的收获是什么？ |
| 21 | 可视化演示平台是怎么设计和实现的？ |
| 22 | 上游项目在你贡献后发生了哪些变化？你怎么看？ |
| 23 | 多轮对话降级时的上下文传递是怎么实现的？ |
| 24 | 可视化平台开发中踩了哪些坑？怎么排查的？ |

---

## 1. AgentChat 是什么？解决了什么核心问题？

### 先理解一个现实

你有 Gemini Pro 订阅，打开浏览器访问 `gemini.google.com`，可以免费使用 Pro Extended Thinking 做深度推理。但这是**给人用的**——你要手动打字、等回复、复制粘贴。

如果你想让一个 Agent 程序（比如 Claude Code、或者你写的量化交易脚本）自动调用 Gemini 做推理，怎么办？

**有两个选择**：

| 方案 | 方式 | 成本 |
|------|------|------|
| Gemini API | 调用 `gemini-2.5-pro` 的 HTTP API | 按 token 计费，深度推理（100万+ token）很贵 |
| Gemini Web | 打开浏览器访问 gemini.google.com | Pro 订阅用户的 Extended Thinking **免费** |

方案 2 的边际成本是零，但它是给人用的 GUI，程序没法直接调用。

**AgentChat 做的事情**：在 Chrome 浏览器和程序之间架一座桥。程序说"帮我问 Gemini 这个问题"，AgentChat 就打开 Chrome → 导航到 Gemini → 把问题输入进去 → 等 Gemini 回答完 → 把回答取回来还给程序。

```
程序（Claude Code / 量化脚本）
    │
    │  "帮我分析沪深300的因子暴露"
    ▼
AgentChat（CDP Bridge）
    │
    │  打开 Chrome → 输入 prompt → 等待 Extended Thinking → 提取结果
    ▼
Gemini Web（gemini.google.com）
    │
    │  Pro Extended Thinking，1M+ 免费思考 token
    ▼
返回分析结果给程序
```

### 为什么不用 API？

因为经济学。我们量化项目的模型分工是这样的：

- **DeepSeek-V4** → 纯数值计算（因子值、回测、VaR），按 token 计费但处理量大
- **Claude** → 编排和策略生成，对格式控制要求高
- **Gemini** → 深度推理（市场状态分析、策略逻辑审查），需要 100 万+ token 思考

如果 Gemini 的深度推理走 API，每次复杂分析的成本可能上美元级别。但 Gemini Pro 订阅者通过 Web 端使用 Extended Thinking 是免费的——这就是"技术套利"。

### 更深层的意义

AgentChat 解决的不只是"省成本"。它实现了一个重要的 AI 架构模式：**一个 LLM 驱动另一个 LLM**。

Claude Code 擅长规划，但不擅长超长链条推理。Gemini Pro Extended 擅长推理，但不会自己启动任务。AgentChat 让 Claude 做"大脑"（决定问什么），Gemini 做"思考引擎"（深度分析），两者互补。

---

## 2. Chrome CDP 是什么？为什么用它驱动 Web AI？

### CDP 是什么？

CDP = Chrome DevTools Protocol。它是 Chrome 浏览器暴露的一套底层通信协议，允许外部程序完全控制浏览器。你打开 Chrome 按 F12 看到的 DevTools 面板，底层就是通过 CDP 和浏览器通信的。

CDP 能做哪些事：

```
CDP 能力清单：
├── Page.navigate        → 让浏览器导航到指定 URL
├── Page.captureScreenshot → 截取当前页面的截图
├── Runtime.evaluate     → 在页面中执行 JavaScript 代码
├── Input.dispatchKeyEvent → 模拟键盘输入
├── Input.dispatchMouseEvent → 模拟鼠标点击
├── DOM.querySelector    → 查找页面元素
├── Target.createTarget  → 创建新标签页
└── Target.closeTarget   → 关闭标签页
```

AgentChat 的工作就是组合这些 CDP 操作：

```
1. 通过 CDP 连接 Chrome → 2. 新建标签页 → 3. 导航到 gemini.google.com
→ 4. 查找输入框元素 → 5. 模拟键盘输入 prompt → 6. 点击发送按钮
→ 7. 等待响应文本出现 → 8. 提取文本 → 9. 返回给调用方
```

### 为什么用 Playwright 而不是直接用 CDP？

CDP 是底层协议，直接用会很麻烦。Playwright 是对 CDP 的高层封装，它自动处理了很多事情：

- **自动等待**：点击按钮后自动等元素变为可交互状态
- **选择器引擎**：`page.locator('button[aria-label*="发送"]')` 比 raw CDP 的 DOM 查询方便得多
- **跨浏览器兼容**：同一套 API 支持 Chrome/Firefox/Safari

AgentChat 的核心代码中，`playwright-core` 包（~3MB，只含 CDP 连接能力）负责连接 Chrome，Python 版 `playwright`（~60MB，含浏览器生命周期管理）负责启动 Chrome 进程。

### 关键技术决策：为什么用 `connect_over_cdp` 而不是 `launch`？

```js
// 方案 A：Playwright 自己启动浏览器（launch）
const browser = await chromium.launch({ headless: true });

// 方案 B：连接到已有的 Chrome 实例（connect_over_cdp）
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
```

AgentChat 选方案 B，理由有三个：

1. **登录态持久化**：Chrome 独立进程 + `--user-data-dir=~/.chrome-debug-profile`，Google 登录 cookie 保存在 profile 目录中，下次启动自动复用。如果用 `launch`，每次都是全新 profile，需要重新登录。

2. **多 Provider 共享一个浏览器**：ChatGPT、Claude、Qwen 等 8 个 Provider 共用同一个 Chrome 实例的不同 tab，不需要为每个 Provider 启动一个独立的浏览器。

3. **用户可以在同一个 Chrome 里手动操作**：登录、验证码、模型切换等需要人工介入的操作，用户直接在 Chrome 里完成，程序通过 CDP 自动化其余部分。

---

## 3. 中国网络环境下 Chrome 启动为什么会失败？怎么修复的？

### 背景知识：Chrome 启动时会做什么？

Chrome 启动时不是只打开一个窗口那么简单。它会向 Google 的多个后端服务发起 HTTPS 请求，初始化安全组件：

```
Chrome 启动 → 并发发起 10+ HTTPS 请求：
├── accounts.google.com       → 账号同步
├── update.googleapis.com     → 组件更新检查
├── safebrowsing.googleapis.com → 安全浏览数据库更新
├── optimizationguide-pa.googleapis.com → AI 模型下载（Optimization Hints）
├── clientservices.googleapis.com → 域试用配置 (Finch)
├── playsafe.googleapis.com   → 数据保护 DLP
└── ...更多
```

### 在中国网络下会发生什么？

这是一个**三层级联故障**：

**Layer 1 — SSL 握手失败**：

GFW（Great Firewall）的 DPI（深度包检测）系统会检测到 Chrome 正在尝试连接 Google 服务器，向 TCP 连接注入 RST 包强制断开。结果：
- 无代理时：`net_error -100 (ERR_CONNECTION_CLOSED)`
- 使用 VLESS Reality 代理时：代理的 TLS spoofing（伪装 servername 为 `www.python.org`）与 Chrome 的 BoringSSL 库发生证书验证冲突 → 同样 SSL 失败

**Layer 2 — 安全组件初始化失败**：

因为 Layer 1 中所有 Google 后端的连接都失败了，Chrome 的安全组件无法完成初始化：

| 组件 | 作用 | 初始化失败后果 |
|------|------|---------------|
| Safe Browsing | 检测钓鱼/恶意网站 | 无法验证 URL 安全性 |
| Component Updater | 更新 Chrome 组件 | 组件版本过期 |
| Optimization Guide | AI 驱动的页面优化 | 优化功能不可用 |
| Data Protection DLP | 数据泄露防护 | 无法扫描 URL |

**Layer 3 — Fail-safe 阻断所有导航**：

Chrome 有一个 `DataProtectionNavigationObserver` 组件，它在每次用户导航前检查"URL 是否被安全组件扫描过"。如果安全组件全部初始化失败，这个 Observer 会进入 fail-safe 模式——阻止**所有**出站导航。

```
用户要求导航到 gemini.google.com
  → DataProtectionNavigationObserver: "需要先扫描这个 URL"
  → 安全组件全部不可用 → 无法扫描
  → 阻断导航:
      HTTP URL  → ERR_BLOCKED_BY_CLIENT
      HTTPS URL → 静默挂死（无超时，无错误码，chrome:// 地址栏永远空白）
```

**症状**：Gemini tab 的 URL 正确（`https://gemini.google.com/u/0/app`），但 `window.location.href === "about:blank"`，页面标题也是 `about:blank`。就像浏览器"想"去 Gemini 但被一个内部门禁拦住了。

### 解决方案：启动时注入 Feature Flags

关键是理解 Chrome 的 flag 系统。Chrome 有很多运行时开关（Feature Flags），可以在启动时通过命令行参数关闭某些功能。

AgentChat 的解决方案是**在 Chrome 启动时注入一组关键 flags，从 Layer 1 就切断 Google 云端的依赖链**：

```bash
# 核心 flags — 切断依赖链（这些绝对不能省略）
--disable-features=OptimizationHints,Translate,HttpsUpgrades
   ↓ 分别禁用: AI 模型下载 / 翻译服务 / HTTPS 自动升级

--disable-background-networking
   ↓ 阻断所有后台网络请求（包括组件更新、Finch 实验配置）

--disable-client-side-phishing-detection
   ↓ 禁用客户端钓鱼检测（不需要 Safe Browsing 后端）

--disable-field-trial-config
   ↓ 禁用 Finch 实验框架（不连接 Google 配置服务）

--disable-component-update
   ↓ 禁用组件更新（不连接 update.googleapis.com）

--disable-sync
   ↓ 禁用账号同步（不连接 accounts.google.com）
```

**为什么这样就解决了**：这些 flags 在 Chrome 启动的最早阶段就生效了。Layer 1 的请求根本不会发出去 → Layer 2 的安全组件不需要这些后端也能初始化 → Layer 3 的 fail-safe 不会触发。

### 为什么 Playwright 能工作而 raw CDP 不能？

这是作者深度诊断后的关键发现。

如果你用手动命令行启动 Chrome（raw CDP 方式），然后通过 CDP 的 `Page.navigate` 命令导航，导航会经过 Chrome 自己的安全组件检查 → fail-safe 触发 → 导航失败。

但 Playwright 在启动 Chromium 时会注入更多底层 flags，并且 `page.goto()` 走的是 Playwright 自己的导航路径（部分绕过 Chrome 的安全组件），所以 Playwright 启动的浏览器可以正常导航。

**因此 AgentChat 的架构中，Chrome 启动由 Playwright Python daemon 管理，程序交互通过 CDP + Playwright Node.js 进行。**

---

## 4. 8 个 AI Provider 的降级链是怎么设计、怎么运行的？

### 设计理念

AgentChat 需要保证**请求不会因为单个 AI 服务不可用而失败**。设 8 个 Provider 按能力排优先级，上一个不可用就自动尝试下一个。

### 优先级顺序及理由

```
1. Gemini (Pro Extended)  ← 推理深度最高，Extended Thinking 1M+ token
2. ChatGPT                ← 综合能力最强，结构化输出稳定
3. Claude                 ← 代码生成最精准，指令遵循业界第一
4. Qwen（通义千问）       ← 联网检索 + 中文验证
5. Kimi                   ← 长文分析 + 文献综述（中文场景强）
6. MiniMax                ← 中文对话，增量覆盖
7. MiMo                   ← 创意生成，增量覆盖
8. DeepSeek               ← 低成本兜底，1M 上下文
```

排序逻辑：
- **1-3 是"主力"**：推理/综合/代码，覆盖绝大多数任务
- **4 是"中文特化"**：Qwen 的联网搜索对中文资料检索比前三个好
- **5-7 是"增量覆盖"**：多一个可用就多一个保障
- **8 是"最后的保障"**：DeepSeek 成本最低，作为兜底

### 降级链的运行机制

```
用户请求到达
    │
    ▼
遍历 PROVIDER_CHAIN（从 index 0 开始）
    │
    ├── Gemini：创建 tab → 导航 → 鉴权检查 → 切换模型 → 输入 prompt → 等待响应
    │   ├── 成功 → 返回结果，结束链
    │   └── 失败 → 记录原因，关闭 tab，尝试下一个
    │
    ├── ChatGPT：（同样流程）
    │   ├── 成功 → 返回结果
    │   └── 失败 → 尝试下一个
    │
    └── ... 直到全部失败 → 统计失败原因 → 输出错误
```

### 失败分类

不是所有失败都一视同仁。不同类型的失败有不同的处理策略：

| 失败类型 | 判定方式 | 处理策略 |
|---------|---------|---------|
| **鉴权失败** | URL 跳转到登录页（如 `accounts.google.com`） | 降级。不能自动登录，但其他 Provider 可能已登录 |
| **网络不可达** | `page.goto` 超时（20s 无响应） | 降级。该 Provider 服务器不可达 |
| **限流** | 页面出现限流提示文本 | 降级 + 记录。下次调用可能恢复 |
| **安全过滤** | 响应包含 "I cannot fulfill" / "against policy" | **终止**。其他 Provider 大概率也拒绝 |
| **内部错误** | Provider 返回了错误但没有明确分类 | 降级。暂时不可用 |

### 超时控制

防止一个慢 Provider 吃掉所有时间：

```
总超时: 10 分钟（--timeout 可配）
单 Provider 超时: 默认 3 分钟
剩余时间 < 15 秒 → 停止尝试后续 Provider
```

### 代码结构

```js
// skills/lib/providers/chain.js — 优先级顺序（单源真相）
const PROVIDER_CHAIN = [
    { key: 'gemini', name: 'Gemini', url: '...', authDomains: [...] },
    { key: 'chatgpt', name: 'ChatGPT', ... },
    // ... 8 个
];

// skills/AgentChat-WebExtended/index.js — 降级主循环
async function tryAllProviders(browser, prompt, ctx, options) {
    for (const provider of PROVIDER_CHAIN) {
        const result = await runProvider(page, prompt, timeout, ctx);
        if (result.success) return result;  // 命中 → 结束
        // 失败 → 记录原因 → 继续下一个
    }
    // 全部失败 → 分类统计
}
```

---

## 5. Provider Factory 模式如何消除 8 个 Adapter 的代码重复？

### 问题：8 个网站各有不同的交互方式

8 个 AI 网站虽然都是"输入问题 → 等回答"的模式，但实现差异很大：

| 差异点 | Gemini | ChatGPT | Claude | Qwen |
|--------|--------|---------|--------|------|
| 输入前需要切换模型？ | 是（Pro Extended + 三级降级） | 否 | 否 | 否 |
| 输入框怎么找？ | `rich-textarea` | 普通 `contenteditable` | ProseMirror 编辑器 | React SPA 延迟 3s |
| 发送按钮在哪？ | `button[aria-label*="发送"]` | `button[data-testid="send"]` | 快捷键 `Enter` | DOM 遍历找 |
| 怎么判断回答完成？ | Action Toolbar（Copy 按钮出现） | 停止按钮消失 | Thinking 占位符消失 | 停止按钮变为 `detached` |
| 响应文本怎么取？ | `.model-response-text` | `.markdown.prose` | `.prose` | 去掉模型名前缀 |

如果为每个 Provider 写一个完整的独立函数，每个函数都有**相同的框架**（导航→找输入框→输入→发送→等待→提取）但细节不同——总共会重复约 1200 行高度相似的代码。

### 解决方案：模板方法 + 策略模式

**什么是模板方法**：定义一个算法骨架（10 步 Pipeline），将可变的部分延迟到子类/配置中实现。

**什么是策略模式**：每个 Provider 的差异"算法"封装为独立的策略对象（配置文件），运行时根据需要选择。

AgentChat 的实现是**把每个 Provider 的差异表达为配置对象，而不是重复代码**：

```
┌──────────────────────────────────────────────────────┐
│  providerFactory.js （固定模板，共 ~500 行）          │
│                                                      │
│  async function runProvider(page, prompt, timeout) {  │
│    Step 1:  navigate(page, config.url)                │
│    Step 2:  authCheck(page, config.authDomains)       │
│    Step 3:  quotaCheck(page, config.quotaPatterns)    │
│    Step 4:  preInputHook(page, config)   ← 钩子!      │
│    Step 5:  locateEditor(page, config.editorSelectors)│
│    Step 6:  inputText(page, prompt, config)  ← 钩子!  │
│    Step 7:  clickSend(page, config.sendSelectors)     │
│    Step 8:  waitStopBtn(page, config.stopSelectors)   │
│    Step 9:  waitResponse(page, config)  ← 钩子!       │
│    Step 10: postResponse(page, raw, config) ← 钩子!   │
│  }                                                     │
└──────────────────────────────────────────────────────┘
         ↑              ↑              ↑
    配置注入        配置注入        配置注入
         │              │              │
┌────────┴──────────────┴──────────────┴────────────────┐
│  8 个 adapter 配置文件（每个 ~80 行，纯数据+钩子）     │
│                                                        │
│  // gemini.js                                          │
│  module.exports = {                                    │
│    key: 'gemini',                                      │
│    editorSelectors: ['rich-textarea', ...],             │
│    sendSelectors: ['button[aria-label*="发送"]', ...], │
│    preInputHook: async (page) => { ... },  ← 钩子      │
│    input: async (page, editor, prompt) => { ... },     │
│    completionAnchor: ['button[aria-label*="Copy"]'],   │
│  };                                                    │
│                                                        │
│  // chatgpt.js — 完全不同的配置                        │
│  module.exports = {                                    │
│    key: 'chatgpt',                                     │
│    editorSelectors: ['#prompt-textarea', ...],          │
│    sendSelectors: ['button[data-testid="send"]', ...], │
│    // 没有 preInputHook — ChatGPT 不需要切换模型       │
│  };                                                    │
└────────────────────────────────────────────────────────┘
```

### 每个 Provider 需要配置什么？

```js
// 完整配置结构（JSDoc 参考）
{
    key: string,              // provider 标识（gemini/chatgpt/...）
    url: string,              // AI 网站 URL
    authDomains: string[],    // 登录页 URL 关键字 → 判断是否需要登录
    quotaPatterns: RegExp[],  // 限流提示文本模式 → 判断是否被限流

    // 输入
    editorSelectors: string[],  // 输入框 CSS 选择器列表（按序尝试）
    input: async (page, editor, prompt) => boolean,  // 输入函数 → 返回是否成功
    validateEditor: async (el) => boolean,           // 编辑框额外校验

    // 发送
    sendSelectors: string[],  // 发送按钮 CSS 选择器
    sendFallback: string,     // 按钮找不到时的备选快捷键

    // 响应等待
    responseSelectors: string[],  // 响应容器选择器
    stopSelectors: string[],      // 停止按钮选择器 → 判断是否还在生成
    completionAnchor: string[],   // 完成信号 → Action Toolbar / 特定按钮
    stabilityWindow: number,      // 文本不再变化的最短时间（ms）
    stopBtnExtensionMs: number,   // 停止按钮一直可见时额外等待（Pro Extended 3-5min 生成）

    // 钩子
    preInputHook: async (page, cfg) => void,   // 输入前（Gemini 切换模型）
    postResponseHook: async (page, text, cfg) => string, // 输出后（验证/过滤/修整）

    // 特殊检测
    stillGeneratingCheck: async (page) => boolean,  // 突发检测（Extended Thinking 暂停 6s+）
}
```

### 代码量对比

```
重构前: 8 个独立的 tryXxx() 函数，每个 ~150 行，共 ~1200 行
重构后: 1 个 factory ~500 行 + 8 个 adapter 配置 ~80 行/个 = ~1140 行
新 Provider 增加: 只加一个 ~80 行的 adapter 配置即可
```

---

## 6. Gemini 模型切换为什么需要等待 Angular CDK 渲染？

### 背景知识：Gemini 前端是什么？

Gemini 网页版是用 **Angular** 框架构建的 SPA（Single Page Application）。模型选择器的下拉菜单是用 **Angular CDK Overlay** 组件实现的——这是一个弹出层，独立于主 DOM 树渲染。

### 问题：DOM 可见 ≠ 内容可用

当 Playwright 点击"模型选择器"按钮后：

```
时间轴（毫秒）：
  0ms: Playwright 点击按钮
 50ms: CDK 在 DOM 中创建 <gem-menu-item> 元素
 50ms: CSS 渲染 → 元素在屏幕上可见，offsetParent = body
 50ms: Playwright 检测到 visible=true → 认为"菜单就绪了！"
200ms: Angular zone.js 完成变更检测 → innerText 开始填充
500ms: 所有菜单项的 innerText 填充完毕
```

**Playwright 在 50ms 时认为菜单就绪，但文本在 200-500ms 后才出现。** `waitFor({ state: 'visible' })` 只检查 DOM 是否渲染到屏幕上，不检查文本内容。

### 解决方案：`waitForMenuItemsFilled()`

```js
async function waitForMenuItemsFilled(page, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        // 轮询：不断检查菜单项的 innerText 是否有内容
        const count = await page.evaluate(() => {
            const items = document.querySelectorAll(
                'gem-menu-item, [role="menuitem"], [role="menuitemradio"]'
            );
            let filled = 0;
            for (const el of items) {
                if ((el.innerText || '').trim().length > 0) filled++;
            }
            return filled;  // 返回"有文本内容的菜单项数量"
        });
        if (count >= 2) return true;  // 至少 2 个菜单项有文本 → 菜单就绪
        await page.waitForTimeout(200); // 等 200ms 再检查
    }
    return false;  // 5 秒后还没就绪 → 失败
}
```

### 为什么阈值是 2？为什么不等于菜单项总数？

因为 `querySelectorAll` 可能匹配到隐藏的、屏幕外的、未渲染完成的菜单项（DOM 存在但不可见或未填充）。用"≥2"作为就绪信号比"== N"更鲁棒——只要有菜单项真正可用了，就可以继续操作。

### 这对其他 SPA 自动化意味着什么？

任何用 React/Angular/Vue 构建的 SPA，在自动化测试/交互时都会遇到类似问题：
- React 的 Virtual DOM → 实际 DOM 更新有批处理延迟
- Vue 的 nextTick 异步更新队列
- Angular 的 zone.js 变更检测周期

Playwright 的 `waitFor` API 面向传统 Web 页面的"DOM 渲染完成 = 页面就绪"模型，但 SPA 的 DOM 渲染完成 ≠ 数据渲染完成。**这种 gap 需要自己写轮询逻辑来填补。**

---

## 7. 简体中文 UI 适配中发现了哪些 bug？怎么修？

### 背景

Gemini Web 的 UI 语言跟 Google 账号的语言设置走。如果你的 Google 账号语言是：
- 繁体中文 → 菜单显示 "模式挑選器" / "進階" / "延長"
- 简体中文 → 菜单显示 "模式选择器" / "高等数学与代码" / "扩展"
- 英文 → 菜单显示 "Model selector" / "Advanced" / "Extended"

原代码写的是繁体 + 英文两种，简体中文账号登录后，程序要找 "延長" 或 "Extended" 但实际看到的是 "扩展"——找不到 → 报错。

### 逐条分析 6 个 bug

**Bug 1 — 已激活检测**（`includesExtended()`）：

```js
// 原代码
if (currentMode.includes('Pro延長') || currentMode.includes('Pro Extended'))
```

这段代码检查"按钮文字里是否包含 Extended 字样"来决定"是不是已经切到 Extended 模式了"。简体中文按钮文字是 "Pro扩展"，两个条件都不满足 → 以为还没激活 → 重新切换 → 浪费一轮。

**Bug 2 — Pro 模型检测**（最严重）：

```js
// 原代码：找 "含有 Pro 且含有 進階/进阶" 的菜单项
if (t.includes('Pro') && (t.includes('進階') || t.includes('进阶')) && !t.includes('Flash'))
```

简体中文菜单项的文字是：

```
3.1 Pro
高等数学与代码
```

"高等数学与代码"不包含"进阶" → 找不到 Pro 菜单项 → **整个 Flash-Lite→Pro 切换步骤返回 false** → `ERR_MODEL_DEGRADED`。

这是阻断性 bug。其他 5 个 bug 是不同程度的降级，但这个直接导致 Gemini 完全不可用。

**Bug 3 & 5 — Extended 菜单项搜索**：

```js
// 查找文字含 "延長" 或 "延长" 或 "Extended" 的菜单项
if (t.includes('延長') || t.includes('延长') || t.includes('Extended'))
```

简体中文对应文字是 "扩展"，不在匹配范围内 → 找不到 Extended 菜单项。

Bug 3 是展开思考等级子菜单前的第一次搜索，Bug 5 是展开后的第二次搜索。

**Bug 4 — 思考等级子菜单触发**：

```js
// 查找文字含 "思考程度" 或 "Thinking" 的菜单项来展开子菜单
if (t.includes('思考程度') || t.includes('Thinking') || t.includes('Thought'))
```

简体中文对应文字是 "思考等级"，不是 "思考程度" → 找不到 → 子菜单无法展开 → Extended 选项不会出现。

**Bug 6 — 切换后验证**：

```js
// 切换完成后验证按钮文字
return aria.includes('延長') || aria.includes('延长') || aria.includes('Extended');
```

即使前面的切换成功了，验证步骤仍然检测不到 "Pro扩展" → 报告错误。

### 修复方式

```diff
// Bug 1 & 6: 所有 includesExtended / includes 检测
- t.includes('延长') || t.includes('Extended')
+ t.includes('延长') || t.includes('扩展') || t.includes('Extended')

// Bug 2: Pro 模型匹配
- t.includes('进阶')
+ t.includes('进阶') || t.includes('高等数学')

// Bug 3 & 5: Extended 菜单项
- (t.includes('延長') || t.includes('延长') || t.includes('Extended'))
+ (t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended'))

// Bug 4: 思考等级子菜单
- (t.includes('思考程度') || t.includes('Thinking') || t.includes('Thought'))
+ (t.includes('思考程度') || t.includes('思考等级') || t.includes('Thinking') || t.includes('Thought'))
```

### 这个 bug 为什么会被遗漏？

作者是繁体中文用户，测试环境是繁体中文 UI。简体中文用户在他的环境中不存在。这说明了国际化测试中**用不同 locale 的账号分别跑一遍完整流程**的重要性。

---

## 8. 订阅感知三级降级（Pro→Flash→ChatGPT）怎么设计？

### 原始逻辑的问题

在修复之前，Gemini provider 的逻辑很简单：

```
ensureProExtended() → 成功：用 Pro Extended
                   → 失败：抛异常 → HTTPS 跳 ChatGPT
```

这个设计假设 **Gemini = Pro Extended**。但实际情况是：

| 用户类型 | Gemini Web 可用性 | Pro Extended 可用性 |
|---------|------------------|-------------------|
| 有 Pro 订阅 | ✅ | ✅ |
| 无 Pro 订阅（但登录了 Google 账号） | ✅ Flash 免费版 | ❌ |
| 未登录 | ❌ | ❌ |

**无 Pro 订阅的用户完全可以正常使用 Flash 免费版做推理**，质量虽然不如 Pro Extended，但比直接跳到 ChatGPT 好。而且 Flash 对 Google 账号用户完全免费。

### 新三级降级链

```
Gemini Provider 被选中
  │
  ├── Tier 1: 尝试 Pro Extended Thinking
  │     - 打开菜单 → 选 Pro 模型 → 展开思考等级 → 选扩展
  │     - 成功条件：找到 "Pro" + "高等数学/進階" + 成功切到 "扩展"
  │     - 失败条件：Pro 菜单项不存在 / Extended 选项不存在 / 切换验证失败
  │     - 失败后 → 继续 Tier 2（不抛异常）
  │
  ├── Tier 2: 降级到 Flash 免费模型
  │     - 打开菜单 → 优先选 "3.5 Flash"（全方位帮助）→ 回退 "3.1 Flash-Lite"
  │     - 成功条件：找到 Flash 菜单项 + 点击成功 + 验证 Flash 已激活
  │     - 失败条件：Flash 菜单项不存在 / 菜单无法打开
  │     - 失败后 → 继续 Tier 3
  │
  └── Tier 3: Gemini 完全不可用
        - 抛异常 → Provider 链跳到 ChatGPT
```

### `ensureFlash()` 的关键细节

```js
async function ensureFlash(page, onLog) {
    // 先检查是否已经是 Flash — 避免重复操作
    if (currentAria.includes('Flash')) return true;

    // 打开模型选择器（复用 waitForMenuItemsFilled 等待 Angular CDK 渲染）
    // 找到 Flash 菜单项：
    //   优先: "3.5 Flash"（不含 Lite/极速）— 能力更强
    //   兜底: "3.1 Flash-Lite"（含 Flash 但不含 Pro）
    //         ↑ 注意不是 "不含 Lite"，因为 Flash-Lite 本身含 "Lite"

    const flashIdx = await page.evaluate(() => {
        const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
        // 第一遍：找 "Flash" 不含 "Lite" 不含 "极速" — 这是标准 Flash
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if (t.includes('Flash') && !t.includes('Lite') && !t.includes('极速')) return i;
        }
        // 第二遍：接受 Flash-Lite 作为兜底
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if (t.includes('Flash') && !t.includes('Pro')) return i;
        }
        return -1;
    });

    // 点击 + 验证
}
```

### 作者在合并后的增强

作者合并 PR #2 后，还在这个基础上补了：

1. **`quotaPatterns`**：Flash 免费版有使用限额，超出后页面会显示 "已达到每日上限"。现在能被正确检测为 `reason='quota'`（退出码 5），而不是笼统的 `error`。

2. **`_preGenStreak` 计数器**：Flash 模式下 Short Answer（如 "42"）可能被误判为"还在生成中"，8 轮循环后强制接受，防止无限等待。

3. **日志修复**：你的 `logFn || (() => {})` 在 factory 调用时 `logFn` 参数没传，导致模型切换日志被静默吞掉。作者改成默认输出 `_tlog('gemini', msg)`。

---

## 9. Windows 跨平台适配遇到了哪些挑战？

### 挑战：两台完全不同的操作系统

AgentChat 原版写死 Linux 路径和行为。Windows 在以下方面完全不同：

**进程管理**：

```bash
# Linux：一条命令搞定
pkill -9 chrome
```

```powershell
# Windows：需要 Get-Process + Stop-Process
Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force
```

**文件路径**：

```bash
# Linux
/tmp/chrome-debug.log
~/.chrome-debug-profile
```

```powershell
# Windows 等价
$env:TEMP\chrome-debug.log
$env:USERPROFILE\.chrome-debug-profile
```

**后台进程**：

```bash
# Linux: nohup + &
nohup python3 daemon.py > /tmp/log 2>&1 &
```

```powershell
# Windows: Start-Process
Start-Process -FilePath $chrome -ArgumentList $args -PassThru
```

**环境变量**：

```bash
# Linux: source 加载
source .env
```

```powershell
# Windows: 手动解析
Get-Content .env | ForEach-Object {
    if ($_ -match '(.+?)=(.+)') {
        [Environment]::SetEnvironmentVariable($key, $val, "Process")
    }
}
```

### 意外的坑

**坑 1：PowerShell 参数转义**

Chrome 的 `--user-data-dir` 参数值包含空格（如 `C:\Users\Lzheng\.chrome-debug-profile`）。PowerShell 中传参需要处理引号嵌套，否则空格会拆散参数。

**坑 2：msiexec 安装 Node.js 失败**

`winget install OpenJS.NodeJS.LTS` 返回 `0x80072ee7`（网络受限），手动下载 msi 安装返回 1603（权限不足）。最终从 npmmirror 下载 zip 免安装版解压使用——完全绕过安装器。

**坑 3：bash 传中文给 Python 的编码破坏**

在 MINGW64 终端（Git Bash）下，`python -c "content.replace('扩展', 'Pro扩展')"` 传递给 Python 的中文字符被 GBK 编码破坏，导致替换无效。解决方案：写成独立的 `.py` 文件用 UTF-8 读写，绕过 shell 编码层。

**坑 4：Chrome 关闭最后一个 tab 导致浏览器退出**

清理旧 tab 时如果不小心关闭了所有 tab，Chrome 进程会退出，CDP 端口 9222 断开。

### 产出

| 文件 | 行数 | 作用 |
|------|------|------|
| `scripts/start-chrome.ps1` | 207 | Chrome CDP 启动器（FirstLogin / headless / Stop 三模式） |
| `scripts/connect-gemini.ps1` | 75 | Gemini tab 验证创建 + Playwright 回退 |
| `scripts/setup.bat` | 91 | 一键环境安装 |

---

## 10. FreeSubAgent 薄编排器怎么实现 4 角色并发？

### 设计原则

"薄编排器" = 自己不包含任何 Provider 实现代码。所有 AI 调用通过 `child_process.spawn()` 委托给 `AgentChat-WebExtended`。

### 为什么这样设计？

```
AgentChat-FreeSubAgent (~630 行)
    │
    │  "我要调用 Gemini 来推理"
    │
    │  child_process.spawn('node', [
    │    '../AgentChat-WebExtended/index.js',
    │    '--from=gemini',
    │    prompt
    │  ])
    │
    ▼
AgentChat-WebExtended (Provider 唯一实现)
    │
    │  所有 8 个 Provider 的真实实现在这里
    │  不存在两份代码需要同步的问题
```

**单源真相**：8 个 Provider 的 DOM 选择器、输入逻辑、响应提取逻辑只在 `AgentChat-WebExtended` 中实现一次。FreeSubAgent 和 Web-SubAgent-Workflow 都通过 subprocess 调用它，不会出现"修了一个忘了另一个"的问题。

### 4 角色分工

| 角色 | AI | 具体做什么 | Prompt 约束 |
|------|-----|-----------|------------|
| researcher | Kimi | 收集资料、背景调研、数据事实 | "用要点列出关键事实。不要运行任何代码。" |
| depth_reasoner | Gemini | 多步逻辑、数学分析、复杂推演 | "直接给出完整的分析。" |
| reviewer_retriever | Qwen | 事实核查、联网验证、交叉比对 | "每个结论标注信息来源。" |
| creative_builder | ChatGPT | 方案设计、综合报告、可执行建议 | "直接输出完整报告，不要解释方法论。" |

### 并发执行流程

```
1. Claude Code 分析任务 → 拆成 4 个子任务 → 生成 JSON Plan

2. 4 个 Worker 进程并发启动
   Worker 1: node AgentChat-WebExtended/index.js --from=kimi "收集资料..."
   Worker 2: node AgentChat-WebExtended/index.js --from=gemini "深度推理..."
   Worker 3: node AgentChat-WebExtended/index.js --from=qwen "事实核查..."
   Worker 4: node AgentChat-WebExtended/index.js --from=chatgpt "综合报告..."
   （4 个进程并行跑，各自独立 tab）

3. 等待全部完成（Promise.allSettled，单 worker 异常不影响其他）

4. 质量门：检查 ≥ 2 个有效响应 → 仲裁报告
```

### 关键设计点

- **每个 Worker 独立 tab**：不会互相干扰输入
- **跨 Worker 锁**（`lib/locks.js`）：防止两个 Worker 同时抢占同一个 Provider 的 tab
- **`--single` flag**（v3 新增）：只尝试单个 Provider 不级联，因为 FreeSubAgent 已经指定了 `--from=X`，不需要降级链

---

## 11. Web-SubAgent-Workflow 串行管道是怎么设计的？

这是上游作者在 v3 新增的 skill，和 FreeSubAgent 是互补关系。

### 与 FreeSubAgent 的对比

| | FreeSubAgent | Web-SubAgent-Workflow |
|---|---|---|
| 执行模式 | 并行（4 角色并发） | **串行**（6 步骤，有依赖关系） |
| 适用场景 | 独立维度分析 | **有前后依赖的多步任务** |
| 分支逻辑 | 无 | **有条件判断**（简单/复杂分支） |
| 角色数 | 4 | 3（Kimi → Gemini → ChatGPT）+ Claude 负责规划/合成/修复 |

### 6 步流程

```
Step 1: Claude 规划
    - 理解需求
    - 判断复杂度（简单/复杂）
    - 输出搜索关键词 + 预期产出

Step 2: Kimi 联网检索    ← 每次任务必须执行
    - 输入：Step 1 生成的综合搜索 query
    - 仅调用一次（Kimi 内部自动多轮搜索）

Step 3: Gemini 深度推理  ← 条件分支：只有"复杂"任务才执行
    - 输入：Kimi 搜到的资料
    - 触发条件：综合判断 ≥2 条复杂度指标

Step 4: Claude 综合合成
    - 输入：Kimi 资料 + (Gemini 推理)
    - 生成完整方案/报告

Step 5: ChatGPT 交叉审查
    - 输入：Claude 的完整方案
    - 逐一审查，列问题点，不给修改

Step 6: Claude 修复
    - 输入：ChatGPT 的审查意见
    - 修改方案，输出最终版
```

### 复杂度判定标准

```
复杂（触发 Step 3，≥2 项满足）：
├── 需综合多个信息源才能得出结论
├── 涉及多步逻辑推理或数学推演
├── 有非平凡架构/设计决策，或需多文件代码
├── 问题域需要领域专长
└── 用户要求"深度分析"或"全面方案"

简单（跳过 Step 3）：
├── 单事实查询
├── ≤50 行直观代码
└── 格式转换等机械工作
```

### 为什么是串行

FreeSubAgent 的 4 角色做的是不同维度——可以并行。Workflow 的步骤之间有数据依赖——Kimi 搜到的资料是 Gemini 推理的输入，Gemini 的推理是 Claude 合成的输入。这种依赖关系决定了必须串行。

---

## 12. 你为这个项目贡献了什么？完整流程是怎样的？

### 总体贡献

向 **ziwang-Physics/AgentChat** 提交了三个 PR（#2、#4 和 #5），其中 #2 和 #4 已合入主分支，#5 待审核。被项目作者加入 contributor（出现在 README 贡献者列表中）。

### PR #2：Windows 适配 + 简中修复 + 三级降级 ✅ 已合并

| 贡献 | 文件 | 说明 |
|------|------|------|
| Windows 跨平台 | `scripts/*.ps1` + `setup.bat` | Chrome CDP 启动器、Gemini tab 管理、一键安装 |
| 简体中文适配 | `geminiModelSwitch.js` | 6 处繁体/英文选择器遗漏修复（含阻断性 bug：高等数学） |
| 三级模型降级 | `geminiModelSwitch.js` + `gemini.js` | Pro Extended → Flash（免费版）→ ChatGPT |

### PR #4：选择器集中管理 + Python SDK + 结构化输出 + 多模态 + MCP Server ✅ 已合并

| 贡献 | 文件 | 说明 |
|------|------|------|
| 选择器集中管理 | `locales/gemini.js` (237行→上游优化至259行) | zh_CN/zh_TW/en/ja 四语言 profile，fuzzy 回退，auto-detect |
| Python SDK | `agentchat/` (754行→上游扩展至876行) | GeminiSession 异步管理器，AskResult 数据类，batch 并发 |
| 结构化输出 | `agentchat/structured.py` (192行→193行) | JSON schema 注入 + Pydantic 验证 + 3 次重试 |
| 多模态输入 | `agentchat/multimodal.py` (220行→296行) | 系统剪贴板粘贴方案（PowerShell/osascript/xclip 三平台） |
| MCP Server | `skills/mcp-server/` (210行→272行) | 4 个 MCP 工具：gemini_think + chat + web_ask + smoke，Zod schema |

### 上游合并后的惊人演变

两个 PR 合入后，作者在 **2 周内迭代了 52 个新 commit**（v3→v24），项目规模爆炸式增长：

| 指标 | PR #2 时 | 当前 (v24) | 变化 |
|------|---------|-----------|------|
| providerFactory | 587 行 | **1906 行** | +225% |
| geminiModelSwitch | 346 行 | **947 行** | +174% |
| skills 数量 | 3 个 | **5 个** | +2 (IndependentTasks, OneWeb) |
| lib 基础设施 | 2 个文件 | **16 个文件** | 新增 locks/plan/pageHealth/stillWorking/receipt... |
| 测试框架 | 无 | `test/run.js` | ✅ 上线 |
| 我们的代码 | git subprocess 直接传 prompt | 作者重写为 `asRe()` + `--ephemeral-tab` + `--single` | 全面强化 |

**作者做了哪些增强**：
- **重命名**：`AgentChat-WebExtended` → `AgentChat-OneWeb`，`AgentChat-FreeSubAgent` → `AgentChat-WebSubAgent`
- **类型安全**：我们的 `reParts()` 辅助函数被替换为作者自己实现的 `asRe()` 统一处理字符串/RegExp 双态
- **并发模型**：新增 `--ephemeral-tab`（独立 tab，不复用）、`--single`（单 Provider 不级联）、同 Provider 多 tab 并发
- **可靠性**：v10-v24 累计 30+ bugfix：auth 硬化、UI 适配、CDP 自救、超时预算、锁竞争、响应验证门
- **Windows 深度优化**：v15/v16/v18 三次迭代 — CDP 自动启动、Chrome 内嵌启动器、WMI breakaway + singleton detect

### 完整协作流程

```
1. 深度阅读（2 天）
   ├── 读完整 README + SKILL.md + 核心 index.js + providerFactory
   ├── 理解架构：CDP → Playwright → Provider Chain → Model Switch → Locales
   └── 发现上游 v3 重构：单体 → Provider Factory + 8 adapters

2. 本地验证 + 问题诊断（3 天）
   ├── Windows 克隆、安装依赖、登录 Gemini Pro
   ├── 第一个测试 → ERR_MODEL_DEGRADED → 6 处简中 bug
   ├── 诊断工具：dump DOM、截图菜单、逐层检查选择器
   └── 定位根因：Pro 描述 "高等数学" ≠ "进阶"

3. PR #2 开发 + 提交（3 天）→ 作者合并 ✅

4. PR #4 开发（5 天）
   ├── 方向1：locales 集中管理（4 语言 profile + 自动检测）
   ├── 方向3：Python SDK（GeminiSession + 自动路径检测）
   ├── 方向5：结构化输出（JSON schema 注入 + 重试）
   ├── 方向15：多模态（剪贴板方案 —— 踩坑：DragEvent/CDP文件选择器/Angular自定义上传全部无效）
   └── MCP Server：4 个工具，Zod schema，7/7 集成测试通过

5. 作者互动
   ├── 被加入 contributor
   ├── 作者在合并后迭代了 52 个 commit（v3→v24）：重命名 skills、asRe() 类型修复、ephemeral-tab、测试框架
   ├── 作者对我们的贡献做了深度增强：providerFactory 587→1906 行，geminiModelSwitch 346→947 行
   └── 我们的代码成为项目架构的基石，而非"外部插件"

6. PR #5：可视化演示平台 + 会话上下文（后续独立贡献，已提交）
   ├── 9 个 HTML 页面 + 1 个 HTTP 服务器（零依赖）+ 10 个 API 端点
   ├── 降级链 / 并行编排 / 串行管道 三个交互式页面连接真实 AI
   ├── 🆕 多轮对话上下文传递：降级时自动注入历史到 fallback
   ├── 🆕 短对话全量 Q&A + 长对话摘要持久化（.json 文件存储）
   └── 路径适配上游重命名（OneWeb/WebSubAgent），5 个 commit 已推送到 PR #10
```

### 关键经验

- **先理解再动手**：花 2 天阅读代码，理解了 Provider Factory 的模板方法模式后才开始改
- **PR 描述用问题→方案→验证结构**：作者一眼看到你的价值
- **不破坏现有行为**：所有修改都是追加，向后兼容
- **踩坑记录是贡献的一部分**：多模态从 DragEvent → CDP filechooser → Angular 自定义上传 → 最终剪贴板方案，这个迭代过程本身就值得写进 PR

---


## 13. 选择器集中管理（locales 模块）是怎么设计的？

### 问题根源

整个 AgentChat 代码库中，DOM 选择器散落在至少 4 个文件中，且全部硬编码。以 Gemini 为例：

- `geminiModelSwitch.js`：7 处 `button[aria-label*="模式挑选器"], button[aria-label*="Model selector"]...`
- `gemini.js` adapter：11 处 send/stop/copy/good 按钮的 aria-label
- `geminiModelSwitch.js`：6 处 `t.includes('延長') || t.includes('Extended')...`

当简体中文用户登录后，Gemini UI 显示的是"打开模式选择器""扩展""高等数学"——全部不匹配。而且如果将来有日语、韩语用户，每个人都要重复踩坑。

### 设计方案

核心原则：**把语言差异集中到数据层，核心逻辑只读取数据，不硬编码任何语言的字符串。**

```
skills/lib/locales/gemini.js  (237 行，纯数据)

  ├── PROFILES = {             ← 精确匹配优先
  │     zh_CN: { modelAria: '打开模式选择器', extended: '扩展', ... }
  │     zh_TW: { modelAria: '開啟模式挑選器', extended: '延長', ... }
  │     en:    { modelAria: 'Model selector', extended: 'Extended', ... }
  │     ja:    { modelAria: 'モデルセレクターを開く', extended: '拡張', ... }
  │   }
  │
  ├── FUZZY = {                ← 未知 locale 自动回退正则
  │     extended: /扩展|延長|Extended|拡張/i,
  │     ...
  │   }
  │
  └── API:
        detectLocale(page)      → 自动检测：navigator.language → <html lang> → 按钮反向推断
        setLocale(key)          → 手动覆盖
        txt(key)                → 获取当前 locale 的文本值（精确字符串 or RegExp）
        ariaCSS(key)            → 构建 CSS 选择器字符串
        modelBtnCSS()           → 一键获取模型按钮选择器
```

### 重构 geminiModelSwitch.js

7 处硬编码全部替换为 L 模块调用：

```js
// 之前
button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]

// 之后
modelBtnSelector()   // → 取决于当前 locale

// 之前 (page.evaluate 内部 — 这是关键坑)
const t = items[i].innerText || '';
if (t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended'))

// 之后 (RegExp 参数传递 — L 模块是 Node.js 作用域，浏览器内不可用)
const _extRe = L.txt('extended');
const idx = await page.evaluate(({extSrc, extFlags}) => {
    const re = new RegExp(extSrc, extFlags);
    ...
}, {extSrc: _extRe.source, extFlags: _extRe.flags});
```

### 关键踩坑：page.evaluate 和 Node.js 模块不互通

`L.txt()` 返回 RegExp 对象，RegExp 不能通过 `page.evaluate` 的结构化克隆传递（Playwright 只支持 JSON 可序列化的类型）。解决方案：在 Node.js 侧提取 `source` 和 `flags` 字符串，传到浏览器侧用 `new RegExp(src, flags)` 重建。

### 验证

```
$ node -e "L.setLocale('zh_CN'); console.log(L.verifyText('modelVerify'));"  → "Pro扩展"
$ node -e "L.setLocale('en'); console.log(L.verifyText('modelVerify'));"     → "Pro Extended"
$ node -e "L.setLocale(null); console.log(L.txt('extended'));"               → /扩展|延長|Extended|拡張/i
```

---

## 14. Python SDK 是怎么实现的？为什么用 subprocess 而不是直接调用？

### 架构

```
agentchat/
├── __init__.py       # 导出 GeminiSession, AskResult
├── result.py         # AskResult 数据类 (47 行)
├── session.py        # GeminiSession 异步管理器 (310 行)
├── structured.py     # 结构化输出 (192 行)
└── multimodal.py     # 多模态输入 (220 行)
```

### 核心设计：subprocess 桥接

```python
class GeminiSession:
    async def ask(self, prompt: str) -> AskResult:
        """发送 prompt，等待 AI 响应"""
        proc = await asyncio.create_subprocess_exec(
            self._node_exe,                     # 自动检测 Node.js 路径
            self._index_js,                     # skills/AgentChat-WebExtended/index.js
            f'--timeout={self._timeout_ms}',
            f'--from={self._start_from}',
            stdin=PIPE, stdout=PIPE, stderr=PIPE,
            cwd=self._project_dir,
        )
        stdout, stderr = await proc.communicate(input=prompt.encode('utf-8'))
        return self._parse_result(stdout, stderr, elapsed_ms, proc.returncode)
```

**为什么用 subprocess 而不是 require() 直接调用？**

1. **进程隔离**：WebExtended 内部有 `playwright-core` 和 CDP 连接。Chrome tab 崩溃只影响子进程，Python SDK 不受影响。
2. **兼容上游**：不需要改一行 WebExtended 代码。上游迭代后自动兼容。
3. **符合项目惯例**：FreeSubAgent 和 Web-SubAgent-Workflow 都是通过 subprocess 调用。
4. **语言边界清晰**：Python 管理 Python 的依赖（pydantic/matplotlib），Node.js 管理 Node.js 的依赖（playwright-core/MCP SDK）。

### AskResult：从 CLI 文本到结构化对象

CLI 的输出是纯文本 `stdout` + 日志 `stderr`。`_parse_result()` 从 stderr 中提取结构化信息：

```python
@dataclass
class AskResult:
    response: str          # AI 回复
    provider_used: str     # 'Gemini' — 从 stderr 正则提取 "✓ Gemini: USED"
    model_used: str        # 'Pro Extended' — 从 stderr "Pro Extended Thinking active"
    fallback_chain: list   # ['gemini','chatgpt','qwen'] — "Fallback chain: gemini → ..."
    total_time_ms: int     # 总耗时
    success: bool          # 退出码 + 响应长度综合判断
```

### 自动环境检测

```python
@staticmethod
def _find_node() -> str:
    candidates = [
        os.path.expandvars(r'%LOCALAPPDATA%\\node-v24.18.0-win-x64\\node.exe'),
        r'C:\\Program Files\\nodejs\\node.exe',
        'node',  # PATH fallback
    ]
    for c in candidates:
        if os.path.isfile(c): return c
    return 'node'
```

---

## 15. 结构化输出（ask_structured + Pydantic）是怎么工作的？

### 问题

Gemini 返回自然语言文本。程序需要的是结构化数据。如果 Gemini 某一天换了一种表达方式（"IC 均值 0.035" vs "平均 IC 为 3.5%"），下游解析就挂了。

### 方案

```python
from pydantic import BaseModel, Field

class WeatherReport(BaseModel):
    city: str
    temp: float = Field(ge=-50, le=55)
    humidity: int = Field(ge=0, le=100)
    outdoor_suitable: bool

async with GeminiSession() as gs:
    report = await gs.ask_structured(
        "查询北京今天的天气",
        schema=WeatherReport,
    )
    # → WeatherReport(city='Beijing', temp=25.0, humidity=40, outdoor_suitable=True)
```

### 实现细节

```
Step 1: _build_json_schema(schema)
    Pydantic model → model_json_schema() → 人类可读的 JSON 模板
    例: { "city": "string" (required), "temp": "number (0-100)" (optional), ... }

Step 2: Inject into prompt
    "查询北京今天的天气\n\n请严格按照以下 JSON 格式返回：\n{schema}"

Step 3: LLM returns JSON → _extract_json(text)
    处理三种格式：
      - 裸 JSON: {"city":"Beijing",...}
      - ```json 包裹: ```json\n{...}\n```
      - 文本中嵌入: "根据分析，结果为{...}，建议..."

Step 4: Pydantic 验证
    schema.model_validate_json(json_str)
    → 成功：返回 Pydantic 实例
    → 失败：告诉 LLM "格式有误：xxx"，重试（最多 3 次）

Step 5: 重试用同一 session tab
    full_prompt = f"你的上一个回复格式有误：{e}。请修正后只输出纯 JSON。"
    → Gemini 能看到上下文，知道哪里错了
```

---

## 16. 多模态输入（ask_with_image）的技术方案经历了什么迭代？

### 最终方案：系统剪贴板粘贴

```python
async with GeminiSession() as gs:
    result = await gs.ask_with_image(
        "分析这张柱状图",
        image_path="chart.png",
    )
```

流程：图片 → 系统剪贴板（PowerShell/osascript/xclip） → Playwright CDP 聚焦 Gemini 输入框 → Ctrl+V → Gemini 收到图片 → 输入文本 → 发送。

### 迭代过程（踩坑记录）

**尝试 1：DragEvent 模拟拖拽**

在浏览器端构建 `File` + `DataTransfer`，dispatch `DragEvent('drop')`。图片文件正确构建，`DataTransfer.items.add(file)` 执行成功，但 Gemini 的 rich-textarea 没有响应。原因：Angular 自定义文件上传组件拦截了原生拖拽事件，CDP 的 `dispatchEvent` 无法触发 Angular 的事件处理器——Angular zone.js 需要真实的用户手势触发变更检测。

**尝试 2：CDP `Page.setInterceptFileChooserDialog`**

点击 Gemini 的"上传文件"按钮，期望 Playwright 捕获 `filechooser` 事件。但 Angular 自定义上传组件不触发标准文件选择器——没有 `<input type="file">` 被创建，Playwright 的 `waitForEvent('filechooser')` 永远等不到。

**尝试 3：注入隐藏 `<input type="file">` + `set_input_files`**

在页面注入可见的 `<input type="file">`，用 Playwright 的 `set_input_files()`（底层是 CDP `DOM.setFileInputFiles`）设置文件，然后读 File 对象构造 DataTransfer 分发到 editor。文件成功读取并构造为 File 对象，但 DataTransfer 分发后 Gemini 仍然无响应——与尝试 1 同样的 Angular 原因。

**尝试 4：`navigator.clipboard.write()`（失败）**

在浏览器端 base64 → Blob → `ClipboardItem` → `navigator.clipboard.write()`。这个 API 需要"用户手势"（transient activation）——在 headless Chrome 中不满足，报 `DOMException: Write permission denied`。

**最终方案：系统级剪贴板 + Ctrl+V**

图片通过操作系统层写入剪贴板（Windows: PowerShell `[Clipboard]::SetImage()`，macOS: `osascript`，Linux: `xclip`），然后 Playwright 发送 `Ctrl+V` 键盘事件。Gemini 的 paste handler 能正确接收系统剪贴板中的图片（因为 `Ctrl+V` 触发了浏览器的原生 paste 事件，Angular 能监听到）。

### 验证

生成了一张编程语言流行度的柱状图（31KB PNG），发送给 Gemini Pro：

```
Gemini 回复:
该柱状图展示了 2026 年几种主要编程语言的受欢迎程度...
- 最受欢迎的语言：Python（28%，柱状图最高）
- 使用率最低的语言：Go（8%，柱状图最低）
```

---

## 17. MCP Server 是怎么把 8 个 AI Provider 暴露为 MCP 工具的？

### 背景

MCP（Model Context Protocol）是 Anthropic 发布的开放协议，定义了 LLM 客户端和外部工具服务器之间的标准通信方式。类似"AI 世界的 USB 接口"——任何实现 MCP 协议的工具，都可以被任何 MCP 兼容的 LLM 客户端（Claude Desktop、Cursor、Continue.dev）发现和调用。

AgentChat 之前只能 CLI 调用。实现 MCP Server 后：

```
配置前: Claude Code → subprocess.run("node index.js ...") → 脆弱
配置后: Claude Code → tool_call: gemini_think({prompt: "..."}) → 类型安全
```

### 架构

```
MCP Client (Claude Desktop / Cursor)
    │
    │  MCP Protocol (stdio JSON-RPC)
    ▼
skills/mcp-server/index.mjs  (~210 行)
    │
    │  child_process.spawn()
    ▼
AgentChat-WebExtended (零改动)
    │
    │  playwright-core → CDP
    ▼
Chrome → 8 AI Providers
```

### 4 个 MCP 工具

| 工具 | 功能 | 参数 Schema |
|------|------|------------|
| `gemini_think` | Pro Extended 深度推理 | `z.string()` prompt + `z.number().optional()` timeout_ms |
| `gemini_chat` | 多轮对话（tab 复用） | `z.string()` prompt |
| `web_ask` | 指定 8 Provider 提问，自动降级 | `z.string()` prompt + `z.enum([...8个值])` provider |
| `web_smoke` | 检查所有 Provider 可达性 | 无参数 |

### 关键技术决策

**1. stdio 传输**：不用 HTTP。Claude Desktop 原生支持 stdio 模式的 MCP Server——`StdioServerTransport` 十几行代码即可启动，JSON-RPC 消息通过 stdin/stdout 自动收发。

**2. Zod schema**：MCP SDK v1.x 要求工具参数用 Zod 定义。SDK 自动将 Zod schema 转为 JSON Schema 暴露给客户端；运行时自动校验参数类型——传 `timeout_ms: "abc"` 会被 Zod 拦截。

**3. spawn 子进程**：MCP Server 不包含任何 Provider 代码。每次 AI 调用通过 `child_process.spawn()` 委托给 WebExtended CLI，进程隔离保障 MCP Server 自身不受 Chrome tab 崩溃影响。

**4. 错误隔离**：每个 handler 内部 try-catch，失败返回 `{isError: true}` 而不是抛异常——不会断开 MCP 连接。

### MCP 握手流程

```
Client → Server: initialize (协议版本声明)
Server → Client: initialize result (能力声明)
Client → Server: notifications/initialized (确认)
Client → Server: tools/list (查询可用工具)
Server → Client: tools/list result (返回 4 个工具 + Zod→JSON Schema)
Client → Server: tools/call {name: "gemini_think", arguments: {prompt: "..."}}
Server → Client: tools/call result {content: [{type: "text", text: "..."}]}
```

所有握手由 SDK 自动处理。

### 验证

写了一个集成测试脚本，模拟 MCP 客户端完整握手流程：spawn MCP Server → initialize → tools/list → 验证 4 个工具及参数 schema。7/7 测试通过。

---

## 18. 如果要把 AgentChat 扩展为生产级服务，怎么做？

### 已完成的基础设施

| 里程碑 | 状态 |
|--------|------|
| MCP Server | ✅ PR #4 已合并 |
| Python SDK | ✅ PR #4 已合并 |
| 结构化输出 | ✅ PR #4 已合并 |
| 多模态输入 | ✅ PR #4 已合并 |
| 多语言支持 (zh_CN/zh_TW/en/ja) | ✅ PR #2 + #4 已合并 |
| 可视化演示平台 | ✅ PR #5 (GitHub #10) 已提交，16 文件 + 会话上下文 |

### P1 — 可靠性与容错

**分布式 Chrome Fleet**：多台机器各跑 Chrome + CDP → 负载均衡 → 单点故障无影响

**会话池管理**：预创建 N 个 Gemini tab → 连接池分配 → 空闲 tab 心跳保活 → 冷启动 15s → 1s

**智能熔断**：Provider 连续 3 次失败 → 5 分钟冷却期 → 全不可用时降级 API

### P2 — 功能增强

**LLM 自愈**：UI 更新导致选择器失效 → 自动截图 → vision model 分析 → 返回新选择器 → 自动更新 locale profile

**响应缓存**：相同 prompt 不重复推理

**Prompt 模板库**：预定义分析模板 + JSON schema 约束

---

## 19. 项目中遇到了哪些技术难点？怎么解决的？

### 难点 1：简体中文选择器全部失效（阻断性）

见 Q7。通过 Playwright CDP dump Gemini UI DOM 结构，对比代码中的匹配模式，发现 6 处不匹配。最严重的是 Pro 描述"高等数学与代码"≠"进阶"。

### 难点 2：page.evaluate 中引用 Node.js 模块

L 模块的 RegExp 对象不能通过结构化克隆传到浏览器端。解决方案：提取 `source` + `flags` 字符串传递，浏览器侧 `new RegExp()` 重建。全文件 5 处 evaluate 块都要处理，遗漏一处就运行时崩溃。

### 难点 3：多模态上传方案的 4 次迭代

见 Q16。DragEvent → CDP filechooser → set_input_files → navigator.clipboard.write → 最终只剪贴板 Ctrl+V 方案成功。每次迭代都学到了一点：Angular CDK 自定义组件的 DOM 事件处理比预想的更复杂，绕过它比硬碰它更有效。

### 难点 4：bash 传中文给 Python 的编码破坏

MINGW64 终端向 Python 传参时用 GBK 编码，Python 3 期望 UTF-8。修复字符串就破坏了。最终改写成独立 `.py` 文件用 UTF-8 读写，绕过 shell 编码层。

### 难点 5：Gemini 非 Pro 订阅者被直接跳 ChatGPT

Flash 免费版完全可用但代码逻辑不知道。新增 `ensureFlash()` 函数——三级降级让非订阅者也受益。

---

## 20. 你在这个项目中最大的收获是什么？

### 技术层面

1. **Chrome CDP 的完整应用**：从连接到 tab 管理到 DOM 交互到剪贴板权限控制——完整链路。
2. **SPA 自动化测试的深层挑战**：Angular CDK overlay 渲染延迟、zone.js 变更检测、自定义上传组件与自动化工具的兼容性——实战细节。
3. **国际化就是数据结构问题**：zh_CN/zh_TW/en/ja 四种语言的文本差异集中到一份配置即可——不需要改任何逻辑代码。
4. **系统剪贴板是可靠的跨平台桥**：当 CDP/DOM 级别的模拟被前端框架拦截时，退到 OS 层的剪贴板 + 键盘事件往往是最可靠的方案。

### 工程层面

5. **开源协作的完整流程**：两个 PR，4 个 commit，从诊断 bug 到被合并到被加入 contributor——完整的 OSS 贡献经验。
6. **跨平台工程的真实成本**：Windows/Linux/macOS 三平台剪贴板方案用了三种不同的系统命令。
7. **降级设计的价值**：Single Provider = Single Point of Failure → 8 Provider 链 + Pro/Flash 双重降级。

### 认知层面

8. **"技术套利"思维**：Gemini Web 免费提供深度推理 → CDP 桥接 → 边际成本为零。
9. **LLM 编排 LLM**：Claude 规划 + Gemini 推理 + DeepSeek 计算的异构架构。
10. **好的 PR 不是"我做了什么"而是"你遇到了什么问题 + 我怎么解决的"**——这个认知来自两次 PR Review 的直接反馈。

---

## 21. 可视化演示平台是怎么设计和实现的？

### 动机

AgentChat 的功能很强，但展示方式只有 CLI 输出。面试时不可能打开终端跑命令——需要一个**零安装、浏览器打开就能交互演示**的平台。

### 架构

```
浏览器 → http://localhost:3456
              │
              ▼
    scripts/demo_server.js (548 行，纯 Node.js 内置模块)
              │
              ├── 静态文件服务: demo/*.html + shared.css
              ├── CDP 自动启动: Chrome 不在线 → spawn Chrome → 等待就绪 → 清理空白 tab
              ├── 端口自动清理: EADDRINUSE → netstat 找 PID → kill → 重试
              └── 10 个 API 端点 ↓
                         │
              child_process.spawn('node', ['AgentChat-OneWeb/index.js', ...])
                         │
                         ▼
              Chrome CDP → 8 AI Providers
```

### 10 个 API 端点

| 方法 | 路径 | 功能 | 调用的 Skill |
|------|------|------|------------|
| `GET` | `/api/health` | CDP 连接状态 | — |
| `GET` | `/api/stats` | 服务器运行统计 | — |
| `GET` | `/api/smoke` | 8 Provider 可达性检查 | OneWeb `--smoke` |
| `POST` | `/api/ask` | 单 Provider 问答 | OneWeb `--from=X` |
| `POST` | `/api/parallel` | 4 Worker 并行编排 | OneWeb ×4 |
| `POST` | `/api/search-web` | Kimi 联网搜索 | OneWeb `--from=kimi` |
| `POST` | `/api/deep-reason` | Gemini 深度推理 | OneWeb `--from=gemini` |
| `POST` | `/api/review` | ChatGPT 交叉审查 | OneWeb `--from=chatgpt` |
| `POST` | `/api/verify` | Qwen 事实核查 | OneWeb `--from=qwen` |

### 9 个前端页面

| 页面 | 类型 | 功能 |
|------|------|------|
| `index.html` | 静态导航 | 6 技能卡片 + 8/6/4/2 统计数据 |
| `architecture.html` | 静态文档 | 4 层架构图 + 数据流 + 贡献时间线 |
| `webextended.html` | **交互式** | 选 Provider → 输入问题 → 实时回复 + 降级链 |
| `freesubagent.html` | **交互式** | 预设模板/自定义主题 → 4 Worker 并行分析 |
| `workflow.html` | **交互式** | 输入主题 → Kimi搜索→Gemini推理→ChatGPT审查 |
| `mcp.html` | 文档+状态 | 4 工具展示 + Claude Desktop 配置 + CDP 实时状态 |
| `python.html` | 文档 | 完整 API 表格 + 代码示例 |
| `locales.html` | 文档 | 4 语言对照表（标注 3 处曾导致 ERR_MODEL_DEGRADED） |
| `shared.css` | 样式 | 统一深色主题 |

### 关键设计决策

**1. 为什么用 Node.js 内置 http 模块而不是 Express？**

零依赖安装。演示平台的目标是"git clone 后立即运行"。用 `require('http')` 不需要 npm install。

**2. 为什么 CDP 自动启动？**

Cold start 友好。用户不需要手动 `start-chrome-debug.sh`，demo_server 检测 CDP 不在线 → `spawn('chrome.exe', '--remote-debugging-port=9222', ...)` → 轮询 `/json/version` 直到就绪。

**3. prompt 如何传给子进程？**

从 stdin 管道改为 CLI 参数传递。原因是 MINGW64 bash 环境下 `child.stdin.write(中文)` 会出现 UTF-8 → GBK 编码破坏。改为 `args.push(prompt)` → WebExtended 通过 `remaining.join(' ')` 读取 —— Node.js 进程间的参数传递不受终端编码影响。

**4. 为什么 smoke check 后要清理 tab？**

`callSmoke()` 会打开 8 个 Provider tab 检查可达性。如果不清理，后续 `/api/ask` 检测到 `tab_already_open` 会跳过这些 Provider → 全部 8 个被跳过 → 请求失败。解决方案：smoke 后通过 CDP `/json/close/{id}` 关闭所有非 about:blank 的 page。

### 编码问题的排查与修复

测试过程中发现 3 个中文编码 bug：

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 1 | `demo_server.js` | HTTP body `+=` 拼接 → UTF-8 多字节字符跨 TCP 分片被截断 | `Buffer.concat(chunks).toString('utf8')` |
| 2 | `demo_server.js` | `Content-Type: application/json` 缺少 charset → 客户端 Latin-1 解码 | 全局添加 `charset=utf-8` |
| 3 | `demo_server.js` | `child.stdin.write(prompt)` → Windows 下编码不确定 | 改为 CLI 参数传递（绕过 stdin） |

### 🆕 多轮对话上下文传递

演示平台的第二个关键功能。详见 Q23。

---

## 22. 上游项目在你贡献后发生了哪些变化？你怎么看？

### 数据对比（PR #2 时 vs 当前 v24）

| 维度 | PR #2 合并时 | 当前 v24 | 增长 |
|------|------------|---------|------|
| providerFactory | 587 行 | **1,906 行** | +225% |
| geminiModelSwitch | 346 行（我们的修复） | **947 行** | +174% |
| lib 文件数 | 2 个 | **16 个** | +700% |
| skills | 3 个 | **5 个** | +2 |
| 测试 | 无 | `test/run.js` | 从零到一 |
| 总 commit | ~45 | **~140** | +95 |

### 上游新增的能力（v3→v24 精选）

| 版本 | 功能 | 意义 |
|------|------|------|
| v9 | Gemini flat-menu UI 适配 + MiMo overlay skip | Gemini 2026-07 UI 大改版，我们的选择器仍能工作 |
| v10 | 8-provider hardening + Gemini 模型切换自愈 | 我们修的 `includesExtended` 类 bug 被系统化处理 |
| v11 | Kimi fetch-phase 修复 | 上游也在持续修 Provider 特定 bug |
| v12 | send-committed salvage | 浏览器 tab 崩溃后恢复已提交的响应 |
| v13 | DOM image scan + browser-session download | 新能力：自动提取 AI 生成的图表 |
| v14 | 图片下载安全 + SSRF 修复 | 安全意识增强 |
| v15-v16 | Windows CDP autostart + 嵌入式 Chrome 启动器 | 我们的 Windows 脚本被整合进项目核心 |
| v17 | resilience + slim-harden 反脆弱层 | 可靠性工程化 |
| v18 | Windows CDP unreachable quad-fix | WMI breakaway + singleton detect + CDP_HOST |
| v19-v20 | anchor answers + content validation gate + 同 Provider 并发 | 防 hallucinations 的验证体系 |
| v21 | exclude guard + duplicate-ID abort + fabrication scan | 输出质量门 |
| v24 | test consolidation + 3 P1 fixes | 测试框架上线 |

### 作者重命名了我们的 skill

| 旧名（我们的） | 新名（上游） |
|--------------|------------|
| `AgentChat-WebExtended` | **AgentChat-OneWeb** |
| `AgentChat-FreeSubAgent` | **AgentChat-WebSubAgent** |

重命名的逻辑：`OneWeb` = 一个 Web 端 → 多 Provider 桥接（单入口），`WebSubAgent` = Web 端的子 Agent 编排器。品牌定位更清晰。

### 作者用 asRe() 替换了我们的 reParts()

```js
// 我们的实现（PR #4）
function reParts(key) {
    const v = L.txt(key);
    if (v instanceof RegExp) return { source: v.source, flags: v.flags };
    return { source: v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags: '' };
}

// 作者的实现（v10+）
const asRe = (v) => (v instanceof RegExp ? v : new RegExp(escapeRe(v), 'i'));
```

作者的选择更好：统一返回 RegExp 对象供 Node.js 侧使用，需要传 browser 时再提取 source/flags，避免了我们的双态（有时字符串有时 RegExp）。

### 这件事说明了什么？

1. **好 PR 能激发更多贡献**：我们的两个 PR 解决了实际痛点 → 作者信任我们 → 在此基础上投入 52 个 commit 做深度增强。这正是开源协作的正循环。
2. **作者是真正的技术专家**：他对 CDP、浏览器安全模型、跨平台工程的理解远超普通开发者。我们的代码被整合后，他做了大量我们没有考虑到的工作（WMI breakaway、ephemeral-tab、fabrication scan）。
3. **"贡献者"比"使用者"收获多 10 倍**：如果我只是用 AgentChat，我不会知道 geminiModelSwitch 内部怎么处理 Angular CDK rendering delay。写代码的过程就是深度学习的过程。

---

## 23. 多轮对话降级时的上下文传递是怎么实现的？

### 为什么需要

AgentChat 的运行模型是"每次请求独立"。但实际使用场景是多轮对话：

```
用户第1轮: "帮我分析A股市场的当前状况"
Gemini: "A股目前处于震荡调整期，上证指数在3000-3100区间..."

用户第2轮: "哪些板块最值得关注？"
```

如果 Gemini 在第 2 轮因配额耗尽而失败，降级到 ChatGPT，ChatGPT 只会收到 "哪些板块最值得关注？" —— 没有第 1 轮的上下文，回答空洞无意义。

### 方案设计：A + D 混合策略

选择了两个方案的组合：

| 条件 | 策略 | 实现 |
|------|------|------|
| 短对话（<4 轮） | **方案 A：全量注入** | 将完整 Q&A 历史拼在 prompt 前面，fallback 模型看到完整对话 |
| 长对话（≥4 轮） | **方案 D：摘要持久化** | 异步调用 Kimi 压缩为 150 字摘要，存入 `.json` 文件，fallback 时注入"摘要 + 最近 2 轮" |

### 架构

```
scripts/lib/session_context.js (180 行)
│
├── 内存缓存: Map<sessionId, { turns[], summary }>
├── 文件持久化: ~/.agentchat/sessions/{sessionId}.json
│
├── getContext(sessionId)   → 构建注入文本
│     ├── 短对话 → "[背景: 共3轮]\n用户: ...\nAI: ...\n---\n用户: ...\nAI: ..."
│     └── 长对话 → "[摘要: ...]\n[最近2轮: ...]"
│
├── addTurn(sid, Q, A)      → 保存一轮 → 写 .json
│     └── ≥4 轮 且无摘要 → 标记 _summaryPending
│
├── generateSummary(sid)    → 异步调 Kimi 做总结 → 写 .json
│     └── fire-and-forget，不阻塞响应
│
└── clearSession(sid)       → 删内存 + 删文件
```

### demo_server.js 的改动

`/api/ask` 新增 `sessionId` 可选字段。处理流程：

```
1. 请求到达 → 如果带 sessionId，getContext() 读取历史
   → 有历史 → prompt = "[背景对话...]\n\n当前问题: " + prompt
   → 无历史（新会话）→ 直接透传

2. 调用 WebExtended → 等待响应

3. 响应成功 → addTurn(sid, Q, A) 保存这一轮
   → 如果 _summaryPending → 异步 generateSummary()（不阻塞）

4. 返回结果给前端（含 session.hasContext 字段） 
```

### 测试验证（实际运行）

```
第1轮: "请记住：我最喜欢的颜色是蓝色。" → Qwen ✅
       保存: { question: "...", answer: "记住啦，蓝色。" }

第2轮: "我刚才说我喜欢的颜色是什么？" → Qwen ✅ (hasContext: true)
       注入: "[背景: 第1轮 Q&A]\n\n当前问题: ..."
       Qwen: "你刚才说你最喜欢的颜色是蓝色。" ← 准确！
```

### 关键设计决策

**为什么用 Kimi 做摘要？** —— Kimi 的联网搜索在中文本中很稳定，且摘要任务不需要深度推理。Kimi 降级概率低，即使失败也不破坏对话记录（fire-and-forget）。

**为什么 4 轮阈值？** —— 经验值。4 轮以下对话的 token 总量通常不超过 3000 字符，全量注入不浪费 token。超过后 token 急剧增长（每轮可能 500-800 字符），摘要压缩到 150 字更经济。

**为什么内存 + 文件双缓存？** —— 文件提供持久化（服务器重启不丢），内存提供快速访问（`getContext` 不需要 I/O）。`addTurn` 写文件后同步更新内存缓存。

---

## 24. 可视化平台开发中踩了哪些坑？怎么排查的？

### 选出 3 个最有代表性的面试问题

> 完整列表 12 个见 [DEMO_PITFALLS.md](DEMO_PITFALLS.md)。

### 坑 1：中文在浏览器端显示为乱码

**症状**：API 返回 `"ä¸­å›½çš„é¦–éƒ½æ˜¯åŒ—äº¬"`。

**诊断**：加了 `/api/echo` 调试端点，回显收到的 prompt 的 Unicode 码点 — 服务器端字节正确。问题出在**发出**方向。

**根因**：`Content-Type: application/json` 缺少 `charset=utf-8`。HTTP 规范中，没有 charset 的 JSON 默认回退到 **Latin-1（ISO-8859-1）**，导致 UTF-8 的 3 字节中文字符被当作 3 个独立的 Latin-1 字符解析 → 乱码。

**修复**：全局 17 处 `{ 'Content-Type': 'application/json' }` → `{ 'Content-Type': 'application/json; charset=utf-8' }`。一行字符的差别，排查了 3 小时。

**教训**：HTTP Content-Type 必须显式声明 charset。不声明，客户端会猜，猜错的概率在非 ASCII 场景下接近 100%。

### 坑 2：Gemini 模型按钮在冷启动时找不到（Angular 竞态）

**症状**：每次重启 Chrome 后的第一次请求必然 `Model selector button not found`。

**诊断**：加了诊断脚本 dump 所有按钮的可见性和坐标 — 按钮 DOM 存在且 `offsetParent` 不为 null。那为什么 `openModelMenu` 找不到？

看代码：
```js
const visible = await loc.isVisible({ timeout: 400 }).catch(() => false);
```

**根因**：Angular Shadow DOM 渲染在冷启动时有 2-3 秒延迟。`isVisible({ timeout: 400 })` < Angular 组件 hydration 时间 → 假阴性。

这个值是为暖页面调优的（400ms 够用），冷启动场景没有单独考虑。

**修复**：
```diff
- { timeout: tier === 'L0-cache' ? 800 : 400 }
+ const visTimeout = tier === 'L0-cache' ? 800
+     : tier === 'L1-locale' ? 4000   // L1 是 locale-aware 选择器，最可靠
+     : 2500;                          // L2/L3 需要更长时间
```

**教训**："最小超时"不是最优超时。对于"只需等待一次"的操作，给充足时间比反复重试更高效。

### 坑 3：Pro Extended 模式下发送按钮完全失效

**症状**：Pro Extended 切换成功后，文字已输入到 Gemini 编辑框，但 6 种发送方式全部失败：
- `Enter` → 插入换行
- `Ctrl+Enter` → 插入换行  
- `btn.click()` → 无效
- `dispatchEvent(new MouseEvent(...))` → 无效
- Playwright `btn.click({ force: true })` → 无效
- CDP `Input.dispatchMouseEvent` → 无效

**诊断**：切换前后对比：
```
切换前 (Flash): button[aria-label="发送"] + Enter → 正常发送
切换后 (Pro):  同样的 button，6 种方式全无效
```

单独用诊断脚本（不切模型）验证：点击按钮正常。证明问题不是按钮本身，是**模型切换导致的 Angular 重渲染**。

**根因**：Angular zone.js 的变更检测和事件绑定是异步的。Pro 模型切换触发了输入区域组件树的重建，新的发送按钮被创建并插入 DOM，但 Angular 的事件监听器（通过 `@HostListener` 绑定）在下一个 microtask 才完成。在这个窗口期内（500ms-2s），点击事件不会被 Angular 处理。

Playwright 和 CDP 都比真实用户快得多 — 它们在按钮"准备好"之前就完成了点击。

**修复（workaround）**：在 `demo_server.js` 中设置环境变量 `AGENTCHAT_SKIP_MODEL_SWITCH=1`，跳过 Pro Extended 切换，直接使用 Flash 模式（其中发送正常）。同时在 gemini adapter 中新增环境变量检查。

**完全修复方向**（未实现）：在 `customSend` 中轮询 `NgZone.isStable` 直到 Angular 完成初始化后再点击。

**教训**：前端框架的事件代理层是自动化工具的盲区。DOM 中可见、可用 ≠ 框架的事件监听器已绑定。传统 Web 测试工具（Selenium/Playwright）基于"DOM 渲染完成 = 页面就绪"的假设，在 React/Angular/Vue SPA 中需要额外的稳定性等待。

---

## 附：面试中的加分表达

| 场景 | 加分回答 |
|------|---------|
| "为什么不直接用 Gemini API" | "Web 端对 Pro 订阅者免费提供 Extended Thinking，通过 CDP 驱动桥接，边际成本为零。这是技术套利思维。" |
| "你怎么评价你的贡献" | "三个 PR。PR #2 解决生存问题（Windows+简中），PR #4 做架构升级（locales/Python SDK/MCP），PR #5 是可视化演示平台（9 页面+10 API+多轮对话上下文）。从产品到平台到开发展示的完整跃迁。" |
| "你最大的遗憾" | "Pro Extended 模式下 Angular 重渲染导致发送按钮失效，只能用 Flash 模式绕过。深层 fix 需要轮询 Angular zone.js 的稳定性状态——值得继续研究。" |
| "你怎么看待项目中的代码重复" | "Provider Factory 用模板方法+策略模式消除了 8 个 adapter 的代码重复。同样的思路，我把 locales 也抽成了配置数据——差异表达为数据，逻辑只写一次。" |

---

> 📝 更新：2026-07-24（新增 Q23 会话上下文 + Q24 踩坑实录，PR #5 已提交）
> 📝 更新：2026-07-21（新增 Q21 演示平台 + Q22 上游演变，更新 PR 合并状态）
> 📝 初版：2026-07-09
> 📁 对应项目：AgentChat（ziwang-Physics/AgentChat）+ PR #2 + PR #4（已合并）+ PR #5（已提交）
> 💡 使用方法：面试前通读 2-3 遍，重点关注"为什么这样设计"而不是"做了什么"
