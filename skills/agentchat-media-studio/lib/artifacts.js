'use strict';

const fs = require('fs');
const path = require('path');

const MIME_EXTENSIONS = {
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

function extensionForMime(mimeType, url = '') {
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
    try {
        const ext = path.extname(new URL(url).pathname).replace(/^\./, '').toLowerCase();
        if (/^(?:mp4|mov|webm|png|jpe?g|webp|gif)$/.test(ext)) {
            return ext === 'jpeg' ? 'jpg' : ext;
        }
    } catch (_) {}
    return mime.startsWith('video/') ? 'mp4' : 'png';
}

function makeArtifactFilename({
    provider,
    mediaType,
    index = 1,
    mimeType,
    url,
    timestamp = new Date(),
}) {
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = [
        timestamp.getUTCFullYear(),
        pad(timestamp.getUTCMonth() + 1),
        pad(timestamp.getUTCDate()),
    ].join('') + '-' + [
        pad(timestamp.getUTCHours()),
        pad(timestamp.getUTCMinutes()),
        pad(timestamp.getUTCSeconds()),
    ].join('');
    const ext = extensionForMime(mimeType, url);
    return `${provider}-${mediaType}-${stamp}-${pad(index)}.${ext}`;
}

async function ensureOutputDir(outputDir) {
    await fs.promises.mkdir(outputDir, { recursive: true });
}

function decodeDataUrl(value) {
    const match = String(value || '').match(/^data:([^;,]+)?(?:;base64)?,(.*)$/s);
    if (!match) return null;
    const mimeType = match[1] || 'application/octet-stream';
    const payload = match[2] || '';
    return {
        mimeType,
        bytes: Buffer.from(payload, ';base64,'.includes(';base64,') ? 'base64' : 'utf8'),
    };
}

async function fetchCandidateBytes(page, src) {
    if (/^data:/i.test(src)) {
        const comma = src.indexOf(',');
        const header = src.slice(0, comma);
        const payload = src.slice(comma + 1);
        const mimeType = (header.match(/^data:([^;,]+)/i) || [])[1] || 'application/octet-stream';
        return {
            bytes: Buffer.from(payload, /;base64/i.test(header) ? 'base64' : 'utf8'),
            mimeType,
        };
    }

    const inPage = await page.evaluate(async (url) => {
        try {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) return null;
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < bytes.length; i += chunk) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
            }
            return {
                base64: btoa(binary),
                mimeType: blob.type || response.headers.get('content-type') || '',
            };
        } catch (_) {
            return null;
        }
    }, src).catch(() => null);

    if (inPage && inPage.base64) {
        return {
            bytes: Buffer.from(inPage.base64, 'base64'),
            mimeType: inPage.mimeType,
        };
    }

    if (/^https?:/i.test(src)) {
        const response = await page.context().request.get(src, { timeout: 60_000 });
        if (response.ok()) {
            return {
                bytes: await response.body(),
                mimeType: response.headers()['content-type'] || '',
            };
        }
    }
    throw new Error('Unable to fetch generated artifact');
}

async function saveMediaCandidate(page, candidate, options) {
    await ensureOutputDir(options.outputDir);
    const fetched = await fetchCandidateBytes(page, candidate.src);
    const filename = makeArtifactFilename({
        ...options,
        mimeType: fetched.mimeType,
        url: candidate.src,
    });
    const outputPath = path.join(options.outputDir, filename);
    await fs.promises.writeFile(outputPath, fetched.bytes);
    return {
        path: outputPath,
        filename,
        mimeType: fetched.mimeType,
        bytes: fetched.bytes.length,
        source: candidate.src,
    };
}

async function savePlaywrightDownload(download, options) {
    await ensureOutputDir(options.outputDir);
    const suggested = download.suggestedFilename();
    const mimeGuess = options.mediaType === 'video' ? 'video/mp4' : 'image/png';
    const ext = path.extname(suggested || '');
    const filename = ext
        ? makeArtifactFilename({ ...options, mimeType: '', url: suggested })
        : makeArtifactFilename({ ...options, mimeType: mimeGuess });
    const outputPath = path.join(options.outputDir, filename);
    await download.saveAs(outputPath);
    const stat = await fs.promises.stat(outputPath);
    return {
        path: outputPath,
        filename,
        mimeType: mimeGuess,
        bytes: stat.size,
        source: 'browser-download',
    };
}

module.exports = {
    extensionForMime,
    makeArtifactFilename,
    saveMediaCandidate,
    savePlaywrightDownload,
    fetchCandidateBytes,
    decodeDataUrl,
};
