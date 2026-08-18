'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function buildOneWebArgs(task) {
    const countInstruction = task.count > 1
        ? ` Create ${task.count} image variations.`
        : '';
    const prompt = `${task.prompt}${countInstruction}`;
    return [
        '--only=chatgpt',
        '--single',
        '--image',
        '--timeout=600000',
        ...task.referenceImages.map((imagePath) => `--image-path=${imagePath}`),
        prompt,
    ];
}

function reasonForExit(code, stderr) {
    if (code === 2) return 'auth';
    if (code === 3) return 'safety';
    if (code === 5) return 'quota';
    if (code === 10) return 'timeout';
    if (/quota|额度|次数.*用完/i.test(stderr || '')) return 'quota';
    return 'generation';
}

function parseReceipt(stderr) {
    const lines = String(stderr || '').split(/\r?\n/);
    for (const line of lines.reverse()) {
        const match = line.match(/\[receipt\]\s+AGENTCHAT_RUN\s+(\{.*\})/);
        if (!match) continue;
        try { return JSON.parse(match[1]); } catch (_) {}
    }
    return null;
}

function runProcess(command, args, options) {
    return new Promise((resolve) => {
        const child = spawn(command, args, options);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => resolve({ code: 4, stdout, stderr, error }));
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

function createOneWebImageAdapter(oneWebPath) {
    return {
        async generate(task) {
            if (task.mediaType !== 'image') {
                return { ok: false, reason: 'unsupported' };
            }
            await fs.promises.mkdir(task.outputDir, { recursive: true });
            const before = new Set(await fs.promises.readdir(task.outputDir));
            const result = await runProcess('node', [oneWebPath, ...buildOneWebArgs(task)], {
                cwd: task.outputDir,
                windowsHide: true,
                env: process.env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const after = await fs.promises.readdir(task.outputDir);
            const files = after
                .filter((name) => !before.has(name))
                .filter((name) => /^ai-image-.*\.(?:png|jpe?g|webp|gif|svg)$/i.test(name))
                .slice(0, task.count);

            if (result.code !== 0) {
                return {
                    ok: false,
                    reason: reasonForExit(result.code, result.stderr),
                    error: result.stderr.slice(-1000),
                    receipt: parseReceipt(result.stderr),
                };
            }
            if (!files.length) {
                return {
                    ok: false,
                    reason: 'artifact',
                    error: 'ChatGPT completed without a downloaded image artifact',
                    receipt: parseReceipt(result.stderr),
                };
            }
            const artifacts = [];
            for (const filename of files) {
                const outputPath = path.join(task.outputDir, filename);
                const stat = await fs.promises.stat(outputPath);
                artifacts.push({
                    path: outputPath,
                    filename,
                    bytes: stat.size,
                    source: 'AgentChat-OneWeb/chatgpt',
                });
            }
            return {
                ok: true,
                artifacts,
                response: result.stdout.trim(),
                receipt: parseReceipt(result.stderr),
            };
        },
    };
}

module.exports = {
    buildOneWebArgs,
    createOneWebImageAdapter,
    parseReceipt,
    reasonForExit,
};
