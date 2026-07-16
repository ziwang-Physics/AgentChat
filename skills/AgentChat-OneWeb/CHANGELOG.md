# AgentChat-OneWeb Changelog

## 2026-07-16 (v11)
- **[P0] Kimi 联网搜索「获取网页」阶段截断修复** (实测: 45s/960 chars 截断于「正在获取网页...」, 78s/1522 chars 截断于「获取网页 5 个网页」)。三层复合根因:
  1. kimi.js `stillGeneratingCheck` 词表缺口 — `正在[搜索检索查询]` 不含「获取」, `\d+个结[果]` 不匹配「N 个网页」→ 抓取阶段 (5-30s 静默) 对检测器完全不可见, 8s stabilityWindow 到期即误判完成
  2. `$` 锚定的 tail 正则天生脆弱 (状态行后跟任何来源 chip 行即失配) 且硬编码 responseSelectors[0], factory 命中 fallback selector 时检测器读错元素而静默失效
  3. **factory 层 bug**: phase-3 只在 `text.length > lastLen` 时重置稳定时钟 — 搜索/思考卡片折叠导致 innerText 收缩时, 答案回升到峰值长度之前所有 poll 都被视为"stable", 窗口可在正文流式输出中途到期 (影响所有带可折叠工具 UI 的 provider)
- 新增 `lib/stillWorking.js` — 共享多信号"仍在生成"检测器: S1 零 CDP 开销分类 factory 已读文本 / S2 停止按钮可见 (语言与措辞无关) / S3 最后一条回复容器内 spinner 或其子树 tail 状态行; CN 动词全词表 (搜索|检索|查询|获取|抓取|读取|阅读|浏览|访问|打开|解析|分析|整理|归纳|总结|思考|推理|撰写|生成|调用|执行|等待|加载|联网) + 「N 个网页/结果/来源」计数行 + EN 动名词
- providerFactory phase-3 重写: 指纹 (length+tail-80) 变更检测取代纯增长检测, 新增 '~' tick (收缩/原位变更); `stillGeneratingCheck(page, {text, sinceChangeMs, elapsedMs})` 新签名 (向后兼容, 文本变化的 poll 不再调用 check — 每个增长 poll 省一次 CDP 往返); 新增 `stillGeneratingMaxHoldMs` (默认 90s, Gemini 300s, Kimi 180s) — ⚙ 重置自上次真实文本变化起有界, 误报从"烧光整个 provider 预算"降级为"有界延迟"
- Kimi/MiniMax/DeepSeek/Qwen/MiMo 全部接入共享检测器 (MiniMax agent 工具阶段、DeepSeek R1 深度思考折叠、Qwen 深度搜索属同一截断类); responseSelectors 提升为模块常量保证检测器与 factory 轮询同一容器族; ChatGPT/Claude 保持 stop-button phase-1 管线不变
- extractResponse 回声防护: 泛型 selector tail (`[class*="message"]` 等) 在 assistant 节点挂载缓慢时 `.last()` 会解析到用户自己的气泡 → 把 prompt 当响应返回 (silent-wrong-answer 类); 提取文本 ≈ prompt (±10-15% 长度且互相包含) 时判 EXTRACT 失败。短 prompt (<20 chars) 与"复述型"子串答案豁免
- checkOverlays 登录误判: 「退出登录」「免登录」「已登录」不再把已登录 provider 硬判为 'auth' (负向后顾); `\blog in\b`/`\bsign in\b` 词边界
- Claude editorSelectors 顺序: 页面级泛型 `[contenteditable="true"]` 从首位移到末位, 避免 `.first()` 绑定到对话重命名框/弹窗可编辑区
- 新增 test_still_working.js — 57 条断言 (含两条实测截断 tail 的端到端回归、收缩回归、⚙ 上限、回声防护、8 provider 接线); test_gemini_selectors.js 19 条全部保持通过

## 2026-07-03
- 新增 `--single` flag: 只尝试单个 provider 不级联，供 IndependentTasks 的跨 worker 锁使用
- checkOverlays(): 修掉一处死三元表达式 (`dismissable ? 'error' : 'error'`)
- waitForCompletion() 的 stopWaitMode='detached' 分支 (Qwen): 补上已耗时间扣减，避免单 provider 超预算
- Claude adapter postResponseHook: 去掉与 minResponseLength:5 矛盾的 30 字符门槛，短回答不再被误杀
- telemetry.js 日志轮转 off-by-one: `.2` 之前会被静默覆盖丢失，现在能正确落到 `.3`
- Kimi 响应检测: 字符串相等比较 → 元素计数+文本长度增长, 修复同文本不匹配 bug
- Kimi 新建会话: 每次调用前点击 `.new-chat-btn` 清空旧 DOM, 避免检测干扰
- Kimi 问候语识别: `oldCount===1 && oldText<30chars` → 视为空白页
- Kimi 稳定性窗口: 自适应 (5s/30s/20s/15s/8s), 短文不再等 30s
- Kimi 串行超时: selector 60s → 10s each, 45s 最坏 → 30s
- Gemini Pro Extended 长 prompt 超时: stop button 可见=仍在思考, 延长等待+120s
- Claude "Thinking" 占位符: 过滤 Thinking/Analyzing 空响应, 多重停止检测
- Promise.allSettled: IndependentTasks 单 worker 异常不再影响其他 worker
