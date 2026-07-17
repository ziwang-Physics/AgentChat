#!/usr/bin/env python3
"""
LaTeX → SVG math renderer for WeasyPrint PDF generation.

Converts $...$ (inline) and $$...$$ (display) LaTeX math to SVG images
embedded as base64 data URIs. Designed for use in the AgentChat-IndependentTasks
PDF pipeline where WeasyPrint cannot execute JavaScript (no MathJax/KaTeX).

Dependencies: matplotlib (mathtext — no texlive required)
Usage:
    python3 math_render.py < input.md > output.html
    python3 math_render.py --inline "E = mc^2"

The script reads Markdown/HTML with LaTeX delimiters and outputs HTML with
formulas replaced by <img> tags containing base64-encoded SVG data URIs.
"""

import re
import sys
import base64
import io
import html as html_mod
from typing import Tuple, Optional

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import mathtext

# ── Configuration ──
DPI = 150                    # Render resolution
FONT_SIZE = 11               # Base font size for inline math
DISPLAY_FONT_SIZE = 13       # Base font size for display math
PAD_INLINE = 3               # Padding pixels for inline formulas
PAD_DISPLAY = 6              # Padding pixels for display formulas
COLOR = '#111827'            # Text color (matches PDF body color)
BG_COLOR = 'none'            # Transparent background

# ═════════════════════════════════════════════════════════════════════════════
# LaTeX → SVG rendering
# ═════════════════════════════════════════════════════════════════════════════

def latex_to_svg(latex: str, display_mode: bool = False) -> Optional[str]:
    """
    Render a LaTeX string to an SVG image (base64 data URI).

    Args:
        latex: LaTeX math expression (without $ delimiters)
        display_mode: True for block-style, False for inline

    Returns:
        'data:image/svg+xml;base64,...' or None on failure
    """
    if not latex or not latex.strip():
        return None

    tex = latex.strip()
    font_size = DISPLAY_FONT_SIZE if display_mode else FONT_SIZE
    pad = PAD_DISPLAY if display_mode else PAD_INLINE

    try:
        # Create figure with tight bounding box
        fig, ax = plt.subplots(figsize=(0.01, 0.01), dpi=DPI)
        ax.axis('off')
        fig.patch.set_visible(False)

        # Use mathtext to render
        # Remove common LaTeX commands mathtext doesn't understand
        tex_clean = _sanitize_for_mathtext(tex)

        # Measure and render
        renderer = fig.canvas.get_renderer()
        try:
            text_obj = ax.text(0, 0, f'${tex_clean}$', fontsize=font_size,
                              color=COLOR, usetex=False,
                              math_fontfamily='stix')
        except Exception:
            # Fallback: try without math mode
            text_obj = ax.text(0, 0, tex_clean, fontsize=font_size,
                              color=COLOR)

        # Force draw to compute bounding box
        fig.canvas.draw()
        bbox = text_obj.get_window_extent(renderer=renderer)
        bbox = bbox.transformed(fig.dpi_scale_trans.inverted())

        # Close and recreate with correct size
        plt.close(fig)

        w, h = bbox.width * DPI, bbox.height * DPI
        fig, ax = plt.subplots(figsize=(w/DPI + pad*2/DPI, h/DPI + pad*2/DPI), dpi=DPI)
        ax.axis('off')
        fig.patch.set_visible(False)
        ax.set_xlim(0, w/DPI + pad*2/DPI)
        ax.set_ylim(0, h/DPI + pad*2/DPI)

        ax.text(pad/DPI, pad/DPI, f'${tex_clean}$', fontsize=font_size,
                color=COLOR, math_fontfamily='stix',
                verticalalignment='bottom')

        # Save to SVG bytes
        buf = io.BytesIO()
        fig.savefig(buf, format='svg', transparent=True, bbox_inches='tight',
                    pad_inches=0.02, dpi=DPI)
        plt.close(fig)
        buf.seek(0)
        svg_bytes = buf.read()

        # Encode as base64 data URI
        b64 = base64.b64encode(svg_bytes).decode('ascii')
        return f'data:image/svg+xml;base64,{b64}'

    except Exception as e:
        # Silently fall back — don't break the pipeline over one formula
        return None


def _sanitize_for_mathtext(tex: str) -> str:
    """
    Adapt LaTeX to matplotlib's mathtext syntax.

    mathtext supports a subset of LaTeX math mode. Common adjustments:
    - \\hbar, \\nabla, \\partial → keep (supported)
    - \\frac{a}{b} → \\frac{a}{b} (supported)
    - \\sum, \\int, \\prod → keep (supported)
    - \\left( ... \\right) → keep (supported)
    - \\vec, \\hat, \\tilde → keep (supported)
    - \\mathbf, \\mathcal, \\mathit → keep (supported)
    - \\text{...} → \\mathrm{...} (mathtext uses \\mathrm)
    - \\begin{cases} ... \\end{cases} → not supported; fallback to array-like
    - \\displaystyle → ignore
    - \\limits → remove (mathtext handles automatically)
    - ^ and _ without braces → add braces
    """
    tex = tex.strip()

    # Remove \displaystyle, \limits
    tex = re.sub(r'\\displaystyle\s*', '', tex)
    tex = re.sub(r'\\limits\s*', '', tex)

    # Convert \text{...} → \mathrm{...}
    tex = re.sub(r'\\text\{', r'\\mathrm{', tex)

    # Remove \tag{...}
    tex = re.sub(r'\\tag\{[^}]*\}', '', tex)

    # Remove \label{...}
    tex = re.sub(r'\\label\{[^}]*\}', '', tex)

    # Strip \boxed{...} → keep content only (mathtext doesn't support \boxed or \fbox)
    # Use a function to find matching brace for \boxed
    def strip_boxed(tex):
        result = []
        i = 0
        while i < len(tex):
            if tex[i:i+7] == r'\boxed{':
                # Find matching closing brace
                depth = 1
                j = i + 7
                while j < len(tex) and depth > 0:
                    if tex[j] == '{':
                        depth += 1
                    elif tex[j] == '}':
                        depth -= 1
                    j += 1
                # j points past the matching }
                # Extract inner content (between \boxed{ and matching })
                inner = tex[i+7:j-1]
                result.append(inner)
                i = j
            else:
                result.append(tex[i])
                i += 1
        return ''.join(result)
    tex = strip_boxed(tex)

    # Remove \quad, \qquad (mathtext spacing)
    tex = re.sub(r'\\qquad\s*', '    ', tex)
    tex = re.sub(r'\\quad\s*', '  ', tex)

    # Escape % signs
    tex = tex.replace('%', r'\%')

    return tex


# ═════════════════════════════════════════════════════════════════════════════
# HTML conversion (public interface)
# ═════════════════════════════════════════════════════════════════════════════

def math_to_html(text: str) -> str:
    """
    Convert text with $...$ and $$...$$ LaTeX delimiters to HTML with SVG images.

    Args:
        text: Input text containing LaTeX math delimiters

    Returns:
        HTML string with formulas replaced by <img> tags
    """
    # First pass: handle display math $$...$$
    def replace_display(match):
        tex = match.group(1).strip()
        svg_uri = latex_to_svg(tex, display_mode=True)
        if svg_uri:
            return (f'<div style="text-align:center;margin:16px 0;">'
                    f'<img src="{svg_uri}" style="max-width:100%;height:auto;" '
                    f'alt="{html_mod.escape(tex[:80])}"></div>')
        else:
            # Fallback: wrap in pre for readability
            return f'\n<pre style="text-align:center;font-family:monospace;">{html_mod.escape(tex)}</pre>\n'

    # Second pass: handle inline math $...$
    # Must avoid matching $$display$$ (already handled) and escaped \$
    def replace_inline(match):
        tex = match.group(1).strip()
        svg_uri = latex_to_svg(tex, display_mode=False)
        if svg_uri:
            return (f'<img src="{svg_uri}" '
                    f'style="height:1.2em;vertical-align:middle;display:inline-block;" '
                    f'alt="{html_mod.escape(tex[:40])}">')
        else:
            return f'<code>{html_mod.escape(tex)}</code>'

    # Process: $$ ... $$ first (non-greedy multi-line)
    text = re.sub(r'\$\$\s*(.+?)\s*\$\$', replace_display, text, flags=re.DOTALL)

    # Then: $ ... $ (single line, non-greedy)
    text = re.sub(r'(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)', replace_inline, text)

    return text


def clean_garbled_math(text: str) -> str:
    """
    Attempt to reconstruct garbled LaTeX from broken innerText extraction.

    This is a BEST-EFFORT heuristics pass for cases where the LaTeX-aware
    DOM extraction (latexExtract.js) wasn't applied or failed.

    Heuristics:
    - Detect Unicode math chars grouped with newlines (broken fractions)
    - Collapse single-character lines when surrounded by math symbols
    - Remove zero-width spaces (U+200B)

    Returns cleaned text.
    """
    # Remove zero-width spaces
    text = text.replace('​', '').replace('‌', '').replace('‍', '')
    text = text.replace('­', '')  # soft hyphen
    text = text.replace('﻿', '')  # BOM / ZWNBSP

    # Collapse isolated math symbols on their own lines back together.
    # Pattern: line containing ONLY math symbols → merge with neighbors
    math_symbols = set('ℎℏ∂∇∫∑∏√∞→∂ψΨ𝜑ϕ𝜃θ𝜆λ𝜇μ𝜋π𝜌ρ𝜎σ𝜏τ𝜐υ𝜙φ𝜒χ𝜓ψ𝜔ωΔΩαβγδεζηικλμνξπρστυφχψω')
    lines = text.split('\n')
    cleaned = []
    i = 0
    while i < len(lines):
        stripped = lines[i].strip()
        # If this line is short and math-heavy, it's likely a formula fragment
        if stripped and len(stripped) <= 3 and all(c in math_symbols or c in '^_}{[]()=+-*/.,;:!? \t' or c.isdigit() or c == '-' for c in stripped):
            # Try to merge with previous line if it ended without punctuation
            if cleaned and not cleaned[-1].rstrip().endswith(('.', '。', ':', '：', '?', '？', '!')):
                cleaned[-1] = cleaned[-1].rstrip() + ' ' + stripped
            elif i + 1 < len(lines) and lines[i + 1].strip():
                # Merge with next
                merged = stripped + ' ' + lines[i + 1].strip()
                cleaned.append(merged)
                i += 1
            else:
                cleaned.append(stripped)
        else:
            cleaned.append(stripped)
        i += 1

    return '\n'.join(cleaned)


# ═════════════════════════════════════════════════════════════════════════════
# CLI
# ═════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--inline':
        # Quick test: render a single formula
        tex = ' '.join(sys.argv[2:])
        svg = latex_to_svg(tex, 'display' in tex.lower())
        if svg:
            print(f'<img src="{svg[:80]}..." style="max-width:100%;height:auto;" alt="{html_mod.escape(tex[:40])}">')
        else:
            print(f'[render failed: {html_mod.escape(tex[:60])}]')
    elif len(sys.argv) > 1 and sys.argv[1] == '--test':
        # Test with common formulas
        tests = [
            (r'E = mc^2', False),
            (r'\frac{\hbar^2}{2\mu}\nabla^2\psi + V\psi = E\psi', True),
            (r'\sum_{i=1}^{n} l_i^2 = h', True),
            (r'g_J = 1 + \frac{J(J+1) + S(S+1) - L(L+1)}{2J(J+1)}', True),
            (r'^{2S+1}L_J', False),
            (r'\Gamma_{\mathrm{vib}} = 2A_1 + 2E', False),
        ]
        for tex, display in tests:
            mode = 'display' if display else 'inline'
            svg = latex_to_svg(tex, display)
            status = 'OK' if svg else 'FAIL'
            size = len(svg) if svg else 0
            print(f'[{status}] ({mode}) {tex[:50]:<50s} → {size} bytes SVG')
    else:
        # Pipe mode: read from stdin, output HTML
        input_text = sys.stdin.read()
        cleaned = clean_garbled_math(input_text)
        output = math_to_html(cleaned)
        sys.stdout.write(output)
