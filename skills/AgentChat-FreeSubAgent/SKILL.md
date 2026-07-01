# Parallel AI Decompose — Thin Orchestrator over AgentChat-WebExtended

> **最后更新**: 2026-07-02
> **核心原则**: Claude Code 拆任务 + 写 prompt → Node.js 并发派发 → 质量门 + 证据仲裁
> **Provider 层**: 单一源 — `AgentChat-WebExtended` (6 providers, 零代码重复)
> **v3 重构**: 删除 ~400 行重复 provider 代码，改为 subprocess 调用 AgentChat-WebExtended
> **🛡 安全策略 (2026-07-02)**: 永远不关闭用户 Chrome。`browser.close()` 已彻底移除，`--keep-tabs` 硬编码为 true。

## Architecture

```
AgentChat-FreeSubAgent (本 skill, ~350 行)
    │
    │  child_process.spawn('node', ['../AgentChat-WebExtended/index.js', '--from=X', prompt])
    ▼
AgentChat-WebExtended (Provider 唯一实现, 6 providers, 已验证 DOM 选择器)
    │
    │  playwright-core → Chrome CDP port 9222
    ▼
Chrome → Gemini / ChatGPT / Claude / Qwen / Kimi / MiniMax
```

**关键设计**: FreeSubAgent 不包含任何 provider 实现代码。所有 AI 调用通过 subprocess 委托给 AgentChat-WebExtended。

## 角色分工（互补，不重叠）

| AI | 角色 | 擅长 |
|----|------|------|
| **Kimi** | researcher | 长文分析、文献综述、细节提取、背景调研 |
| **Gemini** | depth_reasoner | 多步逻辑、数学分析、科学推理、复杂推演 |
| **Qwen (通义千问)** | reviewer_retriever | 事实核查、交叉验证、中文检索、联网搜索 |
| **ChatGPT** | creative_builder | 方案设计、代码生成、综合报告、可执行建议 |

## 各 AI 的 Prompt 编写规范（CRITICAL）

每个 AI 有特定的输入/output 偏好，写 prompt 时必须内嵌对应指令：

| AI | 必须附加的指令 | 原因 |
|----|---------------|------|
| **Kimi** | `用要点列出关键事实。不要运行任何代码。` | Kimi 联网搜索后倾向输出搜索词列表/执行 Python 而非直接给结论，显式禁止代码可强制其文字输出 |
| **Gemini** | `直接给出完整的分析。`  | Gemini 推理深度高，但偶尔会因多轮思考而截断，需要明确"完整" |
| **Qwen** | `每个结论标注信息来源。` | Qwen 联网检索能力强，但来源标注不稳定，显式要求可提升可验证性 |
| **ChatGPT** | `直接输出完整报告，不要解释方法论。` | ChatGPT 容易输出"我会从X/Y/Z维度分析…"的规划式回应，禁止其描述方法 |

## Dependencies

| 依赖 | 说明 |
|------|------|
| **AgentChat-WebExtended** | 必须在 `../AgentChat-WebExtended/index.js`（同仓库自动满足） |
| **Node.js** | v16+ |
| **Chrome CDP** | 端口 9222（WebExtended 负责连接，此 skill 不直接使用） |

## Claude Code 的操作流程

当用户调用此 skill 时，Claude Code 必须执行以下步骤：

### Step 1: 分析任务 & 拆解分工

根据用户任务的复杂度，将其拆解为 4 个互补的子任务。

**分工原则：**
- 同一个问题绝不发给两个 AI——每人做不同的角度
- Kimi 收集资料和背景，Gemini 做深度推理，Qwen 做事实核查和联网验证，ChatGPT 做综合输出
- 每个 prompt 必须自包含、可直接执行，要求 AI 直接给出答案（不说"我会..."）
- **编写每个 prompt 时，必须内嵌上表中对应 AI 的指令**

### Step 2: 写出 JSON Plan

```json
{
  "subtasks": [
    {
      "id": "research",
      "role": "researcher",
      "primary": "kimi",
      "prompt": "请收集关于...的详细资料和关键数据。用要点列出关键事实。不要运行任何代码。"
    },
    {
      "id": "mechanism",
      "role": "depth_reasoner",
      "primary": "gemini",
      "prompt": "请从理论机制层面深入分析...给出严谨推理和明确结论。直接给出完整的分析。"
    },
    {
      "id": "verify",
      "role": "reviewer_retriever",
      "primary": "qwen",
      "prompt": "请通过联网检索验证...直接给出检索结果和验证结论。每个结论标注信息来源。"
    },
    {
      "id": "synthesize",
      "role": "creative_builder",
      "primary": "chatgpt",
      "prompt": "请综合各维度的分析，直接输出完整的决策报告，包含评分矩阵和推荐排名。直接输出完整报告，不要解释方法论。"
    }
  ]
}
```

### Step 3: 并发调度

**默认命令**（4 workers 并发，完成后自动关闭标签页）：

```bash
node skills/AgentChat-FreeSubAgent/index.js --timeout=900 '<DAG_JSON_STRING>'
```

**保留标签页**（AI 回答后保留浏览器标签页，方便查看原始对话）：

```bash
node skills/AgentChat-FreeSubAgent/index.js --timeout=900 --keep-tabs '<DAG_JSON_STRING>'
```

或写入临时文件：

```bash
cat > /tmp/ai_plan.json << 'ENDJSON'
{...JSON计划...}
ENDJSON
node skills/AgentChat-FreeSubAgent/index.js --timeout=900 --keep-tabs "$(cat /tmp/ai_plan.json)"
```

### Step 4: 解读结果 & 呈现给用户

脚本输出结构化仲裁报告 + 各 worker 完整响应。Claude Code 解读并呈现给用户。

## Fallback Chain

任意 provider 不可用时自动降级（由 AgentChat-WebExtended 处理）：

```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiMo → MiniMax → DeepSeek
```

FreeSubAgent 层降级链严格遵循 WebExtended 原生顺序，不做优先级重排

降级结果会显式标记在输出中（provider_used ≠ primary_intended）。

## 验证过的 Provider 状态

| Provider | 状态 | 实现 |
|----------|------|------|
| Gemini | ✅ | AgentChat-WebExtended |
| ChatGPT | ✅ | AgentChat-WebExtended |
| Claude | ✅ | AgentChat-WebExtended |
| Qwen | ✅ 已验证 Tailwind DOM | AgentChat-WebExtended |
| Kimi | ✅ 新增 | AgentChat-WebExtended |
| MiMo | ⚠ 新增 | AgentChat-WebExtended |
| MiniMax | ⚠ 可用 | AgentChat-WebExtended |
| DeepSeek | ⚠ 新增 | AgentChat-WebExtended |

## 维护命令

```bash
# 检查所有 provider 可用性 (通过 WebExtended)
node skills/AgentChat-FreeSubAgent/index.js --smoke

# 检查 WebExtended 是否存在
node skills/AgentChat-FreeSubAgent/index.js --doctor
```

## 三模块架构

```
index.js
├── M1: buildDAG()            — 调 AI 分解任务为 4 个子 prompt（含 fallback 硬编码 DAG）
├── M2: dispatchParallel()    — Promise.all 并发 spawn 4 个 WebExtended 子进程
│       └── runOneWorker()    — 单 worker: callProvider → qualityGate
│              └── executeWithFallback() — primary → chain 降级
│                     └── callProvider() — child_process.spawn WebExtended
└── M3: arbitrateResults()    — 证据仲裁: 质量评分 + 长度差异检测 + 置信度计算
```

## Code Location

- `index.js` — 薄编排器 (~350 lines, 零 provider 代码)
- `SKILL.md` — this file
- Provider 实现 — `../AgentChat-WebExtended/index.js` (单源真相, ~1700 lines)
