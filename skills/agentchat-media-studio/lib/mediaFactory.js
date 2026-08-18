'use strict';

const fs = require('fs');
const path = require('path');
const { classifyProviderFailure } = require('./fallback');
const { saveMediaCandidate, savePlaywrightDownload } = require('./artifacts');

function matchesAny(text, patterns = []) {
    return patterns.some((pattern) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
    });
}

function detectPageState(bodyText, config) {
    const text = String(bodyText || '');
    if (matchesAny(text, config.quotaPatterns)) return 'quota';
    if (matchesAny(text, config.authPatterns)) return 'auth';
    if (matchesAny(text, config.safetyPatterns)) return 'safety';
    if (matchesAny(text, config.failurePatterns)) return 'generation';
    if (matchesAny(text, config.processingPatterns)) return 'processing';
    return 'ready';
}

function extractDurationSeconds(text) {
    const match = String(text || '').match(/(?:^|[，,\s])(\d{1,3})\s*s(?:\b|$)/i);
    return match ? Number(match[1]) : null;
}

function normalizeMediaCandidates(items, minPx = 200) {
    const seen = new Set();
    const out = [];
    for (const raw of items || []) {
        if (!raw || !raw.src || !['image', 'video'].includes(raw.kind)) continue;
        const width = Number(raw.width || 0);
        const height = Number(raw.height || 0);
        if (width < minPx || height < minPx) continue;
        const key = `${raw.kind}:${raw.src}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ kind: raw.kind, src: raw.src, width, height });
    }
    return out;
}

async function collectMediaCandidates(page, minPx = 200) {
    const raw = await page.evaluate(() => {
        const output = [];
        for (const img of document.querySelectorAll('img')) {
            const src = img.currentSrc || img.src || '';
            const rect = img.getBoundingClientRect();
            output.push({
                kind: 'image',
                src,
                width: Math.max(rect.width || 0, img.naturalWidth || 0),
                height: Math.max(rect.height || 0, img.naturalHeight || 0),
            });
        }
        for (const video of document.querySelectorAll('video')) {
            const source = video.querySelector('source');
            const src = video.currentSrc || video.src || (source && source.src) || '';
            const rect = video.getBoundingClientRect();
            output.push({
                kind: 'video',
                src,
                width: Math.max(rect.width || 0, video.videoWidth || 0),
                height: Math.max(rect.height || 0, video.videoHeight || 0),
            });
        }
        return output;
    });
    return normalizeMediaCandidates(raw, minPx);
}

async function firstVisible(page, selectors, timeoutMs = 1500) {
    for (const selector of selectors || []) {
        try {
            const locator = page.locator(selector).last();
            await locator.waitFor({ state: 'visible', timeout: timeoutMs });
            return locator;
        } catch (_) {}
    }
    return null;
}

async function firstAttached(page, selectors) {
    for (const selector of selectors || []) {
        try {
            const locator = page.locator(selector).last();
            if (await locator.count() > 0) return locator;
        } catch (_) {}
    }
    return null;
}

async function clickFirstText(page, labels) {
    for (const label of labels || []) {
        const candidates = [];
        if (typeof page.getByRole === 'function') {
            candidates.push(
                page.getByRole('button', { name: label, exact: true }).last()
            );
        }
        if (typeof page.getByText === 'function') {
            candidates.push(page.getByText(label, { exact: true }).last());
        }
        if (typeof page.getByRole === 'function') {
            candidates.push(
                page.getByRole('button', { name: label, exact: false }).last()
            );
        }
        if (typeof page.getByText === 'function') {
            candidates.push(page.getByText(label, { exact: false }).last());
        }
        for (const locator of candidates) {
            try {
                await locator.waitFor({ state: 'visible', timeout: 1500 });
                await locator.click({ timeout: 1500 });
                await page.waitForTimeout(1500);
                return true;
            } catch (_) {}
        }
    }
    return false;
}

async function activateTaskMode(page, config, mediaType) {
    const activeSelectors = (
        config.modeActiveSelectors &&
        config.modeActiveSelectors[mediaType]
    ) || [];
    if (activeSelectors.length) {
        const active = await inspectSelector(page, activeSelectors);
        if (active.found && active.visible) return true;
    }
    return clickFirstText(page, (config.modeLabels || {})[mediaType]);
}

async function fillEditor(editor, prompt) {
    const tag = await editor.evaluate((el) => el.tagName.toLowerCase());
    if (tag === 'textarea' || tag === 'input') {
        await editor.fill(prompt);
    } else {
        await editor.click();
        await editor.press('ControlOrMeta+a');
        await editor.fill(prompt).catch(async () => {
            await editor.evaluate((el, value) => {
                el.focus();
                el.textContent = value;
                el.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: value,
                }));
            }, prompt);
        });
    }
}

async function editorContainsPrompt(editor, prompt) {
    try {
        const tag = await editor.evaluate((el) => el.tagName.toLowerCase());
        const value = tag === 'textarea' || tag === 'input'
            ? await editor.inputValue()
            : await editor.textContent();
        return String(value || '').includes(String(prompt || '').slice(0, 80));
    } catch (_) {
        return false;
    }
}

async function uploadReferences(page, config, paths) {
    if (!paths.length) return true;
    for (const file of paths) {
        if (!fs.existsSync(file)) throw new Error(`Reference image not found: ${file}`);
    }
    const input = await firstAttached(page, config.uploadSelectors);
    if (!input) return false;
    await input.setInputFiles(paths);
    await page.waitForTimeout(1500);
    return true;
}

async function applyOptions(page, task) {
    const ratioApplied = await clickFirstText(page, [task.aspectRatio]);
    let durationApplied = false;
    if (task.mediaType === 'video' && task.durationSeconds) {
        durationApplied = await clickFirstText(page, [
            `${task.durationSeconds}秒`,
            `${task.durationSeconds}s`,
        ]);
    }
    return { ratioApplied, durationApplied };
}

async function clickConfiguredSelector(page, selectors) {
    const status = await inspectSelector(page, selectors);
    if (!status.found) return false;
    return clickProbeControl(page, status);
}

async function applyProviderOptions(page, config, task) {
    if (!config.probeControls) {
        const basic = await applyOptions(page, task);
        return {
            modelApplied: false,
            ratioApplied: basic.ratioApplied,
            resolutionApplied: false,
            durationApplied: basic.durationApplied,
        };
    }

    const controls = config.probeControls;
    let modelStatuses = await inspectSelectorList(page, controls.modelSelectors);
    if (!modelStatuses.some((item) => item.found)) {
        await clickConfiguredSelector(
            page,
            controls.modelButtonSelectors || controls.settingsButtonSelectors
        );
        modelStatuses = await inspectSelectorList(page, controls.modelSelectors);
    }

    const providerOptions = (
        task.providerOptions &&
        typeof task.providerOptions[config.key] === 'object'
    ) ? task.providerOptions[config.key] : {};
    const model = String(
        providerOptions.model ||
        (config.freePreferredModels || [])[0] ||
        ''
    );
    const modelSelector = model
        ? selectorForLabel(controls.modelSelectors, model)
        : null;
    const modelApplied = modelSelector
        ? await clickConfiguredSelector(page, [modelSelector])
        : false;

    const ratioSelector = selectorForLabel(
        controls.aspectRatioSelectors,
        task.aspectRatio
    );
    let ratioApplied = ratioSelector
        ? await clickConfiguredSelector(page, [ratioSelector])
        : false;
    if (ratioSelector && !ratioApplied) {
        await clickConfiguredSelector(page, controls.settingsButtonSelectors);
        ratioApplied = await clickConfiguredSelector(page, [ratioSelector]);
    }

    const resolution = String(
        providerOptions.resolution ||
        config.defaultResolution ||
        ''
    );
    const resolutionSelector = selectorForLabel(
        controls.resolutionSelectors,
        resolution
    );
    const resolutionApplied = resolutionSelector
        ? await clickConfiguredSelector(page, [resolutionSelector])
        : false;

    let durationApplied = task.mediaType !== 'video' || (
        !task.durationSeconds && task.durationMode !== 'auto'
    );
    let selectedDurationSeconds = null;
    if (task.mediaType === 'video' && (
        task.durationSeconds || task.durationMode === 'auto'
    )) {
        let duration = await inspectDuration(page, controls);
        if (
            !duration.textInputFound &&
            !duration.rangeInputFound &&
            !duration.roleSliderFound
        ) {
            const opener = (controls.customDurationButtonSelectors || []).length
                ? controls.customDurationButtonSelectors
                : controls.settingsButtonSelectors;
            await clickConfiguredSelector(page, opener);
            duration = await inspectDuration(page, controls);
        }
        const requested = Number(
            task.durationSeconds || inferAutoDuration(task, duration)
        );
        const withinRange = (
            (duration.min === null || requested >= duration.min) &&
            (duration.max === null || requested <= duration.max)
        );
        if (withinRange && duration.textInputFound) {
            const input = page.locator(controls.durationTextSelector).first();
            try {
                await input.fill(String(requested));
                durationApplied = Number(await input.inputValue()) === requested;
            } catch (_) {
                durationApplied = false;
            }
        } else if (withinRange && duration.rangeInputFound) {
            const input = page.locator(controls.durationRangeSelector).first();
            try {
                await input.fill(String(requested));
                durationApplied = Number(await input.inputValue()) === requested;
            } catch (_) {
                durationApplied = false;
            }
        } else if (withinRange && duration.roleSliderFound) {
            const slider = page.locator(controls.durationRoleSelector).first();
            const offset = Number(controls.durationValueOffset || 0);
            const rawMinimum = Number(await slider.getAttribute('aria-valuemin') || 0);
            const rawTarget = requested - offset;
            try {
                await slider.focus();
                await slider.press('Home');
                for (let i = rawMinimum; i < rawTarget; i++) {
                    await slider.press('ArrowRight');
                }
                const rawValue = Number(await slider.getAttribute('aria-valuenow'));
                durationApplied = rawValue + offset === requested;
            } catch (_) {
                durationApplied = false;
            }
        } else {
            durationApplied = false;
        }
        if (durationApplied) selectedDurationSeconds = requested;
    }

    return {
        modelApplied,
        ratioApplied,
        resolutionApplied,
        durationApplied,
        selectedDurationSeconds,
    };
}

async function stageProviderTask(page, config, task) {
    // Uploading reference files can redraw the composer and invalidate the
    // editor handle. Fill first, upload second, then re-locate and verify.
    // This is the stable order used by the live Xiaoyunque flow.
    let editor = await firstVisible(page, config.editorSelectors, 5000);
    if (!editor) {
        return {
            promptFilled: false,
            referencesUploaded: false,
            optionsApplied: {
                modelApplied: false,
                ratioApplied: false,
                resolutionApplied: false,
                durationApplied: false,
            },
        };
    }
    await fillEditor(editor, task.prompt);

    const referencesUploaded = task.referenceImages.length
        ? await uploadReferences(page, config, task.referenceImages)
        : true;
    if (!referencesUploaded) {
        return {
            promptFilled: true,
            referencesUploaded: false,
            optionsApplied: {
                modelApplied: false,
                ratioApplied: false,
                resolutionApplied: false,
                durationApplied: false,
            },
        };
    }

    editor = await firstVisible(page, config.editorSelectors, 5000);
    if (!editor) {
        return {
            promptFilled: false,
            referencesUploaded,
            optionsApplied: {
                modelApplied: false,
                ratioApplied: false,
                resolutionApplied: false,
                durationApplied: false,
            },
        };
    }
    if (!(await editorContainsPrompt(editor, task.prompt))) {
        await fillEditor(editor, task.prompt);
    }

    const optionsApplied = await applyProviderOptions(page, config, task);
    try {
        if (page.keyboard && await page.locator('[role="dialog"]').count()) {
            await page.keyboard.press('Escape');
        }
    } catch (_) {}

    return {
        promptFilled: await editorContainsPrompt(editor, task.prompt),
        referencesUploaded,
        optionsApplied,
    };
}

async function bodyText(page) {
    try {
        return await page.locator('body').innerText({ timeout: 3000 });
    } catch (_) {
        return '';
    }
}

async function inspectSelector(page, selectors) {
    for (const selector of selectors || []) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() < 1) continue;
            let visible = false;
            try {
                visible = await locator.isVisible();
            } catch (_) {}
            return { found: true, visible, selector };
        } catch (_) {}
    }
    return { found: false, visible: false, selector: null };
}

async function inspectSelectorList(page, selectors) {
    const items = [];
    for (const selector of selectors || []) {
        const status = await inspectSelector(page, [selector]);
        items.push(status);
    }
    return items;
}

async function clickProbeControl(page, status) {
    if (!status || !status.found || !status.selector) return false;
    try {
        await page.locator(status.selector).first().click();
        await page.waitForTimeout(250);
        return true;
    } catch (_) {
        return false;
    }
}

function selectorForLabel(selectors, label) {
    return (selectors || []).find((selector) => selector.includes(`"${label}"`)) || null;
}

async function inspectDuration(page, controls) {
    const textInput = await inspectSelector(page, [controls.durationTextSelector]);
    const rangeInput = await inspectSelector(page, [controls.durationRangeSelector]);
    const roleSlider = await inspectSelector(page, [controls.durationRoleSelector]);
    const source = roleSlider.found
        ? page.locator(roleSlider.selector).first()
        : rangeInput.found
        ? page.locator(rangeInput.selector).first()
        : (textInput.found ? page.locator(textInput.selector).first() : null);

    let value = null;
    let min = null;
    let max = null;
    let step = null;
    if (source) {
        try {
            const raw = roleSlider.found
                ? await source.getAttribute('aria-valuenow')
                : await source.inputValue();
            const offset = roleSlider.found
                ? Number(controls.durationValueOffset || 0)
                : 0;
            value = raw === '' || raw === null ? null : Number(raw) + offset;
        } catch (_) {}
        for (const [field, attribute] of [['min', 'min'], ['max', 'max'], ['step', 'step']]) {
            try {
                const actualAttribute = roleSlider.found
                    ? `aria-value${attribute}`
                    : attribute;
                const raw = await source.getAttribute(actualAttribute);
                if (raw !== null && raw !== '') {
                    const offset = roleSlider.found
                        ? Number(controls.durationValueOffset || 0)
                        : 0;
                    if (field === 'min') min = Number(raw) + offset;
                    if (field === 'max') max = Number(raw) + offset;
                    if (field === 'step') step = Number(raw);
                }
            } catch (_) {}
        }
        if (roleSlider.found && step === null) step = 1;
    }

    return {
        textInputFound: textInput.found,
        rangeInputFound: rangeInput.found,
        roleSliderFound: roleSlider.found,
        value,
        min,
        max,
        step,
    };
}

function inferAutoDuration(task, duration) {
    if (task.mediaType !== 'video' || task.durationMode !== 'auto') return null;

    const prompt = String(task.prompt || '').toLowerCase();
    let candidate = task.preferredDurationSeconds;
    if (!candidate) {
        if (/multi.?scene|montage|story|three ways|one day|转场|多场景|故事|三种穿法/.test(prompt)) {
            candidate = 12;
        } else if (/detail|macro|close.?up|texture|特写|细节|纹理|产品展示/.test(prompt)) {
            candidate = 8;
        } else {
            candidate = 10;
        }
    }

    if (duration.min !== null) candidate = Math.max(candidate, duration.min);
    if (duration.max !== null) candidate = Math.min(candidate, duration.max);
    if (duration.step && duration.min !== null) {
        candidate = duration.min + Math.round(
            (candidate - duration.min) / duration.step
        ) * duration.step;
    }
    return Math.max(1, Math.round(candidate));
}

async function probeProviderPage(page, config, task = {}) {
    const controls = config.probeControls || {};
    await page.goto(config.urlForTask(task), {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
    });
    await page.waitForTimeout(250);
    await activateTaskMode(page, config, task.mediaType);
    await firstVisible(page, config.editorSelectors, 15_000);

    const text = await bodyText(page);
    const state = detectPageState(text, config);
    const editor = await inspectSelector(page, config.editorSelectors);
    const uploadButton = await inspectSelector(page, controls.uploadButtonSelectors);
    const uploadInput = await inspectSelector(page, controls.uploadInputSelectors);
    const skillButton = await inspectSelector(page, controls.skillButtonSelectors);
    const modelButton = await inspectSelector(page, controls.modelButtonSelectors);
    const settingsButton = await inspectSelector(page, controls.settingsButtonSelectors);
    const generateButton = await inspectSelector(page, config.generateSelectors);

    let generateDisabled = null;
    if (generateButton.found) {
        try {
            generateDisabled = await page.locator(generateButton.selector).first().isDisabled();
        } catch (_) {}
    }

    let modelStatuses = await inspectSelectorList(page, controls.modelSelectors);
    if (!modelStatuses.some((item) => item.found)) {
        await clickProbeControl(page, modelButton.found ? modelButton : settingsButton);
        modelStatuses = await inspectSelectorList(page, controls.modelSelectors);
    }
    try { await page.keyboard.press('Escape'); } catch (_) {}
    let aspectRatioStatuses = await inspectSelectorList(page, controls.aspectRatioSelectors);
    if (!aspectRatioStatuses.some((item) => item.found)) {
        await clickProbeControl(page, settingsButton);
        aspectRatioStatuses = await inspectSelectorList(page, controls.aspectRatioSelectors);
    }
    const resolutionStatuses = await inspectSelectorList(page, controls.resolutionSelectors);

    const preferredModel = (config.freePreferredModels || [])[0] || null;
    const preferredSelector = preferredModel
        ? selectorForLabel(controls.modelSelectors, preferredModel)
        : null;
    const preferredStatus = modelStatuses.find(
        (item) => item.selector === preferredSelector
    );
    const freePreferredModel = preferredStatus || (preferredSelector
        ? await inspectSelector(page, [preferredSelector])
        : { found: false, visible: false, selector: null });

    const customDurationButton = await inspectSelector(
        page,
        controls.customDurationButtonSelectors
    );
    let duration = await inspectDuration(page, controls);
    if (
        !duration.textInputFound &&
        !duration.rangeInputFound &&
        !duration.roleSliderFound
    ) {
        await clickProbeControl(
            page,
            customDurationButton.found ? customDurationButton : settingsButton
        );
        duration = await inspectDuration(page, controls);
    }
    duration = {
        customButtonFound: customDurationButton.found,
        ...duration,
    };

    const controlsResult = {
        editor,
        uploadButton,
        uploadInput,
        skillButton,
        modelButton,
        settingsButton,
        generateButton: {
            ...generateButton,
            disabled: generateDisabled,
        },
        models: modelStatuses,
        freePreferredModel,
        aspectRatios: aspectRatioStatuses,
        resolutions: resolutionStatuses,
        duration,
    };
    const providerOptions = (
        task.providerOptions &&
        typeof task.providerOptions[config.key] === 'object'
    ) ? task.providerOptions[config.key] : {};
    const requirements = config.probeRequirements || {};
    const resolutionReady = requirements.resolution === false || (
        !providerOptions.resolution ||
        resolutionStatuses.some((item) => item.found)
    );
    const durationReady = (
        (requirements.customDurationButton === false || duration.customButtonFound) &&
        (requirements.durationText === false || duration.textInputFound) &&
        (requirements.durationRange === false || duration.rangeInputFound) &&
        (duration.textInputFound || duration.rangeInputFound || duration.roleSliderFound)
    );
    const videoControlsReady = task.mediaType !== 'video' || (
        freePreferredModel.found &&
        aspectRatioStatuses.some((item) => item.found) &&
        resolutionReady &&
        durationReady
    );
    const ready = state === 'ready' &&
        editor.found &&
        (requirements.uploadButton === false || uploadButton.found) &&
        uploadInput.found &&
        (requirements.skillButton === false || skillButton.found) &&
        settingsButton.found &&
        (requirements.generateButton === false || generateButton.found) &&
        videoControlsReady;

    // Probe menus are transient inspection state. Close them before a
    // prepare-only run reuses the same page to fill and upload content.
    try { await page.keyboard.press('Escape'); } catch (_) {}

    return {
        ok: ready,
        ready,
        submitted: false,
        state,
        provider: config.key,
        pageUrl: page.url(),
        controls: controlsResult,
    };
}

function candidatesOfType(candidates, mediaType) {
    const kind = mediaType === 'video' ? 'video' : 'image';
    return candidates.filter((item) => item.kind === kind);
}

async function tryDownloadButton(page, config, task, index) {
    const button = await firstVisible(page, config.downloadSelectors, 800);
    if (!button) return null;
    try {
        const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
        await button.click({ timeout: 1500 });
        const download = await downloadPromise;
        return await savePlaywrightDownload(download, {
            outputDir: task.outputDir,
            provider: config.key,
            mediaType: task.mediaType,
            index,
        });
    } catch (_) {
        return null;
    }
}

function isDurationUnavailable(task, optionState) {
    return (
        task.mediaType === 'video' &&
        Boolean(task.durationSeconds) &&
        !optionState.durationApplied &&
        !task.allowDefaultDuration
    );
}

function createBrowserMediaAdapter(config) {
    return {
        async generate(task, context = {}) {
            const page = await context.getPage(config, task);
            const timeoutMs = Number(context.timeoutMs || (
                task.mediaType === 'video' ? 15 * 60_000 : 5 * 60_000
            ));

            await page.goto(config.urlForTask(task), {
                waitUntil: 'domcontentloaded',
                timeout: Math.min(timeoutMs, 60_000),
            });
            await page.waitForTimeout(2500);

            let text = await bodyText(page);
            let state = detectPageState(text, config);
            if (state === 'quota' || state === 'auth' || state === 'safety') {
                return { ok: false, reason: state };
            }

            await activateTaskMode(page, config, task.mediaType);

            const before = new Set(
                candidatesOfType(await collectMediaCandidates(page), task.mediaType)
                    .map((item) => item.src)
            );

            const staged = await stageProviderTask(page, config, task);
            if (!staged.referencesUploaded) {
                return { ok: false, reason: 'upload', error: 'No usable image upload input found' };
            }
            if (!staged.promptFilled) {
                return { ok: false, reason: 'editor', error: 'Prompt editor not found or prompt was not retained' };
            }
            if (isDurationUnavailable(task, staged.optionsApplied)) {
                return {
                    ok: false,
                    reason: 'duration_unavailable',
                    error: `Requested ${task.durationSeconds}s, but the provider duration control was not applied; current page default is unknown`,
                };
            }

            const generate = await firstVisible(page, config.generateSelectors, 3000);
            if (!generate) return { ok: false, reason: 'generate_button', error: 'Generate button not found' };
            await generate.click();

            const deadline = Date.now() + timeoutMs;
            let lastCandidates = [];

            while (Date.now() < deadline) {
                await page.waitForTimeout(3000);
                text = await bodyText(page);
                state = detectPageState(text, config);
                if (state === 'quota' || state === 'auth' || state === 'safety' || state === 'generation') {
                    return {
                        ok: false,
                        reason: state,
                        error: text.slice(-500),
                        actualDurationSeconds: extractDurationSeconds(text),
                    };
                }

                const current = candidatesOfType(
                    await collectMediaCandidates(page),
                    task.mediaType
                ).filter((item) => !before.has(item.src));
                if (current.length) lastCandidates = current;

                if (lastCandidates.length >= task.count && state !== 'processing') break;
            }

            const artifacts = [];
            for (let i = 0; i < lastCandidates.slice(0, task.count).length; i++) {
                try {
                    artifacts.push(await saveMediaCandidate(page, lastCandidates[i], {
                        outputDir: task.outputDir,
                        provider: config.key,
                        mediaType: task.mediaType,
                        index: i + 1,
                    }));
                } catch (_) {}
            }

            if (!artifacts.length) {
                const clicked = await tryDownloadButton(page, config, task, 1);
                if (clicked) artifacts.push(clicked);
            }

            if (!artifacts.length) {
                return {
                    ok: false,
                    reason: Date.now() >= deadline ? 'timeout' : 'artifact',
                    error: 'Generation completed but no downloadable artifact was captured',
                };
            }

            return {
                ok: true,
                artifacts,
                pageUrl: page.url(),
                actualDurationSeconds: extractDurationSeconds(text),
                requestedDurationSeconds: task.durationSeconds,
            };
        },
    };
}

module.exports = {
    detectPageState,
    extractDurationSeconds,
    normalizeMediaCandidates,
    collectMediaCandidates,
    probeProviderPage,
    uploadReferences,
    applyProviderOptions,
    stageProviderTask,
    isDurationUnavailable,
    createBrowserMediaAdapter,
    classifyProviderFailure,
};
