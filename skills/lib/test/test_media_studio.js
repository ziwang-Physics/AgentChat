#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { normalizeMediaTask } = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'task'));
const { classifyProviderFailure, runWithFallback } = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'fallback'));
const { makeArtifactFilename, extensionForMime } = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'artifacts'));
const { buildExecutionPlan } = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'plan'));
const { getProviderConfig } = require(path.join(ROOT, 'agentchat-media-studio', 'providers'));
const {
    detectPageState,
    normalizeMediaCandidates,
    extractDurationSeconds,
    probeProviderPage,
    uploadReferences,
    applyProviderOptions,
    isDurationUnavailable,
} = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'mediaFactory'));
const { buildOneWebArgs } = require(path.join(ROOT, 'agentchat-media-studio', 'lib', 'oneWebImageAdapter'));
const {
    closeWithTimeout,
    parseArgs,
    readTaskInput,
    runProviderProbe,
    isProviderPreparationComplete,
    shouldCloseProbePages,
} = require(path.join(ROOT, 'agentchat-media-studio', 'index'));

function createXiaoyunqueProbePage(config, options = {}) {
    const actions = [];
    let settingsOpen = false;
    let customDurationOpen = false;
    let durationValue = '8';
    let editorValue = '';

    const selectorState = (selector) => {
        const staticSelectors = new Map([
            [config.editorSelectors[0], { visible: true, tagName: 'TEXTAREA' }],
            [config.probeControls.uploadButtonSelectors[0], { visible: true }],
            [config.probeControls.uploadInputSelectors[0], { visible: false }],
            [config.probeControls.skillButtonSelectors[0], { visible: true }],
            [config.probeControls.settingsButtonSelectors[0], { visible: true }],
            [config.generateSelectors[0], { visible: true, disabled: true }],
            ['body', { visible: true, text: '和 Agent 一起聊聊创作想法 60' }],
        ]);
        if (staticSelectors.has(selector)) return staticSelectors.get(selector);
        if (!settingsOpen) return null;
        if (config.probeControls.modelSelectors.includes(selector)) return { visible: true };
        if (config.probeControls.aspectRatioSelectors.includes(selector)) return { visible: true };
        if (
            !options.hideResolution &&
            config.probeControls.resolutionSelectors.includes(selector)
        ) return { visible: true };
        if (config.probeControls.customDurationButtonSelectors.includes(selector)) return { visible: true };
        if (customDurationOpen && selector === config.probeControls.durationTextSelector) {
            return { visible: true, value: durationValue, ariaLabel: '视频时长秒数' };
        }
        if (customDurationOpen && selector === config.probeControls.durationRangeSelector) {
            return {
                visible: true,
                value: durationValue,
                min: '4',
                max: '180',
                step: '1',
                ariaLabel: '视频秒数',
            };
        }
        return null;
    };

    const page = {
        actions,
        async goto(url) {
            actions.push({ type: 'goto', url });
        },
        async waitForTimeout() {},
        url() {
            return 'https://xyq.jianying.com/home?tab_name=home';
        },
        keyboard: {
            async press(key) {
                actions.push({ type: 'keyboard', key });
            },
        },
        locator(selector) {
            const locator = {
                first() { return locator; },
                last() { return locator; },
                async count() {
                    return selectorState(selector) ? 1 : 0;
                },
                async waitFor(options = {}) {
                    actions.push({ type: 'waitFor', selector, state: options.state });
                    const state = selectorState(selector);
                    if (!state) throw new Error(`Selector not attached: ${selector}`);
                    if (options.state === 'visible' && !state.visible) {
                        throw new Error(`Selector not visible: ${selector}`);
                    }
                },
                async isVisible() {
                    return Boolean(selectorState(selector)?.visible);
                },
                async click() {
                    actions.push({ type: 'click', selector });
                    if (config.probeControls.settingsButtonSelectors.includes(selector)) settingsOpen = true;
                    if (config.probeControls.customDurationButtonSelectors.includes(selector)) customDurationOpen = true;
                },
                async isDisabled() {
                    return Boolean(selectorState(selector)?.disabled);
                },
                async getAttribute(name) {
                    const state = selectorState(selector) || {};
                    if (name === 'min') return state.min ?? null;
                    if (name === 'max') return state.max ?? null;
                    if (name === 'step') return state.step ?? null;
                    if (name === 'aria-label') return state.ariaLabel ?? null;
                    return null;
                },
                async inputValue() {
                    if (selector === config.editorSelectors[0]) return editorValue;
                    return selectorState(selector)?.value || '';
                },
                async innerText() {
                    return selectorState(selector)?.text || '';
                },
                async evaluate(callback, value) {
                    const state = selectorState(selector) || {};
                    return callback({ tagName: state.tagName || 'DIV' }, value);
                },
                async fill(value) {
                    actions.push({ type: 'fill', selector, value });
                    if (selector === config.editorSelectors[0]) {
                        editorValue = String(value);
                    }
                    if (
                        selector === config.probeControls.durationTextSelector ||
                        selector === config.probeControls.durationRangeSelector
                    ) {
                        durationValue = String(value);
                    }
                },
                async setInputFiles(paths) {
                    actions.push({ type: 'setInputFiles', selector, paths });
                },
            };
            return locator;
        },
    };

    return page;
}

async function main() {
    {
        const task = normalizeMediaTask({ prompt: 'fashion film', mediaType: 'video' });
        assert.deepStrictEqual(task.providers, ['jimeng', 'xiaoyunque', 'doubao']);
        assert.strictEqual(task.aspectRatio, '9:16');
        assert.strictEqual(task.durationSeconds, null);
        assert.strictEqual(task.count, 1);
    }

    {
        const task = normalizeMediaTask({ prompt: 'fashion still', mediaType: 'image' });
        assert.deepStrictEqual(task.providers, ['chatgpt', 'doubao', 'jimeng', 'xiaoyunque']);
    }

    assert.throws(
        () => normalizeMediaTask({ prompt: '   ', mediaType: 'video' }),
        /prompt is required/i
    );
    assert.throws(
        () => normalizeMediaTask({ prompt: 'x', mediaType: 'audio' }),
        /mediaType/i
    );

    assert.strictEqual(classifyProviderFailure('今日免费积分已用完，请明天再来'), 'quota');
    assert.strictEqual(classifyProviderFailure('请登录后继续创作'), 'auth');
    assert.strictEqual(classifyProviderFailure('内容不符合平台规范'), 'safety');
    assert.strictEqual(classifyProviderFailure('生成失败，请重试'), 'generation');

    {
        const attempts = [];
        const adapters = {
            jimeng: {
                async generate() {
                    attempts.push('jimeng');
                    return { ok: false, reason: 'quota' };
                },
            },
            xiaoyunque: {
                async generate() {
                    attempts.push('xiaoyunque');
                    return { ok: true, artifacts: [{ path: 'out.mp4' }] };
                },
            },
        };
        const result = await runWithFallback(
            normalizeMediaTask({
                prompt: 'fashion film',
                mediaType: 'video',
                providers: ['jimeng', 'xiaoyunque'],
            }),
            adapters
        );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.provider, 'xiaoyunque');
        assert.deepStrictEqual(attempts, ['jimeng', 'xiaoyunque']);
        assert.deepStrictEqual(result.attempts, [
            { provider: 'jimeng', ok: false, reason: 'quota' },
            { provider: 'xiaoyunque', ok: true, reason: null },
        ]);
    }

    {
        let secondCalled = false;
        const result = await runWithFallback(
            normalizeMediaTask({
                prompt: 'unsafe request',
                mediaType: 'image',
                providers: ['doubao', 'jimeng'],
            }),
            {
                doubao: { async generate() { return { ok: false, reason: 'safety' }; } },
                jimeng: { async generate() { secondCalled = true; return { ok: true, artifacts: [] }; } },
            }
        );
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'safety');
        assert.strictEqual(secondCalled, false);
    }

    assert.strictEqual(extensionForMime('video/mp4'), 'mp4');
    assert.strictEqual(extensionForMime('image/webp'), 'webp');
    assert.strictEqual(extensionForMime('application/octet-stream', 'https://x/y.mov?token=1'), 'mov');
    assert.strictEqual(
        makeArtifactFilename({
            provider: 'jimeng',
            mediaType: 'video',
            index: 2,
            mimeType: 'video/mp4',
            timestamp: new Date('2026-08-17T09:10:11Z'),
        }),
        'jimeng-video-20260817-091011-02.mp4'
    );

    {
        const task = normalizeMediaTask({
            prompt: 'editorial knitwear film',
            mediaType: 'video',
            referenceImages: ['product.png'],
        });
        const plan = buildExecutionPlan(task, getProviderConfig);
        assert.strictEqual(plan.mediaType, 'video');
        assert.strictEqual(plan.inputMode, 'image-to-video');
        assert.deepStrictEqual(plan.routes.map((r) => r.provider), ['jimeng', 'xiaoyunque', 'doubao']);
        assert.strictEqual(plan.routes[0].url, 'https://jimeng.jianying.com/ai-tool/video-generation');
        assert.strictEqual(plan.routes[0].supported, true);
    }

    {
        const config = getProviderConfig('doubao');
        assert.strictEqual(config.supports.image, true);
        assert.strictEqual(config.supports.video, true);
        assert.ok(config.editorSelectors.length > 0);
        assert.ok(config.generateSelectors.length > 0);
        assert.ok(config.quotaPatterns.some((p) => p.test('今日积分已用完')));
        assert.deepStrictEqual(config.freePreferredModels, ['Seedance 2.0 Mini']);
        assert.strictEqual(
            config.probeControls.modelButtonSelectors[0],
            'button[data-input-engine-actionbar-control-key="video-model"]'
        );
        assert.strictEqual(
            config.probeControls.settingsButtonSelectors[0],
            'button[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]'
        );
        assert.strictEqual(
            config.probeControls.durationRoleSelector,
            '[role="menu"] [role="slider"]'
        );
        assert.strictEqual(config.probeControls.durationValueOffset, 4);
    }

    {
        const config = getProviderConfig('xiaoyunque');
        assert.strictEqual(
            config.urlForTask({ mediaType: 'video' }),
            'https://xyq.jianying.com/home?tab_name=home'
        );
        assert.strictEqual(config.editorSelectors[0], '.tiptap.ProseMirror');
        assert.ok(config.generateSelectors.includes('button[aria-label="开始生成"]'));
        assert.ok(config.generateSelectors.includes('button[aria-label="生成"]'));
        assert.deepStrictEqual(config.freePreferredModels, ['Seedance 2.0 Mini 体验版']);
        assert.strictEqual(config.autoSelectSkill, false);
        assert.strictEqual(config.defaultResolution, '720P');
        assert.strictEqual(config.defaultDurationSeconds, null);
        assert.strictEqual(
            config.probeControls.durationTextSelector,
            'input[aria-label="视频时长秒数"]'
        );
        assert.strictEqual(
            config.probeControls.durationRangeSelector,
            'input[aria-label="视频秒数"]'
        );
        for (const selector of [
            ...config.probeControls.modelSelectors,
            ...config.probeControls.aspectRatioSelectors,
            ...config.probeControls.resolutionSelectors,
            ...config.probeControls.customDurationButtonSelectors,
        ]) {
            assert.ok(
                selector.startsWith('[role="dialog"] '),
                `Settings selector must be dialog-scoped: ${selector}`
            );
        }
    }

    {
        const args = parseArgs(['--probe', '--provider=xiaoyunque']);
        assert.strictEqual(args.probe, true);
        assert.strictEqual(args.prepareOnly, false);
        assert.deepStrictEqual(args.providers, ['xiaoyunque']);
        assert.strictEqual(readTaskInput(args).prompt, 'readiness probe');
        const prepareArgs = parseArgs(['--prepare-only']);
        assert.strictEqual(prepareArgs.probe, true);
        assert.strictEqual(prepareArgs.prepareOnly, true);
        assert.strictEqual(shouldCloseProbePages(prepareArgs), false);
        assert.strictEqual(shouldCloseProbePages(args), true);
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config);
        const result = await probeProviderPage(page, config, { mediaType: 'video' });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.submitted, false);
        assert.strictEqual(result.state, 'ready');
        assert.strictEqual(result.controls.editor.found, true);
        assert.strictEqual(result.controls.uploadButton.found, true);
        assert.strictEqual(result.controls.uploadInput.found, true);
        assert.strictEqual(result.controls.skillButton.found, true);
        assert.strictEqual(result.controls.settingsButton.found, true);
        assert.strictEqual(result.controls.generateButton.found, true);
        assert.strictEqual(result.controls.generateButton.disabled, true);
        assert.strictEqual(result.controls.freePreferredModel.found, true);
        assert.deepStrictEqual(result.controls.duration, {
            customButtonFound: true,
            textInputFound: true,
            rangeInputFound: true,
            roleSliderFound: false,
            value: 8,
            min: 4,
            max: 180,
            step: 1,
        });
        assert.ok(page.actions.some((action) => (
            action.type === 'waitFor' &&
            action.selector === config.editorSelectors[0] &&
            action.state === 'visible'
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'click' &&
            config.probeControls.settingsButtonSelectors.includes(action.selector)
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'click' &&
            config.probeControls.customDurationButtonSelectors.includes(action.selector)
        )));
        assert.strictEqual(page.actions.some((action) => action.type === 'fill'), false);
        assert.strictEqual(page.actions.some((action) => action.type === 'setInputFiles'), false);
        assert.strictEqual(page.actions.some((action) => (
            action.type === 'click' &&
            config.generateSelectors.includes(action.selector)
        )), false);
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config, { hideResolution: true });
        const result = await probeProviderPage(page, config, normalizeMediaTask({
            prompt: 'fashion video',
            mediaType: 'video',
            providers: ['xiaoyunque'],
        }));
        assert.strictEqual(result.ready, true);
        assert.strictEqual(
            result.controls.resolutions.some((item) => item.found),
            false
        );
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config);
        const task = normalizeMediaTask({
            prompt: 'fashion video staging prompt',
            mediaType: 'video',
            providers: ['xiaoyunque'],
            referenceImages: [__filename],
            aspectRatio: '9:16',
            durationSeconds: 5,
        });
        const result = await runProviderProbe(task, {
            getPage: async () => page,
            prepareOnly: true,
        });
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.prepared, true);
        assert.strictEqual(result.submitted, false);
        assert.deepStrictEqual(result.optionsApplied, {
            modelApplied: true,
            ratioApplied: true,
            resolutionApplied: true,
            durationApplied: true,
            selectedDurationSeconds: 5,
        });
        assert.ok(page.actions.some((action) => (
            action.type === 'fill' &&
            action.selector === config.probeControls.durationTextSelector &&
            action.value === '5'
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'fill' &&
            action.selector === config.editorSelectors[0] &&
            action.value === task.prompt
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'setInputFiles' &&
            action.selector === config.probeControls.uploadInputSelectors[0] &&
            action.paths[0] === __filename
        )));
        assert.strictEqual(page.actions.some((action) => (
            action.type === 'click' &&
            config.generateSelectors.includes(action.selector)
        )), false);
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config);
        const task = normalizeMediaTask({
            prompt: 'readiness probe',
            mediaType: 'video',
            providers: ['xiaoyunque'],
        });
        const result = await runProviderProbe(task, {
            getPage: async () => page,
        });
        assert.strictEqual(result.provider, 'xiaoyunque');
        assert.strictEqual(result.ready, true);
        assert.strictEqual(result.submitted, false);
        await assert.rejects(
            () => runProviderProbe({ ...task, providers: ['xiaoyunque', 'doubao'] }, {
                getPage: async () => page,
            }),
            /exactly one provider/i
        );
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config);
        const uploaded = await uploadReferences(page, config, [__filename]);
        assert.strictEqual(uploaded, true);
        assert.deepStrictEqual(
            page.actions.find((action) => action.type === 'setInputFiles'),
            {
                type: 'setInputFiles',
                selector: config.probeControls.uploadInputSelectors[0],
                paths: [__filename],
            }
        );
    }

    {
        const config = getProviderConfig('xiaoyunque');
        const page = createXiaoyunqueProbePage(config);
        const result = await applyProviderOptions(page, config, normalizeMediaTask({
            prompt: 'fashion video',
            mediaType: 'video',
            providers: ['xiaoyunque'],
            aspectRatio: '9:16',
            durationSeconds: 5,
            providerOptions: {
                xiaoyunque: {
                    resolution: '720P',
                },
            },
        }));
        assert.deepStrictEqual(result, {
            modelApplied: true,
            ratioApplied: true,
            resolutionApplied: true,
            durationApplied: true,
            selectedDurationSeconds: 5,
        });
        assert.ok(page.actions.some((action) => (
            action.type === 'click' &&
            action.selector.includes('Seedance 2.0 Mini 体验版')
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'click' &&
            action.selector === config.probeControls.aspectRatioSelectors.find(
                (selector) => selector.includes('"9:16"')
            )
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'click' &&
            action.selector === config.probeControls.resolutionSelectors.find(
                (selector) => selector.includes('"720P"')
            )
        )));
        assert.ok(page.actions.some((action) => (
            action.type === 'fill' &&
            action.selector === config.probeControls.durationTextSelector &&
            action.value === '5'
        )));
        assert.strictEqual(page.actions.some((action) => (
            action.type === 'click' &&
            config.generateSelectors.includes(action.selector)
        )), false);
    }

    {
        const args = buildOneWebArgs(normalizeMediaTask({
            prompt: 'fashion still',
            mediaType: 'image',
            referenceImages: ['product.png'],
            count: 2,
        }));
        assert.deepStrictEqual(args.slice(0, 4), ['--only=chatgpt', '--single', '--image', '--timeout=600000']);
        assert.ok(args.some((arg) => arg.endsWith('product.png') && arg.startsWith('--image-path=')));
        assert.ok(args.at(-1).includes('Create 2 image variations'));
    }

    {
        const config = getProviderConfig('jimeng');
        assert.strictEqual(detectPageState('正在生成，预计需要 2 分钟', config), 'processing');
        assert.strictEqual(detectPageState('今日免费积分已用完', config), 'quota');
        assert.strictEqual(detectPageState('请登录后继续创作', config), 'auth');
        assert.strictEqual(detectPageState('生成失败，请重试', config), 'generation');
        assert.strictEqual(detectPageState('生成内容中疑似包含侵权 / 违规内容，无法返回该内容', config), 'safety');
        assert.strictEqual(detectPageState('作品已完成', config), 'ready');
    }

    assert.strictEqual(
        extractDurationSeconds('生成视频：fashion prompt，10s'),
        10
    );
    assert.strictEqual(
        extractDurationSeconds('生成视频：fashion prompt'),
        null
    );
    assert.strictEqual(
        isDurationUnavailable(
            normalizeMediaTask({
                prompt: 'fashion prompt',
                mediaType: 'video',
                durationSeconds: 5,
            }),
            { durationApplied: false }
        ),
        true
    );
    assert.strictEqual(
        isDurationUnavailable(
            normalizeMediaTask({
                prompt: 'fashion prompt',
                mediaType: 'video',
                durationSeconds: 5,
                allowDefaultDuration: true,
            }),
            { durationApplied: false }
        ),
        false
    );
    assert.strictEqual(
        isProviderPreparationComplete(
            normalizeMediaTask({
                prompt: 'fashion prompt',
                mediaType: 'video',
                providers: ['xiaoyunque'],
                durationSeconds: 5,
            }),
            getProviderConfig('xiaoyunque'),
            {
                modelApplied: true,
                ratioApplied: true,
                resolutionApplied: false,
                durationApplied: true,
            }
        ),
        true
    );
    assert.strictEqual(
        isProviderPreparationComplete(
            normalizeMediaTask({
                prompt: 'fashion prompt',
                mediaType: 'video',
                providers: ['xiaoyunque'],
                durationSeconds: 5,
                providerOptions: {
                    xiaoyunque: { resolution: '720P' },
                },
            }),
            getProviderConfig('xiaoyunque'),
            {
                modelApplied: true,
                ratioApplied: true,
                resolutionApplied: false,
                durationApplied: true,
            }
        ),
        false
    );

    {
        const started = Date.now();
        await closeWithTimeout(() => new Promise(() => {}), 20);
        assert.ok(Date.now() - started < 250);
    }

    assert.deepStrictEqual(
        normalizeMediaCandidates([
            { kind: 'image', src: 'https://x/a.png', width: 32, height: 32 },
            { kind: 'image', src: 'https://x/b.png', width: 1024, height: 1536 },
            { kind: 'video', src: 'blob:https://x/1', width: 720, height: 1280 },
            { kind: 'video', src: 'blob:https://x/1', width: 720, height: 1280 },
        ]),
        [
            { kind: 'image', src: 'https://x/b.png', width: 1024, height: 1536 },
            { kind: 'video', src: 'blob:https://x/1', width: 720, height: 1280 },
        ]
    );

    {
        const cli = path.join(ROOT, 'agentchat-media-studio', 'index.js');
        const result = spawnSync('node', [
            cli,
            '--dry-run',
            '--media-type=video',
            '--provider=jimeng,xiaoyunque',
            '--aspect-ratio=16:9',
            'fashion campaign',
        ], { encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.strictEqual(payload.ok, true);
        assert.strictEqual(payload.dryRun, true);
        assert.strictEqual(payload.task.prompt, 'fashion campaign');
        assert.strictEqual(payload.plan.aspectRatio, '16:9');
        assert.deepStrictEqual(payload.plan.routes.map((r) => r.provider), ['jimeng', 'xiaoyunque']);
    }

    console.log('media studio tests passed');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
