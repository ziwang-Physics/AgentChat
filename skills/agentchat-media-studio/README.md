# AgentChat MediaStudio

AgentChat 的图片/视频网页生成扩展。

它复用 AgentChat 已有的：

- Chrome CDP 持久化登录态；
- Provider 配置驱动架构；
- 登录、额度和错误识别；
- Provider fallback；
- 图片上传能力；
- 本地执行回执。

新增：

- 图片生成和视频生成任务协议；
- 豆包、即梦、小云雀路由；
- 图生视频参考图上传；
- 长任务轮询；
- `<img>`、`<video>` 和网页下载按钮的产物捕获；
- 本地文件保存；
- 创意 Skill 到网页执行器的 JSON 契约。

默认策略：

```text
生图：优先调用 AgentChat 原有 ChatGPT Web 生图、抓图和下载能力
视频：即梦 → 小云雀 → 豆包
```

## 安装

在 AgentChat 根目录：

```bash
npm install
```

启动带持久化 Profile 的 Chrome：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-chrome.ps1
```

然后在该 Chrome 中分别登录：

- 豆包
- 即梦
- 小云雀

## Dry run

```bash
node skills/agentchat-media-studio/index.js --dry-run --media-type=video "测试提示词"
```

## 真实生成

```bash
node skills/agentchat-media-studio/index.js `
  --media-type=video `
  --provider=jimeng,xiaoyunque,doubao `
  --aspect-ratio=9:16 `
  --duration=5 `
  --output-dir=C:/media-output `
  "服装视频提示词"
```

## 当前边界

三个网页的 UI 会频繁更新。该版本已经完成统一运行、fallback、轮询和文件保存框架，但第一次在具体账号上运行时，可能需要根据登录后的实际 DOM 校准 `providers/index.js` 中的 selector。

用户明确要求某个视频时长时，运行器会校验页面控件是否真正应用；无法应用就返回 `duration_unavailable`。用户没有指定时长时，运行器会根据创意结构推断合适时长，并限制在当前免费模型和页面可用范围内，不会固定成 5 秒。

豆包视频模式已适配当前网页的 `Seedance 2.0 Mini` 模型菜单、比例面板和 4–15 秒时长滑块。可先使用 `--probe` 检查登录与控件，再使用 `--prepare-only` 填写提示词、上传图片并设置参数而不点击生成。

不要固定写死“每天多少免费次数”。由实时页面判断额度耗尽，自动尝试下一个平台。
