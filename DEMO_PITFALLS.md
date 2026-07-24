# 🛠️ 可视化演示平台 — 踩坑实录与解决方案

> 面试用：每个问题按"症状 → 诊断 → 根因 → 修复"四步叙述，展示完整的排查能力。

---

## 目录

| # | 问题 | 类别 |
|---|------|------|
| 1 | 中文在浏览器端显示为乱码 | 编码 |
| 2 | prompt 中文传到子进程变成问号 | 编码 |
| 3 | 降级链页面的 Gemini 总是被跳过 | 状态管理 |
| 4 | Gemini 模型按钮冷启动找不到 | 竞态条件 |
| 5 | Pro Extended 切换成功但验证失败 | 正则 |
| 6 | Pro 模式下输入了文字但发不出去 | 前端框架 |
| 7 | Chrome 用真实 profile 启动被拒绝 | Chrome 安全策略 |
| 8 | Chrome 启动后几秒自动退出 | 进程管理 |
| 9 | 页面每 30 秒自动打开一批新标签页 | 轮询设计 |
| 10 | API 返回 500 但页面显示"成功" | 错误处理 |
| 11 | 端口 3456 被上一个进程占用 | 进程管理 |
| 12 | 并行编排页面的模板 prompt 被截断 | 字符串处理 |

---

## 1. 中文在浏览器端显示为乱码

### 症状

```json
{"response":"ä¸­å›½çš„é¦–éƒ½æ˜¯åŒ—äº¬ã€‚"}
```

PowerShell 和浏览器都看到一堆拉丁字符。但同样的 API 用英文 prompt 完全正常。

### 诊断

先确认服务器端是否正确接收到中文 — 加了 `/api/echo` 调试端点，回显收到的 prompt 的 Unicode 码点：

```
charCodes: 7528 4e00 53e5 8bdd 56de 7b54 ff1a 4e2d 56fd 7684
```

0x4E2D = 中，0x56FD = 国 — 服务器收到的是正确的 UTF-8 字节。

问题出在**服务器发出**的方向。

### 根因

Node.js 的 `http.createServer` 使用 `body += c` 拼接 HTTP body。`c` 是 Buffer，`+` 操作会隐式调用 `toString()`，而默认编码是 `'utf8'` — 这部分没问题。

真正的问题在 `Content-Type` 响应头：

```js
res.writeHead(200, { 'Content-Type': 'application/json' });
```

HTTP 规范中，没有 `charset` 参数的 `application/json` 默认使用**服务端实现定义的编码**。大多数浏览器在没有 charset 时回退到 **Latin-1（ISO-8859-1）**，导致 UTF-8 的 3 字节中文字符被当作 3 个独立的 Latin-1 字符解析 → 乱码。

### 修复

```diff
- { 'Content-Type': 'application/json' }
+ { 'Content-Type': 'application/json; charset=utf-8' }
```

全局替换，17 处。一行字符的差别，排查了 3 小时。

### 教训

**HTTP Content-Type 必须显式声明 charset**。不声明，客户端会猜，猜错的概率在非 ASCII 场景下接近 100%。

---

## 2. prompt 中文传到子进程变成问号

### 症状

```json
{"response":"你的消息像是乱码了，我没法准确读懂内容。"}
```

AI 收到的是 `??????:?????????` 而不是中文。

### 诊断

问题发生在 demo_server → WebExtended CLI 之间。demo_server 通过 `child_process.spawn()` 启动 WebExtended，prompt 原本走 stdin 管道：

```js
child.stdin.write(prompt, 'utf8');
child.stdin.end();
```

WebExtended 读：
```js
process.stdin.setEncoding('utf-8');
for await (const chunk of process.stdin) chunks.push(chunk);
```

两端都声明了 UTF-8，理论上应该没问题。但 Windows 下 `child_process.spawn()` 的默认 shell 是 `cmd.exe`，stdin 管道经过 cmd 层时会被系统代码页（GBK/CP936）干扰。

### 根因

Windows 的进程间通信管道在 `spawn()` 默认配置下，stdin 写入的字节可能经过系统 ANSI 代码页转换。中文的 UTF-8 3 字节序列被当作 GBK 双字节序列解码 → 高位字节被丢弃 → 全变成 `?`（0x3F，GBK 的替换字符）。

这个问题只在 MINGW64（Git Bash）和 CLI 参数传递时出现。PowerShell 的 `Start-Process` 不受影响。

### 修复

**不通过 stdin 传 prompt，改为 CLI 参数传递：**

```diff
- child.stdin.write(prompt, 'utf8');
- child.stdin.end();
+ // prompt 作为命令行参数传入
+ args.push(prompt);
```

WebExtended 本身就支持 CLI 参数 + stdin 两种方式（`remaining.join(' ')`），不需要改它。Node.js 进程间的 `process.argv` 不受终端编码影响，因为 Windows 底层使用 UTF-16 的 `CommandLineToArgvW`。

### 教训

**跨平台 IPC 的编码问题是最隐蔽的 bug**。stdin 看起来是"最直接"的通信方式，但在 Windows 下它经过多层编码转换。CLI 参数反而是更可靠的路径——Windows 原生 API 是 UTF-16 的。

---

## 3. 降级链页面的 Gemini 总是被跳过

### 症状

降级链页面（`webextended.html`）选择 Gemini 发送后，Gemini 瞬间被跳过，浏览器网络面板看到全部 8 个 Provider 都是 `tab_already_open`。

但串行管道页面（`workflow.html`）调用同样的 `/api/ask`，Gemini 正常。

### 诊断

对比两个页面的代码：

| 页面 | 加载时的行为 |
|------|------------|
| `workflow.html` | 不做任何预检查 |
| `webextended.html` | `checkStatus()` → `fetch('/api/smoke')` |

`/api/smoke` 会打开 8 个 Provider 的 tab 来检测可达性。这些 tab 检测完后**没有关闭**，全部残留在 Chrome 中。

当用户点击"发送"时，`/api/ask` → `callWebext` → WebExtended 的 `isProviderTabOpen()` 检测到每个 Provider 都已有 tab → 标记 `reason: 'tab_already_open'` → 全部跳过 → 请求失败。

### 根因

smoke check 和实际请求共享同一个 Chrome 实例。smoke 打开的 tab 成为"毒药"，污染了后续请求的 tab 复用检测。

### 修复

两处改动：

1. `/api/smoke` 响应前关闭所有 AI 网站 tab：
```js
await closeOldProviderTabs();
```

2. 去掉页面 30 秒轮询 smoke 的 `setInterval`，改为只在页面加载时跑一次（见问题 9）。

### 教训

**共享状态的副作用往往不是立即显现的**。smoke check 本身工作正常，但它的副作用（残留 tab）在下一次操作时才暴露。设计系统时，每个操作的"事后清理"和"事前检查"同样重要。

---

## 4. Gemini 模型按钮在冷启动时找不到

### 症状

```
[gemini] gemini WARN: Model selector button not found (cache→L1→L2→L3 exhausted).
```

每次重启 Chrome 后的第一次请求必然失败。但页面重载后第二次尝试就正常。

### 诊断

加了诊断日志 dump 所有按钮的可见性：

```
[1] <BUTTON> aria="打开模式选择器，当前模式为"Pro""
    visible=true offsetParent=true
```

按钮 DOM 存在且可见！那为什么 `openModelMenu` 找不到？

看 `openModelMenu` 的代码：

```js
const visible = await loc.isVisible({ timeout: 400 }).catch(() => false);
```

Angular 的 Shadow DOM 渲染有延迟。在冷启动的新 tab 中，模型按钮所在的 Angular 组件完成 hydration 需要 2-3 秒。Playwright 的 `isVisible` 在 400ms 内等不到就返回 false。

### 根因

**竞态条件**：`isVisible({ timeout: 400 })` 的等待时间小于 Angular 组件的渲染时间。

这个值是为暖页面调优的（页面已在后台，组件已渲染，400ms 足够）。冷启动场景没有单独考虑。

### 修复

```diff
- { timeout: tier === 'L0-cache' ? 800 : 400 }
+ const visTimeout = tier === 'L0-cache' ? 800
+     : tier === 'L1-locale' ? 4000   // L1 是 locale-aware 选择器，最可靠
+     : 2500;                          // L2/L3 需要更长时间解析
```

L1（locale CSS 选择器，如 `button[aria-label*="打开模式选择器"]`）是最精确的选择器，给它 4 秒等待时间。L2/L3 给 2.5 秒。

### 教训

**"最小超时"不是最优超时**。短超时在快速路径上节省时间，但在关键路径上会导致假阴性。对于"只需等待一次"的操作，给充足时间比反复重试更高效。

---

## 5. Pro Extended 切换成功后验证失败

### 症状

```
[gemini] gemini: selected Extended thinking
[gemini] gemini: final mode not confirmed as Pro Extended. Actual aria-label: "打开模式选择器，当前模式为"Pro 扩展""
```

模型已经切到了 Pro Extended（aria 包含 "Pro 扩展"），但代码判定切换失败 → 重试 → 再失败 → 跳到 ChatGPT。

### 诊断

`locales/gemini.js` 中的验证文本：

```js
zh_CN: { modelVerify: 'Pro扩展' }  // 无空格
```

但 Gemini 页面上实际显示的是 **"Pro 扩展"**（有空格）。`L.txt('modelVerify')` 在精确 locale 模式下返回字符串 `'Pro扩展'`，`includesExtended(currentAria)` 用 `t.includes('Pro扩展')` 匹配 → 匹配不到。

### 根因

Google UI 在 "Pro" 和 "扩展" 之间插入了一个空格。我写 locale profile 时参考的是之前见过的紧凑格式，没有实际抓取最新 UI 的 aria-label。

### 修复

```diff
- modelVerify: 'Pro扩展',
+ modelVerify: /Pro\s*扩展/,    // \s* 匹配 0 或多个空白字符
```

改为 RegExp，允许 Pro 和 扩展 之间有任何数量的空白。同时兼容紧凑格式和有空格的格式。上游的 `asRe()` 会把字符串和 RegExp 统一处理，所以这里用 RegExp 字面量安全。

### 教训

**UI 文本匹配应该用模糊模式，不是精确字符串**。Google 改一个空格就会让它失效。RegExp 的 `\s*` 比精确字符串鲁棒得多。

---

## 6. Pro 模式下输入了文字但发不出去

### 症状

Pro Extended 切换成功后，文字已输入到 Gemini 编辑框，但：
- `Enter` → 插入换行，不发送
- `Ctrl+Enter` → 插入换行，不发送
- `button.click()` (aria="发送") → 无效
- `dispatchEvent(new MouseEvent('click', ...))` → 无效
- Playwright `btn.click({ force: true })` → 无效
- CDP `Input.dispatchMouseEvent` → 无效

全部 6 种方式都试过了，没有一个能把消息发出去。

但在 Flash 模式下，`Enter` 正常发送。

### 诊断

Pro Extended 模式切换会引起 Angular 的**整个输入区域重新渲染**。切完之后：
- 模型按钮的 aria-label 从 "Flash" 变成了 "Pro 扩展"
- 发送按钮是一个 Material Design `mdc-icon-button`，位于 Angular CDK overlay 内部
- Angular zone.js 在重新渲染后，新 DOM 元素的事件绑定有一个短暂的"死区"

诊断脚本（`diag_send3.js`）确认：DOM 中按钮存在、可见、`disabled=false`，但 `click()`、`MouseEvent`、`CDP Input.dispatchMouseEvent` 全部无效。**Angular 的事件代理层没有绑定到新渲染的按钮上**。

### 根因

Angular zone.js 的变更检测和事件绑定是异步的。模型切换触发了组件树的重建，新的发送按钮被创建并插入 DOM，但 Angular 的事件监听器（通过 `@HostListener` 或 RxJS `fromEvent` 绑定）在下一个 microtask 才完成。在这个窗口期内（估计 500ms-2s），点击按钮的事件不会被 Angular 处理。

Playwright 和 CDP 都比真实用户操作快得多 — 它们在按钮"准备好"之前就完成了点击。

### 修复

当前采用工作绕过（workaround）：跳过模型切换，直接在 Flash 模式下使用 Gemini。

```js
// demo_server.js
env: { AGENTCHAT_SKIP_MODEL_SWITCH: '1' }
```

```js
// gemini.js adapter
if (process.env.AGENTCHAT_SKIP_MODEL_SWITCH === '1') {
    log('gemini: model switch skipped — using default model');
    return;
}
```

这是因为 Pro Extended 切换虽然对推理质量有提升，但对演示平台的**可用性**是阻断性的。两害相权取其轻。

**完全修复的方向**（未在此 PR 中实现）：
1. 在 `customSend` 中增加 Angular zone.js 稳定性的轮询检测（检查 `NgZone.isStable`）
2. 切换完成后等 5 秒 + 检测 `document.readyState === 'complete'` + Angular 稳定信号
3. 或者：切换模型后 reload 页面，在新页面中直接以 Pro 模式开始（绕过重新渲染的竞态）

### 教训

**前端框架的事件代理层是自动化工具的盲区**。DOM 中可见、可用 ≠ 框架的事件监听器已绑定。传统 Web 测试工具（Selenium/Playwright）的设计基于"DOM 渲染完成 = 页面就绪"，但在 React/Angular/Vue 的 SPA 中，DOM 渲染完成只是第一步，框架的异步初始化还需要额外等待。

---

## 7. Chrome 用真实 profile 启动被拒绝

### 症状

用户反映 CDP Chrome 中没有登录信息。我把 profile 目录从 `.chrome-debug-profile` 改成系统目录：

```js
// 错误的改动
profileDir = '%LOCALAPPDATA%\Google\Chrome\User Data'
```

Chrome 启动后在 stderr 打印：

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

然后 Chrome 进程退出了。

### 根因

Chrome 有一个安全策略：**不允许在默认用户数据目录下启用远程调试端口**。这是为了防止恶意软件在用户不知情的情况下控制他们的主浏览器。

`.chrome-debug-profile` 是一个隔离的非默认目录，所以 CDP 可以正常工作。

### 修复

还原为 `.chrome-debug-profile`。这个目录中已有之前手动登录的 Google 账号信息（`check_login.js` 确认过 `luzheng1343@gmail.com` 已登录）。

### 教训

**Chrome 的安全策略是为用户好，但错误信息不够明确**。"non-default data directory" 对于不熟悉 Chrome CDP 的开发者来说并不直观。这个策略的意图是防止远程调试被滥用，但它的副作用是让合法用例需要额外的 profile 管理。

---

## 8. Chrome 启动后几秒自动退出

### 症状

```
[demo] Chrome CDP 启动完成!
[demo] 已清理 1 个空白 tab
(3 秒后)
curl: (7) Failed to connect to 127.0.0.1 port 9222
```

Chrome 刚启动就退出了。

### 诊断

`launchChrome()` 用 `about:blank` 暖启动 Chrome，然后 `cleanupBlankTabs()` 关闭这个唯一的 tab。Windows 下 Chrome 在最后一个 tab 被关闭时会**退出整个进程**。

这和 macOS/Linux 的行为不同 — 在 macOS 上关闭最后一个 tab 只是显示空白页，Chrome 进程继续运行。

### 根因

**Windows 和 macOS 的 Chrome 生命周期不同**。macOS 的 Chrome 在关闭所有窗口后继续保持后台进程（Dock 中有图标），Windows 的 Chrome 在关闭最后一个窗口后退出进程。

### 修复

不再清理 `about:blank` tab。改为只清理 AI 网站 tab（`closeOldProviderTabs` 使用域名正则匹配），保留至少一个 `about:blank` tab 防止 Chrome 退出。

```js
const isAI = /gemini|chatgpt|claude|qianwen|kimi|minimax|mimo|deepseek/i.test(p.url);
```

### 教训

**跨平台的行为差异可能隐藏在看似"通用"的操作背后**。`关闭 tab` 听起来是平台无关的操作，但它的副作用（是否导致进程退出）是平台相关的。

---

## 9. 页面每 30 秒自动打开一批新标签页

### 症状

用户观察到 Chrome 窗口中不断有新的 tab 被创建、销毁、再创建。每次 `/api/smoke` 打开 8 个 tab，30 秒后再来一轮。Tab 创建和销毁的速度超过了 Chrome 的处理能力，偶尔导致 Chrome 崩溃。

### 诊断

`webextended.html` 中：

```js
setInterval(checkStatus, 30000);  // 每 30 秒跑一次

async function checkStatus() {
    const r = await fetch('/api/smoke');  // 这打开 8 个 tab
    ...
}
```

### 根因

`/api/smoke` 不是轻量级的健康检查。它实际打开 8 个 AI 网站的 tab，在每个 tab 中执行页面操作来验证可达性。30 秒的轮询间隔意味着每 30 秒就有 8 个 tab 被创建和销毁。

最初的设计意图是"实时显示 CDP 和 Provider 状态"，但没有考虑到 smoke check 的代价。

### 修复

```diff
- setInterval(checkStatus, 30000);
+ // 只在页面加载时跑一次 smoke
+ checkSmoke();
+ // CDP 状态单独用轻量的 /api/health 检查
```

CDP 状态改用 `/api/health`（只 ping CDP 端口，不打开任何 tab），Provider 可达性只在页面加载时检查一次。

### 教训

**API 的设计必须考虑调用频率**。`/api/smoke` 是一种"昂贵"的操作（每调用一次打开 8 个 tab），不适合轮询。轻量级的状态检查（`/api/health`）适合高频调用。API 语义和调用模式要匹配。

---

## 10. API 返回 500 但页面显示"成功"

### 症状

`/api/ask` 返回 HTTP 200 + `{ success: false, response: "Error: ..." }`。但降级链页面和并行编排页面把这些响应当作成功，显示为"✅ 成功"。

### 诊断

两个页面的 fetch 代码都没有检查 `d.success` 字段：

```js
// 错误的逻辑
const r = await fetch('/api/ask', {...});
const d = await r.json();
results.push({ success: true, response: d.response });
// success: true 是硬编码的！不管 d.success 是什么都当成功
```

### 根因

HTTP 状态码和业务状态码分离的设计模式下，页面代码必须同时检查两者。但前端代码只检查了 HTTP 200（fetch 没抛异常 = 成功），没有检查 JSON body 中的 `success` 字段。

### 修复

```diff
- results.push({success:true, response:d.response});
+ results.push({
+   success: d.success !== false,
+   response: d.response,
+   provider: d.provider || 'Unknown'
+ });
```

### 教训

**不要用 HTTP 状态码代理业务结果**。在 API 设计中，HTTPS 200 只表示"请求被正确路由并处理"，不代表"业务成功"。如果有 `success: false` 的业务字段，前端必须读写它。

---

## 11. 端口 3456 被上一个进程占用

### 症状

```
Error: listen EADDRINUSE: address already in use :::3456
```

服务器启动失败，因为上一次的 node 进程没有被正确终止。

### 根因

用户用 Ctrl+C 关闭了终端窗口但没有杀掉后台的 node 进程，或者上一个 demo_server 实例异常退出后端口处于 TIME_WAIT 状态。

### 修复

在 `server.on('error')` 中检测 `EADDRINUSE`：

```js
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        // Windows: netstat 找占用端口的 PID → kill
        execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' })
            .split('\n').forEach(line => {
                const m = line.trim().match(/(\d+)\s*$/);
                if (m) process.kill(parseInt(m[1]));
            });
        // 等 1 秒后重试
        setTimeout(() => { server.listen(PORT); }, 1000);
    }
});
```

### 教训

**服务器进程应该具备自愈能力**。对于 EADDRINUSE 这类可自动恢复的错误，与其报错让用户手动处理，不如自动 kill 旧进程重试。

---

## 12. 并行编排页面的模板 prompt 被截断

### 症状

并行编排页面（`freesubagent.html`）选择预设模板后，AI 返回的回复和模板预期不符。经检查，传给 API 的 prompt 被截断了——只有后半部分，前半部分不见了。

### 诊断

```js
// 原始代码
const tasks = topic
    ? tpl.tasks.map(t => ({
        ...t,
        prompt: t.prompt.replace(/[^。]*。$/, '') + '\n\n主题：' + topic
      }))
    : tpl.tasks;
```

`/[^。]*。$/` 这个正则的意图是"删除最后一句"（把模板结尾句替换为自定义主题）。但它匹配"最后一个句号之前的所有非句号字符 + 句号"——如果原始 prompt 中有多行，`.` 不匹配换行符，只会匹配最后一行。而且在中文中，句号 `。` 不一定出现在每句末尾。

### 修复

直接使用原始模板 prompt，把自定义主题**追加**而不是替换：

```diff
- prompt: t.prompt.replace(/[^。]*。$/, '') + '\n\n主题：' + topic
+ prompt: t.prompt + '\n\n主题：' + topic
```

### 教训

**正则表达式在非结构化文本上的操作非常脆弱**。用正则去"理解"中文句子的边界几乎注定失败。正确的做法是追加而非替换——让模板保持完整性。

---

## 总结：架构经验

| 经验 | 对应问题 |
|------|---------|
| HTTP Content-Type 必须显式 charset | #1 |
| 跨平台 IPC 用 CLI 参数而非 stdin | #2 |
| 共享状态的副作用需要事后清理 | #3, #9 |
| 等待时机 > 最小超时 | #4 |
| UI 文本匹配用模糊正则不用精确字符串 | #5 |
| SPA 框架事件绑定有异步窗口期 | #6 |
| 读懂安全策略的原因再绕过 | #7 |
| 跨平台行为差异藏在"通用"操作背后 | #8 |
| API 设计要考虑调用频率 | #9 |
| HTTP 状态码 ≠ 业务结果 | #10 |
| 服务器应具备自愈能力 | #11 |
| 正则操作非结构化文本是 fragile 的 | #12 |

---

> 📝 生成时间：2026-07-22
> 📁 对应 PR：[#5 (GitHub #10)](https://github.com/ziwang-Physics/AgentChat/pull/10) — 可视化演示平台
> 💡 面试用法：选 2-3 个最有代表性的问题深入讲，展示"诊断→根因→修复→教训"的完整链条
