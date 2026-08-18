#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeMediaTask } = require('./lib/task');
const { buildExecutionPlan } = require('./lib/plan');
const { runWithFallback } = require('./lib/fallback');
const {
    createBrowserMediaAdapter,
    probeProviderPage,
    stageProviderTask,
} = require('./lib/mediaFactory');
const { createOneWebImageAdapter } = require('./lib/oneWebImageAdapter');
const { getProviderConfig } = require('./providers');
const { ensureChromeCdp, connectWithRetry, CDP_URL } = require('../lib/cdp');
const { makeRunId, emitReceipt } = require('../lib/receipt');

function parseArgs(argv) {
    const options = {
        referenceImages: [],
        providers: null,
        dryRun: false,
        probe: false,
        prepareOnly: false,
        allowDefaultDuration: false,
    };
    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--probe') options.probe = true;
        else if (arg === '--prepare-only') {
            options.probe = true;
            options.prepareOnly = true;
        }
        else if (arg === '--allow-default-duration') options.allowDefaultDuration = true;
        else if (arg.startsWith('--media-type=')) options.mediaType = arg.split('=').slice(1).join('=');
        else if (arg.startsWith('--provider=')) options.providers = arg.split('=').slice(1).join('=').split(',').filter(Boolean);
        else if (arg.startsWith('--image-path=')) options.referenceImages.push(arg.split('=').slice(1).join('='));
        else if (arg.startsWith('--output-dir=')) options.outputDir = arg.split('=').slice(1).join('=');
        else if (arg.startsWith('--aspect-ratio=')) options.aspectRatio = arg.split('=').slice(1).join('=');
        else if (arg.startsWith('--duration=')) options.durationSeconds = Number(arg.split('=')[1]);
        else if (arg.startsWith('--count=')) options.count = Number(arg.split('=')[1]);
        else if (arg.startsWith('--timeout=')) options.timeoutMs = Number(arg.split('=')[1]);
        else if (arg.startsWith('--task-file=')) options.taskFile = arg.split('=').slice(1).join('=');
        else if (!arg.startsWith('--')) positional.push(arg);
    }

    options.prompt = positional.join(' ').trim();
    return options;
}

function writeJsonAndExit(payload, exitCode = 0) {
    const text = JSON.stringify(payload, null, 2) + '\n';
    process.stdout.write(text, () => process.exit(exitCode));
}

function readTaskInput(options) {
    let fileTask = {};
    if (options.taskFile) {
        fileTask = JSON.parse(fs.readFileSync(path.resolve(options.taskFile), 'utf8'));
    }
    if (!options.prompt && !process.stdin.isTTY) {
        options.prompt = fs.readFileSync(0, 'utf8').trim();
    }
    return {
        ...fileTask,
        ...((options.prompt || options.probe) ? {
            prompt: options.prompt || 'readiness probe',
        } : {}),
        ...(options.mediaType ? { mediaType: options.mediaType } : {}),
        ...(options.providers ? { providers: options.providers } : {}),
        ...(options.referenceImages.length ? { referenceImages: options.referenceImages } : {}),
        ...(options.outputDir ? { outputDir: options.outputDir } : {}),
        ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options.durationSeconds ? { durationSeconds: options.durationSeconds } : {}),
        ...(options.count ? { count: options.count } : {}),
        ...(options.allowDefaultDuration ? { allowDefaultDuration: true } : {}),
    };
}

async function closeWithTimeout(operation, timeoutMs = 2000) {
    await Promise.race([
        Promise.resolve().then(operation).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

async function createPageManager() {
    const { chromium } = require('playwright-core');
    const status = await ensureChromeCdp();
    if (!status.up) throw new Error(`Chrome CDP unavailable: ${status.reason || CDP_URL}`);
    const browser = await connectWithRetry(chromium, CDP_URL, 3);
    const context = browser.contexts()[0] || await browser.newContext({ acceptDownloads: true });
    const createdPages = new Set();

    return {
        browser,
        async getPage(config) {
            for (const page of context.pages()) {
                try {
                    if (config.hosts.some((host) => new URL(page.url()).hostname.endsWith(host))) {
                        return page;
                    }
                } catch (_) {}
            }
            const page = await context.newPage();
            createdPages.add(page);
            return page;
        },
        async close() {
            for (const page of createdPages) {
                await closeWithTimeout(
                    () => (page.isClosed() ? undefined : page.close()),
                    3000
                );
            }
            // connectOverCDP's close can remain pending while a provider still
            // owns a long-running generation. Disconnect best-effort without
            // holding the CLI open after artifacts have already been saved.
            await closeWithTimeout(() => browser.close(), 1000);
        },
    };
}

function isProviderPreparationComplete(task, config, optionsApplied) {
    const providerOptions = (
        task.providerOptions &&
        typeof task.providerOptions[config.key] === 'object'
    ) ? task.providerOptions[config.key] : {};
    return (
        optionsApplied.modelApplied &&
        optionsApplied.ratioApplied &&
        optionsApplied.durationApplied &&
        (!providerOptions.resolution || optionsApplied.resolutionApplied)
    );
}

function shouldCloseProbePages(options) {
    return !options.prepareOnly;
}

async function runProviderProbe(task, context, configResolver = getProviderConfig) {
    if (!Array.isArray(task.providers) || task.providers.length !== 1) {
        throw new Error('Probe mode requires exactly one provider');
    }
    const provider = task.providers[0];
    const config = configResolver(provider);
    if (!config) throw new Error(`Unknown provider: ${provider}`);
    if (config.runner === 'oneweb') {
        throw new Error(`Probe mode is unavailable for runner: ${config.runner}`);
    }
    const page = await context.getPage(config, task);
    const probe = await probeProviderPage(page, config, task);
    if (!context.prepareOnly || !probe.ready) {
        return {
            ...probe,
            prepared: false,
        };
    }
    const staged = await stageProviderTask(page, config, task);
    const prepared = (
        staged.promptFilled &&
        staged.referencesUploaded &&
        isProviderPreparationComplete(task, config, staged.optionsApplied)
    );
    return {
        ...probe,
        ok: prepared,
        prepared,
        promptFilled: staged.promptFilled,
        referencesUploaded: staged.referencesUploaded,
        optionsApplied: staged.optionsApplied,
        submitted: false,
    };
}

async function main() {
    const started = Date.now();
    const options = parseArgs(process.argv.slice(2));
    const task = normalizeMediaTask(readTaskInput(options));
    const plan = buildExecutionPlan(task, getProviderConfig);
    const runId = makeRunId();

    if (options.dryRun) {
        const receipt = emitReceipt({
            skillDir: __dirname,
            skill: 'agentchat-media-studio',
            runId,
            fields: { mode: 'dry-run', exit: 0, media_type: task.mediaType },
            stream: null,
        });
        writeJsonAndExit({ ok: true, dryRun: true, task, plan, receipt }, 0);
        return;
    }

    if (options.probe) {
        let probePages = null;
        let probeResult;
        try {
            probePages = await createPageManager();
            probeResult = await runProviderProbe(task, {
                getPage: (config) => probePages.getPage(config),
                prepareOnly: options.prepareOnly,
            });
        } finally {
            if (probePages && shouldCloseProbePages(options)) {
                await probePages.close();
            }
        }
        const receipt = emitReceipt({
            skillDir: __dirname,
            skill: 'agentchat-media-studio',
            runId,
            fields: {
                mode: options.prepareOnly ? 'prepare-only' : 'probe',
                exit: probeResult.ready ? 0 : 2,
                provider: probeResult.provider,
                ready: probeResult.ready,
                submitted: false,
                total_ms: Date.now() - started,
            },
            stream: null,
        });
        writeJsonAndExit({
            ...probeResult,
            probe: true,
            prepareOnly: options.prepareOnly,
            task,
            plan,
            receipt,
        }, probeResult.ready ? 0 : 2);
        return;
    }

    let pages = null;
    let result;
    try {
        pages = await createPageManager();
        const adapters = {};
        for (const provider of task.providers) {
            const config = getProviderConfig(provider);
            if (!config) continue;
            if (config.runner === 'oneweb') {
                adapters[provider] = createOneWebImageAdapter(
                    path.resolve(__dirname, '..', 'AgentChat-OneWeb', 'index.js')
                );
            } else {
                adapters[provider] = createBrowserMediaAdapter(config);
            }
        }
        result = await runWithFallback(task, adapters, {
            getPage: (config) => pages.getPage(config),
            timeoutMs: options.timeoutMs,
        });
    } finally {
        if (pages) await pages.close();
    }

    const receipt = emitReceipt({
        skillDir: __dirname,
        skill: 'agentchat-media-studio',
        runId,
        fields: {
            mode: 'generate',
            exit: result.ok ? 0 : 2,
            media_type: task.mediaType,
            provider_used: result.provider,
            artifacts: result.artifacts ? result.artifacts.length : 0,
            total_ms: Date.now() - started,
        },
        stream: null,
    });

    writeJsonAndExit({ ...result, task, plan, receipt }, result.ok ? 0 : 2);
}

if (require.main === module) {
    main().catch((error) => {
        const receipt = emitReceipt({
            skillDir: __dirname,
            skill: 'agentchat-media-studio',
            runId: makeRunId(),
            fields: { mode: 'generate', exit: 4, error: error.message },
            stream: null,
        });
        writeJsonAndExit({ ok: false, reason: 'internal', error: error.message, receipt }, 4);
    });
}

module.exports = {
    parseArgs,
    readTaskInput,
    createPageManager,
    closeWithTimeout,
    writeJsonAndExit,
    runProviderProbe,
    isProviderPreparationComplete,
    shouldCloseProbePages,
};
