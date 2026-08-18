'use strict';

function buildExecutionPlan(task, getProviderConfig) {
    const inputMode = task.referenceImages.length
        ? (task.mediaType === 'video' ? 'image-to-video' : 'image-reference')
        : `text-to-${task.mediaType}`;

    const routes = task.providers.map((provider) => {
        const config = getProviderConfig(provider);
        const supported = !!(config && config.supports && config.supports[task.mediaType]);
        return {
            provider,
            supported,
            url: supported ? config.urlForTask(task) : null,
            inputMode,
        };
    });

    return {
        mediaType: task.mediaType,
        inputMode,
        aspectRatio: task.aspectRatio,
        durationSeconds: task.durationSeconds,
        count: task.count,
        outputDir: task.outputDir,
        routes,
    };
}

module.exports = { buildExecutionPlan };
