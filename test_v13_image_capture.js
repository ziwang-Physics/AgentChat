#!/usr/bin/env node
/**
 * test_v13_image_capture.js — functional assertions for the v13 patch
 * (ChatGPT generated images silently dropped by innerText extraction):
 *
 *   L1  extractResponse: <img> in the response DOM → markdown image ref
 *       appended to the returned text (incl. the exact reported DOM shape:
 *       img is a SIBLING of the text container, via imageScopeSelector).
 *   L1b pure-image response (no prose ≥ minResponseLength) survives instead
 *       of dying as "Response too short or empty".
 *   L1c avatar/icon (<64px) and blob:/data: srcs are filtered.
 *   L1d echo-guard semantics unchanged: user-bubble echo → null even with imgs.
 *   L2  extractImageUrls picks up the appended markdown for an
 *       EXTENSIONLESS estuary-style URL.
 *   L4  downloadAllImages browser-first: session-gated endpoint (403 to a
 *       cookieless GET, 200 via mocked page.request) downloads through the
 *       browser session, and the .png default extension is corrected from
 *       payload sniffing (webp case). Real local HTTP server proves the
 *       cookieless path really would have failed.
 *   L4b sniffImageExt rejects HTML-error-as-200 payloads.
 *   L4c no page available → plain direct download still works (public CDN).
 *   Wiring: tryAllProviders result carries `page`; main() forwards it.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { extractResponse } = require('./skills/lib/providerFactory');
const {
    extractImageUrls, downloadAllImages, sniffImageExt,
} = require('./skills/AgentChat-OneWeb/index.js');

let passed = 0, total = 0;
function ok(name, fn) {
    total++;
    return Promise.resolve().then(fn).then(
        () => { console.log(`  ✓ ${name}`); passed++; },
        (e) => { console.error(`  ✗ ${name}\n    ${e && e.stack || e}`); process.exitCode = 1; }
    );
}

// ── DOM mock: enough of the Element surface for collectResponseImages ───────
function el(tag, { text = '', imgs = [], closestMap = {} } = {}) {
    return {
        tagName: tag,
        innerText: text,
        textContent: text,
        querySelectorAll: (sel) => (sel === 'img' ? imgs : []),
        closest: (sel) => closestMap[sel] || null,
        getBoundingClientRect: () => ({ width: 0, height: 0 }),
    };
}
function img({ src, alt = '', w = 1536, h = 1024 }) {
    return {
        tagName: 'IMG', currentSrc: src, src, alt,
        naturalWidth: w, naturalHeight: h,
        getBoundingClientRect: () => ({ width: w, height: h }),
    };
}
// Locator mock: evaluate(fn, args) runs fn against a chosen DOM node.
function mockResponseEl(node) {
    return { evaluate: async (fn, args) => fn(node, args) };
}
const PAGE_NOOP = {}; // extractResponse's page param is only used by hooks

const ESTUARY = 'https://chatgpt.com/backend-api/estuary/content?id=file_00001234abcd&ts=489';
const QUOTA_TEXT = '你目前的图片生成次数已用完。升级套餐以继续生成更多图片。';

function baseC(extra = {}) {
    return {
        key: 'chatgpt', minResponseLength: 5,
        captureImages: true, imageMinPx: 64, imageScopeSelector: null,
        ...extra,
    };
}

(async () => {
console.log('v13 image-capture functional tests');

// L1 ─ the reported failure shape: img is a SIBLING of the text container
await ok('L1: sibling <img> captured via imageScopeSelector, quota text preserved', async () => {
    const turn = el('DIV', { imgs: [img({ src: ESTUARY, alt: '已生成图片' })] });
    const markdownDiv = el('DIV', {
        text: QUOTA_TEXT,
        imgs: [], // .markdown itself contains NO img — the old code's blind spot
        closestMap: { '[data-message-author-role="assistant"]': turn },
    });
    const out = await extractResponse(
        PAGE_NOOP, mockResponseEl(markdownDiv),
        baseC({ imageScopeSelector: '[data-message-author-role="assistant"]' }),
        '为多供应商自动降级流程生成一张精简机制图'
    );
    assert(out, 'must not be null');
    assert(out.includes(QUOTA_TEXT), 'quota text preserved');
    assert(out.includes(`](${ESTUARY})`), 'estuary URL appended as markdown image');
    assert(/!\[已生成图片 1536x1024\]/.test(out), 'alt + dimensions in the label');
});

// L1b ─ pure-image response survives the length gate
await ok('L1b: image-only response (empty text) no longer dies as "too short"', async () => {
    const node = el('DIV', { text: '', imgs: [img({ src: ESTUARY })] });
    const out = await extractResponse(PAGE_NOOP, mockResponseEl(node), baseC(), 'draw me a diagram of the pipeline');
    assert(out && out.includes(ESTUARY));
    assert(/generated-image-1/.test(out), 'fallback label used when alt empty');
});

// L1c ─ noise filters
await ok('L1c: avatars (<64px) and blob:/data: srcs are filtered out', async () => {
    const node = el('DIV', {
        text: 'Here is your generated architecture diagram, as requested by you.',
        imgs: [
            img({ src: 'https://cdn.example.com/avatar.png', w: 32, h: 32 }),
            { tagName: 'IMG', currentSrc: 'blob:https://chatgpt.com/deadbeef', src: 'blob:https://chatgpt.com/deadbeef',
              alt: '', naturalWidth: 1024, naturalHeight: 1024, getBoundingClientRect: () => ({ width: 1024, height: 1024 }) },
            img({ src: ESTUARY }),
        ],
    });
    const out = await extractResponse(PAGE_NOOP, mockResponseEl(node), baseC(), 'ignore');
    assert(out.includes(ESTUARY), 'real image kept');
    assert(!out.includes('avatar.png'), 'avatar filtered by size');
    assert(!out.includes('blob:'), 'blob: src not emitted as a (dead) markdown URL');
});

// L1d ─ echo guard unchanged
await ok('L1d: user-bubble echo still returns null even when it contains an <img>', async () => {
    const prompt = '请帮我画一张系统架构图，包含所有八个供应商的降级链路和 CDP 桥接层';
    const node = el('DIV', { text: prompt, imgs: [img({ src: 'https://u.example.com/upload.png' })] });
    const out = await extractResponse(PAGE_NOOP, mockResponseEl(node), baseC(), prompt);
    assert.strictEqual(out, null, 'echoed prompt must stay rejected — its images are user uploads');
});

// L2 ─ downstream regex pickup for extensionless URLs
await ok('L2: extractImageUrls finds the appended markdown ref (extensionless URL)', () => {
    const response = `${QUOTA_TEXT}\n\n![已生成图片 1536x1024](${ESTUARY})`;
    const urls = extractImageUrls(response);
    assert.deepStrictEqual(urls, [ESTUARY]);
});

// L4b ─ payload sniffing
await ok('L4b: sniffImageExt — magic bytes + content-type, rejects HTML-as-200', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]);
    const html = Buffer.from('<!DOCTYPE html><html><body>Please log in</body></html>');
    assert.strictEqual(sniffImageExt(png, ''), 'png');
    assert.strictEqual(sniffImageExt(webp, ''), 'webp');
    assert.strictEqual(sniffImageExt(Buffer.alloc(32), 'image/jpeg'), 'jpg');
    assert.strictEqual(sniffImageExt(html, 'text/html'), null);
    assert.strictEqual(sniffImageExt(html, ''), null);
});

// ── L4: real local HTTP server simulating the session-gated endpoint ────────
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([64, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 9)]);
const server = http.createServer((req, res) => {
    if (req.url.startsWith('/gated')) {
        if (req.headers.cookie && req.headers.cookie.includes('session=ok')) {
            res.writeHead(200, { 'content-type': 'image/webp' });
            return res.end(WEBP);
        }
        res.writeHead(403, { 'content-type': 'text/html' });
        return res.end('<!DOCTYPE html><html>403 Forbidden</html>');
    }
    if (req.url.startsWith('/public.png')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(PNG);
    }
    res.writeHead(404); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const GATED_URL = `http://127.0.0.1:${PORT}/gated/estuary/content?id=file_x`; // extensionless
const PUBLIC_URL = `http://127.0.0.1:${PORT}/public.png`;

// Mocked Playwright page whose request context injects the session cookie
function mockSessionPage() {
    return {
        isClosed: () => false,
        request: {
            get: (url) => new Promise((resolve, reject) => {
                const req = http.get(url, { headers: { cookie: 'session=ok' } }, (res) => {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => resolve({
                        ok: () => res.statusCode >= 200 && res.statusCode < 300,
                        headers: () => res.headers,
                        body: async () => Buffer.concat(chunks),
                    }));
                });
                req.on('error', reject);
            }),
        },
        evaluate: async () => { throw new Error('tier 2 should not be reached in this test'); },
    };
}

await ok('L4: session-gated image → 403 direct, but browser-first path downloads it and fixes ext to .webp', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-'));
    // Prove the counterfactual: without the page, the old path fails with 403.
    const plain = await downloadAllImages(`![img](${GATED_URL})`, dir, {});
    assert.strictEqual(plain.downloaded.length, 0, 'cookieless download must fail (HTTP 403)');
    assert(/HTTP 403/.test(plain.response), 'failure surfaced in summary');
    // The fix: browser-session download succeeds.
    const r = await downloadAllImages(`![已生成图片 1536x1024](${GATED_URL})`, dir, { page: mockSessionPage() });
    assert.strictEqual(r.downloaded.length, 1, 'browser-first download must succeed');
    assert(r.downloaded[0].file.endsWith('.webp'), `ext fixed from payload, got ${r.downloaded[0].file}`);
    assert.strictEqual(r.downloaded[0].via, 'browser-session');
    const written = fs.readFileSync(r.downloaded[0].path);
    assert(written.equals(WEBP), 'bytes intact');
    assert(r.response.includes('✅'), 'success summary appended');
});

await ok('L4c: no page → plain direct download unchanged for public URLs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-'));
    const r = await downloadAllImages(`![pub](${PUBLIC_URL})`, dir, {});
    assert.strictEqual(r.downloaded.length, 1);
    assert(r.downloaded[0].file.endsWith('.png'));
    assert(fs.readFileSync(r.downloaded[0].path).equals(PNG));
});

server.close();

// Wiring ─ source-level
await ok('wiring: tryAllProviders returns page; main() forwards it to downloadAllImages', () => {
    const src = fs.readFileSync(path.join(__dirname, 'skills/AgentChat-OneWeb/index.js'), 'utf8');
    assert(/provider:\s*provider\.name,\s*page\s*}/.test(src), 'success result carries page');
    assert(/downloadAllImages\(result\.response,\s*process\.cwd\(\),\s*\{\s*page:\s*result\.page\s*\}\)/.test(src), 'main passes result.page');
    const cg = fs.readFileSync(path.join(__dirname, 'skills/lib/providers/adapters/chatgpt.js'), 'utf8');
    assert(/imageScopeSelector:\s*'\[data-message-author-role="assistant"\]'/.test(cg), 'chatgpt adapter widens image scope');
});

console.log(`\n${passed}/${total} assertion groups passed`);
})();
