'use strict';

const path = require('path');

const DEFAULT_PROVIDERS = {
    video: ['jimeng', 'xiaoyunque', 'doubao'],
    image: ['chatgpt', 'doubao', 'jimeng', 'xiaoyunque'],
};

function normalizeMediaTask(input = {}) {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw new Error('prompt is required');

    const mediaType = String(input.mediaType || 'video').toLowerCase();
    if (!['video', 'image'].includes(mediaType)) {
        throw new Error('mediaType must be "video" or "image"');
    }

    const providers = Array.isArray(input.providers) && input.providers.length
        ? input.providers.map((v) => String(v).toLowerCase())
        : [...DEFAULT_PROVIDERS[mediaType]];

    const referenceImages = (input.referenceImages || input.imagePaths || [])
        .map((v) => path.resolve(String(v)));
    const metadata = input.metadata && typeof input.metadata === 'object'
        ? input.metadata
        : {};
    const explicitDuration = mediaType === 'video' && input.durationSeconds != null;

    return {
        prompt,
        mediaType,
        providers,
        referenceImages,
        aspectRatio: String(input.aspectRatio || '9:16'),
        // Duration is explicit only when the user/creative plan supplied it.
        // Otherwise the executor selects a suitable duration from the live
        // provider controls and current free-model limits.
        durationSeconds: explicitDuration
            ? Math.max(1, Number(input.durationSeconds))
            : null,
        durationMode: mediaType === 'video'
            ? (explicitDuration ? 'explicit' : 'auto')
            : 'none',
        preferredDurationSeconds: mediaType === 'video' && (
            input.preferredDurationSeconds != null ||
            metadata.recommendedDurationSeconds != null
        )
            ? Math.max(1, Number(
                input.preferredDurationSeconds ??
                metadata.recommendedDurationSeconds
            ))
            : null,
        allowDefaultDuration: input.allowDefaultDuration === true,
        count: Math.max(1, Math.min(4, Number(input.count || 1))),
        outputDir: path.resolve(String(input.outputDir || path.join(process.cwd(), 'outputs', 'media'))),
        providerOptions: input.providerOptions && typeof input.providerOptions === 'object'
            ? input.providerOptions
            : {},
        metadata,
    };
}

module.exports = { normalizeMediaTask, DEFAULT_PROVIDERS };
