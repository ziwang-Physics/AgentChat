# AgentChat-OneWeb Changelog

## 2026-07-19 (v18) — Windows CDP 端口不可达四联修
- **[P0] Job Object 陪葬 (`lib/cdp.js` + `scripts/start-chrome.ps1`)**: agent 宿主的工具调用跑在 kill-on-close Job 里，Node `detached: true` 不设置 `CREATE_BREAKAWAY_FROM_JOB`，autostart/Start-Process 出来的 Chrome 在 skill 进程退出瞬间被连带杀掉——"回答完问题，下一轮 ERR_NO_CDP" 的直接成因。现: 内嵌启动器与 ps1 均经 WMI `Win32_Process.Create` 创建进程（父进程 WmiPrvSE.exe，位于任何调用方 Job 之外），同时拿到真实 PID 写入 PID 文件保持 `-Stop` 互操作；WMI 不可用时降级为 plain spawn 并显式告警
- **[P0] Windows 单例吸收 (`launchChromeDirect`)**: Windows Chrome 单例是命名 mutex/消息窗口而非 `Singleton*` 文件——v16 的删文件解锁在 Windows 上是 no-op，同 profile 已有存活实例时新 chrome.exe 被吸收秒退、端口永不绑定、傻等 45s 后报泛化失败。现: 启动前经 CIM 扫描持有 `--user-data-dir=<profile>` 的 chrome/msedge/chromium 进程；命中且为 PID 文件记录的受管实例 → `taskkill /T /F` 回收后重启，他人实例 → 快速 loud-fail 并给出 PID 与三条处置指引（POLICY 不变: 绝不动用户自己的 Chrome）。`Singleton*` 文件清理收窄至 POSIX
- **[P0] `index.js` 硬编码 `127.0.0.1` 无视 CDP_HOST**: OneWeb 自拼 CDP_URL 与 lib/cdp.js 分叉，WSL2 按 .env.example 配了 `CDP_HOST=<Windows 宿主 IP>` 仍探测 VM 内 loopback → 每轮 ERR_NO_CDP。现: 改用 lib 导出的 `CDP_URL` 单一事实源（CDP_HOST + CDP_PORT + v16 .env 加载全部生效）
- **[P1] 早退检测与诊断对齐 ps1 (`waitForPortOrDeath`)**: 内嵌启动器新增 PID 存活监视（1.5s 宽限 + 死亡后二次探测端口以容忍单例转交），launched 进程死亡即刻中止等待并给出定向 reason（单例吸收 / AV 拦截），不再烧满 45s；win32 失败路径追加 `netstat -ano | findstr :<port>` 诊断输出
- **[P1] Chrome ≥136 默认目录守卫**: `CHROME_PROFILE` 指向浏览器默认 User Data 目录（Win/Linux/macOS 三平台布局识别）时直接拒绝并说明——Chrome ≥136 在默认数据目录上静默禁用 `--remote-debugging-port`，旧行为是端口永不打开的无声超时
- **[docs] SKILL.md**: Windows agent 宿主部署段新增 `setx AGENTCHAT_ENV_FILE / AGENTCHAT_SCRIPTS_DIR` 逃生门——skill-only 布局下 lib 的 .env 候选路径解析到 `~/.claude/.env`，仓库根配置（CDP_PORT/CHROME_PROFILE/CHROMIUM_PATH/PROXY_SERVER/CDP_HOST）此前对 skill 进程完全不可见，是端口/profile 分裂的根源
- 新增 `test_v18_windows_cdp.js` — CDP_URL 接线断言（源级 + 子进程环境功能验证）、`winArgQuote` CommandLineToArgvW 语义、WMI 命令构造（PS 单引号转义）、`parseProfileHolders`（带引号/尾斜杠/大小写/非命中排除）、默认 User Data 目录识别三平台正反例、`isProcessAlive`、`waitForPortOrDeath` 死亡早退时间界

## 2026-07-17 (v17) — 反脆弱层：墙检测 / ARIA 定位层 / 浏览器级准入控制
- **[P0] 墙检测 (`lib/pageHealth.js` 新增)**: CAPTCHA / 登录墙 / 限流拦截页的单次 evaluate 检测——结构性证据 (reCAPTCHA/hCaptcha/Turnstile/Cloudflare/Arkose iframe、challenge form、可见 password 输入) 无条件判定; 文案证据受双门限 (页面无可见聊天编辑器 + body <1500 字符) 防误报。设计立场: **检测并交给人, 绝不绕过**。三处接线: 导航后 (同 URL 渲染的墙, URL 检查抓不到)、编辑器找不到时 (墙是 "no editor" 的头号真实成因)、响应等待超时时 (发送后弹出的会话过期/限流)。分类 captcha/login→`auth` (触发 recoveryHint)、ratelimit→`quota` (exit 5 重试语义), 替代原先烧完预算归 `error`/`timeout` 的静默模式
- **[P1] ARIA 定位层**: `findEditableElement` 在 CSS 列表全灭后、shadow-DOM 启发式之前插入 `getByRole('textbox')` 语义层 (主流抗漂移首选: role 定位在 class 重命名/hash class churn 下存活)。三层命中打 `_fsTier` 标签落入 `ctx.telemetry.editor_tier`——aria/heuristic 命中即 adapter selector 列表已漂移的早期告警, 无需等全灭
- **[P1] 浏览器级准入信号量 (`lib/locks.js`)**: `acquireBrowserSlot`/`releaseBrowserSlot` 复用既有原子锁全部竞态防护 (TOCTOU rename、死 PID 回收、30min TTL、orphan 恢复), 跨进程封顶同一 Chrome 内并发页面自动化数 (`AGENTCHAT_MAX_CONCURRENT_PAGES`, 默认 3, 上限 16)——provider 锁只序列化同 provider, 7 个 worker 打 7 个**不同** provider 的并发爆发此前不受任何约束。等待带 1.5–3s 抖动; 等待耗尽显式降级为不限流并告警 (准入控制不引入新死锁类); 获得 slot 后 0.3–1.2s 抖动打散屏障释放的同步爆发。主流程 try/finally 包裹, 崩溃路径由死 PID 回收兜底
- **[P2] auth 恢复提示全覆盖**: 无专属 recoveryHint 的 provider 现打通用指令 (在调试 Chrome 中手动完成登录/人机验证)
- 新增 `test_v17_resilience.js` — 33 断言 (三类墙判定、编辑器否决+长度门限误报防护、隐藏元素否决、slot 信号量语义与有界等待、8 组接线断言); 既有 57+19+15 断言全部保持通过

## 2026-07-17 (v14)
- **[P0] 图片下载阶段挂死修复**: tier-2 页面内 `fetch()` 此前无任何超时——一个挂起的图片端点让 `page.evaluate` 永久 pending, CDP socket 维持事件循环, 进程永不退出 (无 stdout flush、无 receipt); IndependentTasks 的 SIGTERM 看门狗随后把**答案已经完成**的 run 杀成 provider 失败。现: 页内 AbortSignal 25s + evaluate 外层 Promise.race 30s (late loser 吞掉避免 unhandledRejection) + 全阶段 120s 预算 + 单响应 20 张上限 (超出 loud-fail)
- **[P0] direct 下载 tier 补齐 payload 嗅探**: HTTP 200 返回的 HTML 错误页此前直接落盘为损坏 `.png` 且报 status:ok (v13 只修了 browser tier); 现 buffered + sniffImageExt 门禁, 并加 30MB 单张上限 (含 content-length 预检与流式计数中断)
- **[P0/安全] 响应内 URL 属不可信输入**: 拒绝 loopback/link-local/RFC1918 目标 (`![x](http://127.0.0.1:9222/json/list)` 注入曾可把 CDP 调试端点元数据——含所有 tab 的 debug websocket URL——写入用户 cwd, 且带 cookie 的 browser tier 可探测内网); `AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS=1` 放行 (测试/内网用)。重定向目标同检
- **[P1] 重定向修复**: 相对 `Location:`(极常见) 此前直接断链, 303 不跟随; 现 `new URL(loc, base)` 解析、仅跟 http(s)、上限 3 跳
- **[P1] 空 `--only=`/`--from=` 冒充修复**: `''.includes('')` 恒真 → 空值经子串回退静默解析到 chain[0]=Gemini, 在 --single 下运行与调用方持锁 provider 不同的实例 (正是 loud-fail 要防的互斥破坏); 现 parse 期 exit 64 硬失败; 且 --single/--only 下 provider 名必须精确匹配 (子串便利仅保留在级联路径)
- **[P1] stdout 机器契约去污染**: 管道模式下 "📥 Downloaded Images" 摘要不再追加进响应正文 (execute.js/SDK/MCP 逐字消费 stdout 作为 AI 回答, 摘要曾混入子代理裁决文本); 摘要改走 stderr, 计数入 receipt (`images_ok`/`images_failed`); TTY 人类直跑行为不变。downloadAllImages 返回值新增 `rawResponse`/`summary` 字段
- **[P1] 用法错误 exit 1 → 64 (EX_USAGE)**: 与 ERR_NO_CDP 解除冲突 (execute.js 的 conflation guard 所述问题), 且用法错误现在也产生 receipt
- **[P1] providerFactory 检查顺序**: overlay 处理提前到 body 级 quota 扫描之前——可关闭的升级弹窗 ("请升级…" 命中 COMMON_CN_QUOTA_PATTERNS) 曾把可用 provider 误判为 quota 整轮跳过
- **[P2] 未知 `--flag` WARN 而非静默丢弃** (--locale 空转/--keep-tabs 进 prompt 的 bug 类根除); 无效 timeout 值 WARN; `--image` flag: 生图增强指令由 index.js 进程内追加 (SKILL.md §1 从 prose 约束改为机器可验证), telemetry 记 `image_prompt_enhanced`
- **[P2] 其他**: 下载文件名加 pid (并发 worker 同秒覆盖) + `wx` 写入防клobber; DIRECT_URL_RE query 段不再吞尾随 `)`; smokeTest 空 context 给修复指引而非 TypeError→exit 4; 顶层 require 守卫 (playwright-core 未装 / 只拷了 OneWeb 没拷 skills/lib 时给出确切修复命令); stdout EPIPE 守卫 (父进程先死不再在 exit-0 receipt 后崩成 exit 4); `~/start-chrome-debug.sh` 路径漂移修正; test_providers_v10.js 硬编码 `/home/wangzi` 绝对路径改 `__dirname` (可移植); 新增 6 组 v14 回归断言 (test_v13_image_capture.js 15/15)

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
