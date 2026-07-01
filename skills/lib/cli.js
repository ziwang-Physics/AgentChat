/**
 * Shared CLI Argument Parser — single implementation used by all 3 skills.
 *
 * Supports:
 *   - Boolean flags:     --smoke, --doctor, --close
 *   - Value flags:       --timeout=600000, --from=ChatGPT, --concurrency=3
 *   - Multi-value:       --prompt "q1" --prompt "q2"
 *   - Positional args:   node index.js "single prompt here"
 *   - Stdin fallback:    echo "prompt" | node index.js
 *   - File input:        --file=prompts.txt
 *
 * Usage:
 *   const { parseArgs, readStdin, collectPrompt } = require('../lib/cli');
 *
 *   const optionDefs = [
 *     { name: 'timeout', type: 'number', flag: true, default: 600000 },
 *     { name: 'smoke', type: 'boolean', default: false },
 *     { name: 'from', type: 'string', flag: true },
 *   ];
 *   const { flags, positional } = parseArgs(process.argv.slice(2), optionDefs);
 */

const fs = require('fs');

// ══════════════════════════════════════════════════════════════════════════════
// readStdin — read entire stdin as a string
// ══════════════════════════════════════════════════════════════════════════════

async function readStdin() {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks.map(c => Buffer.from(c, 'utf-8'))).toString('utf-8').trim();
}

// ══════════════════════════════════════════════════════════════════════════════
// parseArgs — parse argv against option definitions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * @param {string[]} argv        — process.argv.slice(2)
 * @param {object[]} optionDefs  — [{ name, type, flag?, default?, multi? }]
 * @returns {{ flags: object, positional: string[] }}
 */
function parseArgs(argv, optionDefs) {
    // Initialize flags with defaults
    const flags = {};
    for (const def of optionDefs) {
        if (def.type === 'boolean') {
            flags[def.name] = def.default || false;
        } else if (def.type === 'array') {
            flags[def.name] = def.default || [];
        } else {
            flags[def.name] = def.default !== undefined ? def.default : null;
        }
    }

    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        // Boolean flags (no value): --smoke, --doctor, --close
        let matched = false;
        for (const def of optionDefs) {
            if (def.type === 'boolean' && (a === `--${def.name}` || a === `--${def.alias}`)) {
                flags[def.name] = true;
                matched = true;
                break;
            }
        }
        if (matched) continue;

        // --flag=value style
        if (a.startsWith('--') && a.includes('=')) {
            const eqIdx = a.indexOf('=');
            const key = a.substring(2, eqIdx);
            const val = a.substring(eqIdx + 1);
            let applied = false;
            for (const def of optionDefs) {
                if ((key === def.name || key === def.alias) && def.flag !== false && def.type !== 'boolean') {
                    if (def.type === 'number') {
                        const n = parseInt(val, 10);
                        if (!isNaN(n) && n > 0) flags[def.name] = n;
                    } else if (def.type === 'array') {
                        flags[def.name].push(val);
                    } else {
                        flags[def.name] = val;
                    }
                    applied = true;
                    break;
                }
            }
            if (!applied) {
                // Unknown --flag=value → treat as positional
                positional.push(a);
            }
            continue;
        }

        // --flag next-arg style
        if (a.startsWith('--') && i + 1 < argv.length) {
            const key = a.substring(2);
            let applied = false;
            for (const def of optionDefs) {
                if ((key === def.name || key === def.alias) && def.flag !== false && def.type !== 'boolean') {
                    const val = argv[i + 1];
                    if (def.type === 'number') {
                        const n = parseInt(val, 10);
                        if (!isNaN(n) && n > 0) flags[def.name] = n;
                    } else if (def.type === 'array') {
                        flags[def.name].push(val);
                    } else {
                        flags[def.name] = val;
                    }
                    i++; // consumed next arg
                    applied = true;
                    break;
                }
            }
            if (!applied) {
                positional.push(a); // unknown flag
            }
            continue;
        }

        // Not a flag → positional
        if (!a.startsWith('-')) {
            positional.push(a);
        }
    }

    return { flags, positional };
}

// ══════════════════════════════════════════════════════════════════════════════
// collectPrompt — assemble prompt from flags + positional + stdin
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build the final prompt string, trying (in order):
 *   1. positional args joined
 *   2. stdin (if not TTY)
 *
 * @param {object} flags      — parsed flags
 * @param {string[]} positional — parsed positional args
 * @returns {Promise<string>}
 */
async function collectPrompt(flags, positional) {
    let prompt = positional.join(' ').trim();
    if (!prompt && !flags.smoke && !flags.doctor) {
        prompt = await readStdin();
    }
    return prompt;
}

// ══════════════════════════════════════════════════════════════════════════════
// collectTasks — collect an array of {index, prompt} tasks (for multi-worker skills)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * For multi-worker skills (gemini-web-extended-thinking), collect tasks from
 * --prompt flags, positional args, --file, and stdin (JSON array or plain text).
 *
 * @param {object} flags
 * @param {string[]} positional
 * @returns {Promise<Array<{index: number, prompt: string}>>}
 */
async function collectTasks(flags, positional) {
    let prompts = [...(flags.prompts || [])];

    // Positional args → single prompt (only if no --prompt flags)
    if (positional.length > 0 && prompts.length === 0) {
        prompts = [positional.join(' ')];
    }

    // --file: read prompts from file (one per line)
    if (flags.file) {
        const content = fs.readFileSync(flags.file, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        prompts = prompts.concat(lines);
    }

    // stdin fallback
    if (prompts.length === 0 && !flags.smoke && !flags.doctor && !process.stdin.isTTY) {
        const stdinText = await readStdin();
        if (stdinText) {
            try {
                const arr = JSON.parse(stdinText);
                if (Array.isArray(arr)) {
                    prompts = arr.map(s => String(s));
                } else {
                    prompts = [stdinText];
                }
            } catch {
                prompts = [stdinText];
            }
        }
    }

    return prompts.map((p, i) => ({ index: i, prompt: p }));
}

module.exports = { parseArgs, readStdin, collectPrompt, collectTasks };
