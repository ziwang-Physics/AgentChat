#!/usr/bin/env bash
# md2pdf.sh — Markdown → (pandoc) → Typst → PDF，含 pandoc/typst 兼容 shim
#
# 解决的已知不兼容（Issue 5）：
#   * pandoc 对 `---` 输出 `#horizontalrule`，非 standalone 输出缺定义
#     → Typst: "unknown variable: horizontalrule"
#   * Typst 0.11+ 页码 counter(page).display() 必须包裹于 context，
#     pandoc 不生成 → shim 模板 footer 已内置 context
#   * 目录函数是 #outline()，不存在 #table.of_contents()
#
# 用法:
#   bash md2pdf.sh solutions.md output.pdf ["页眉标题（默认 Solutions）"]
#
# 可通过环境变量覆盖:
#   TYPST_BIN   typst 可执行文件（默认: PATH 中的 typst，回退 ~/.local/bin/typst）
#   PANDOC_BIN  pandoc 可执行文件（默认: pandoc）

set -euo pipefail

md="${1:?usage: md2pdf.sh <input.md> <output.pdf> [header-title]}"
pdf="${2:?usage: md2pdf.sh <input.md> <output.pdf> [header-title]}"
header_title="${3:-Solutions}"

PANDOC_BIN="${PANDOC_BIN:-pandoc}"
if [[ -n "${TYPST_BIN:-}" ]]; then
  :
elif command -v typst >/dev/null 2>&1; then
  TYPST_BIN=typst
elif [[ -x "$HOME/.local/bin/typst" ]]; then
  TYPST_BIN="$HOME/.local/bin/typst"
else
  echo "[md2pdf] FATAL: typst not found (PATH / ~/.local/bin/typst / \$TYPST_BIN)" >&2
  exit 3
fi

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
body="$workdir/body.typ"
typ="$workdir/doc.typ"

# 1) pandoc: markdown (+LaTeX math) → typst body（非 standalone，模板由 shim 提供）
"$PANDOC_BIN" "$md" -f markdown -t typst -o "$body"

# 2) shim + 页面模板（与 SKILL.md《Typst 模板规范》同源）
{
  cat <<SHIM
// ── pandoc→typst 兼容 shim（自动注入，勿手改编译产物）─────────────
// pandoc 非 standalone 输出引用 #horizontalrule 但不定义它
#let horizontalrule = align(center, line(length: 100%, stroke: 0.4pt + gray))

#set page(
  paper: "a4",
  margin: (x: 2cm, y: 2.5cm),
  header: align(right, text(size: 7pt, fill: gray)[${header_title}]),
  // Typst 0.11+: counter(...).display() 必须处于 context
  footer: context align(center, text(size: 7pt, fill: gray)[#counter(page).display()]),
)
#set text(font: ("Libertinus Serif", "Noto Sans CJK SC"), size: 10.5pt, lang: "en")
#set par(justify: true, leading: 0.65em)
#set heading(numbering: none)

#outline(title: [目录], indent: auto)
#pagebreak()
// ── shim end ──────────────────────────────────────────────────────
SHIM
  cat "$body"
} > "$typ"

# 3) compile（--root 指向临时目录即可；无外部资源依赖）
"$TYPST_BIN" compile "$typ" "$pdf"
echo "[md2pdf] OK → $pdf" >&2