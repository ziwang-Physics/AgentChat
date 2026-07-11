#!/usr/bin/env node
/**
 * AgentChat MCP Server — 将 8 个 AI Provider 暴露为 MCP 工具。
 *
 * MCP 客户端 (Claude Desktop / Cursor / Continue.dev) 发现并调用这些工具，
 * 无需了解底层 Chrome CDP 细节。
 *
 * 用法:
 *   直接运行（stdio 模式）:
 *     node skills/mcp-server/index.mjs
 *
 *   Claude Desktop 配置 (claude_desktop_config.json):
 *     {
 *       "mcpServers": {
 *         "agentchat": {
 *           "command": "node",
 *           "args": ["path/to/skills/mcp-server/index.mjs"]
 *         }
 *       }
 *     }
 *
 * 前提: Chrome CDP 必须在 9222 端口运行
 *       bash scripts/start-chrome-debug.sh (Linux)
 *       powershell .\scripts\start-chrome.ps1 (Windows)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import { z } from "zod";

// ── 配置 ──────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "../..");
const WEBEXT_INDEX = path.join(PROJECT_DIR, "skills/AgentChat-WebExtended/index.js");
const NODE_EXE = process.execPath;
const DEFAULT_TIMEOUT = 600_000;    // 10 分钟总超时
const DEFAULT_PROV_TIMEOUT = 180_000; // 3 分钟单 Provider

// ── 工具：执行 WebExtended CLI ────────────────────────────────────────────

/**
 * 调用 AgentChat-WebExtended CLI，返回 stdout。
 * @param {string} prompt
 * @param {object} opts
 * @returns {Promise<string>}
 */
function callWebext(prompt, opts = {}) {
    return new Promise((resolve, reject) => {
        const args = [
            WEBEXT_INDEX,
            `--timeout=${opts.timeout || DEFAULT_TIMEOUT}`,
            `--timeout-per-provider=${opts.provTimeout || DEFAULT_PROV_TIMEOUT}`,
        ];
        if (opts.from) args.push(`--from=${opts.from}`);
        // --single: try ONLY the named provider — no internal cascade. Without
        // it, gemini_think could exhaust Gemini's quota, silently fall through
        // to ChatGPT/Qwen/…, and return THAT text labeled as "Gemini 推理" —
        // the silent-wrong-provider class WebExtended's --single exists to
        // prevent. Provider-named tools must fail loudly, not impersonate.
        if (opts.single) args.push("--single");
        if (opts.keepTabs) args.push("--keep-tabs");

        const child = spawn(NODE_EXE, args, {
            cwd: PROJECT_DIR,
            stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (d) => { stdout += d.toString(); });
        child.stderr.on("data", (d) => { stderr += d.toString(); });

        child.on("close", (code) => {
            if (code === 0 && stdout.trim()) {
                resolve(stdout.trim());
            } else {
                // 提取 stderr 中的最后一行有意义信息
                const lines = stderr.split("\n").filter(Boolean);
                const lastInfo = lines.slice(-3).join(" | ");
                reject(new Error(
                    `AgentChat exited ${code}: ${lastInfo || "unknown error"}`
                ));
            }
        });

        child.on("error", reject);

        // 写入 prompt
        if (prompt) {
            child.stdin.write(prompt);
            child.stdin.end();
        }
    });
}

/**
 * 执行 smoke test
 * @returns {Promise<string>}
 */
function callSmoke() {
    return new Promise((resolve, reject) => {
        const child = spawn(NODE_EXE, [WEBEXT_INDEX, "--smoke"], {
            cwd: PROJECT_DIR,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stderr = "";
        child.stderr.on("data", (d) => { stderr += d.toString(); });
        child.on("close", (code) => {
            if (code === 0) {
                // 提取各 Provider 状态
                const lines = stderr.split("\n").filter((l) =>
                    l.includes("REACHABLE") || l.includes("UNREACHABLE") ||
                    l.includes("needs login")
                );
                resolve(lines.join("\n") || "OK — smoke test passed");
            } else {
                resolve(`Smoke test exit ${code}: Chrome CDP may not be running.`);
            }
        });
        child.on("error", reject);
    });
}

// ── MCP Server ────────────────────────────────────────────────────────────

const server = new McpServer({
    name: "agentchat",
    version: "1.0.0",
});

// ── 工具 1: gemini_think — Pro Extended 深度推理 ─────────────────────────

server.tool(
    "gemini_think",
    "通过 Gemini Pro Extended Thinking 做深度推理。适合多步逻辑、数学分析、复杂推演。需要 Gemini Pro 订阅。",
    {
        prompt: z.string().describe("推理问题（中文/英文均可）"),
        timeout_ms: z.number().optional().describe("超时时间（毫秒），默认 600000（10 分钟）"),
    },
    async ({ prompt, timeout_ms }) => {
        const t = Number(timeout_ms) || DEFAULT_TIMEOUT;
        const pt = Math.min(t, Math.floor(t / 2));
        try {
            const result = await callWebext(prompt, {
                from: "gemini",
                single: true, // Gemini-named tool must never return another provider's output
                timeout: t,
                provTimeout: pt,
            });
            return {
                content: [{ type: "text", text: result }],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Gemini 推理失败: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// ── 工具 2: gemini_chat — 多轮对话 ───────────────────────────────────────

server.tool(
    "gemini_chat",
    // DESCRIPTION FIX: previously claimed "保留对话上下文" — false. WebExtended
    // reuses the Gemini tab but page.goto()'s the app URL, which STARTS A NEW
    // CHAT every invocation (see findProviderPage's comment in its index.js).
    // Cross-call context was never retained; the tool description must not
    // promise it. Callers needing context must embed prior turns in `prompt`.
    "向 Gemini 发送单轮消息（复用已有 tab，但每次调用开启新对话，不保留跨调用上下文；如需上下文请把之前的问答拼进 prompt）。",
    {
        prompt: z.string().describe("对话内容"),
    },
    async ({ prompt }) => {
        try {
            const result = await callWebext(prompt, {
                from: "gemini",
                single: true, // Gemini-named tool must never return another provider's output
                keepTabs: true,
                timeout: DEFAULT_TIMEOUT,
                provTimeout: DEFAULT_PROV_TIMEOUT,
            });
            return {
                content: [{ type: "text", text: result }],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Gemini 对话失败: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// ── 工具 3: web_ask — 指定 Provider 提问 ──────────────────────────────────

const PROVIDER_NAMES = [
    "gemini", "chatgpt", "claude", "qwen",
    "kimi", "minimax", "mimo", "deepseek"
];

server.tool(
    "web_ask",
    "通过 8 个 AI Provider 降级链提问。Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek。默认 Gemini 开始，不可用自动降级。",
    {
        prompt: z.string().describe("问题文本"),
        provider: z.enum(["gemini","chatgpt","claude","qwen","kimi","minimax","mimo","deepseek"]).optional().describe("从哪个 Provider 开始，默认 gemini"),
        timeout_ms: z.number().optional().describe("超时（毫秒），默认 600000"),
    },
    async ({ prompt, provider, timeout_ms }) => {
        const t = Number(timeout_ms) || DEFAULT_TIMEOUT;
        const from = PROVIDER_NAMES.includes(provider) ? provider : "gemini";
        try {
            const result = await callWebext(prompt, {
                from,
                timeout: t,
                provTimeout: Math.min(t, Math.floor(t / 2)),
            });
            return {
                content: [{ type: "text", text: result }],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `${from} 调用失败: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// ── 工具 4: web_smoke — 检查 Provider 可用性 ─────────────────────────────

server.tool(
    "web_smoke",
    "检查所有 8 个 AI Provider 的可达性。返回每个 Provider 的状态：REACHABLE / UNREACHABLE / needs login。",
    {},
    async () => {
        try {
            const report = await callSmoke();
            return {
                content: [{ type: "text", text: report || "Smoke test completed." }],
            };
        } catch (e) {
            return {
                content: [{ type: "text", text: `Smoke test 失败: ${e.message}` }],
                isError: true,
            };
        }
    }
);

// ── 启动 ──────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // StdioServerTransport 通过 stderr 写日志，stdout 走 MCP 协议
    console.error("[agentchat-mcp] MCP Server started. Waiting for client...");
    console.error("[agentchat-mcp] CDP port: 9222");
    console.error("[agentchat-mcp] Tools: gemini_think, gemini_chat, web_ask, web_smoke");
}

main().catch((e) => {
    console.error("[agentchat-mcp] FATAL:", e.message);
    process.exit(1);
});
