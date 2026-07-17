/**
 * LaTeX-preserving DOM text extraction for Web AI responses.
 *
 * PROBLEM: `el.innerText` on KaTeX/MathJax-rendered formulas produces garbled,
 * character-by-character line-broken text because the rendering uses hundreds
 * of absolutely-positioned <span> elements.
 *
 * SOLUTION: Before calling innerText, walk the cloned DOM and replace every
 * KaTeX/MathJax node with its original LaTeX source text (delimited with $ or
 * $$ markers), extracted from the hidden <annotation> or <script> tags that
 * both renderers embed for a11y/copy-paste purposes.
 *
 * Usage in Playwright evaluate:
 *   const text = await handle.evaluate(el => { LATEX_AWARE_EXTRACT_BODY });
 */

// Standalone function body — drop into any page.evaluate(el => { ... })
// The variable `el` must be the DOM element to extract text from.
const LATEX_AWARE_EXTRACT_BODY = `
  const clone = el.cloneNode(true);

  // ── 1. KaTeX (used by ChatGPT, Kimi, Qwen, MiniMax, DeepSeek) ──
  clone.querySelectorAll('.katex').forEach(node => {
    const annotation = node.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation) {
      const tex = annotation.textContent.trim();
      const isBlock = node.closest('.katex-display') !== null;
      node.replaceWith(document.createTextNode(
        isBlock ? '\\n$$' + tex + '$$\\n' : '$' + tex + '$'
      ));
      return;
    }
    const mathml = node.querySelector('.katex-mathml');
    if (mathml) node.replaceWith(document.createTextNode(mathml.textContent || ''));
  });

  // ── 2. MathJax ──
  clone.querySelectorAll('mjx-container').forEach(node => {
    const tex = node.getAttribute('data-tex') || node.getAttribute('jax');
    if (tex) {
      const isBlock = node.hasAttribute('display') && node.getAttribute('display') === 'true';
      node.replaceWith(document.createTextNode(
        isBlock ? '\\n$$' + tex + '$$\\n' : '$' + tex + '$'
      ));
      return;
    }
    const script = node.querySelector('script[type^="math/"]');
    if (script) {
      const isBlock = script.type && script.type.includes('mode=display');
      node.replaceWith(document.createTextNode(
        isBlock ? '\\n$$' + script.textContent.trim() + '$$\\n' : '$' + script.textContent.trim() + '$'
      ));
      return;
    }
    node.replaceWith(document.createTextNode(node.textContent || ''));
  });

  // ── 3. Gemini-specific math markers ──
  clone.querySelectorAll('[data-math-type], .math-inline, .math-block').forEach(node => {
    const tex = node.getAttribute('data-math') || node.getAttribute('data-tex') || '';
    if (tex) {
      const isBlock = node.classList.contains('math-block') ||
                      (node.getAttribute('data-math-type') === 'block');
      node.replaceWith(document.createTextNode(
        isBlock ? '\\n$$' + tex + '$$\\n' : '$' + tex + '$'
      ));
    }
  });

  // ── 4. Return clean text (no leading/trailing whitespace) ──
  return (clone.innerText || clone.textContent || '').replace(/^\\s+|\\s+$/g, '');
`;

module.exports = { LATEX_AWARE_EXTRACT_BODY };
