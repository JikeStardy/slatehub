#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK_DIR="${SLATEHUB_ZFULL_FONT_WORK_DIR:-/private/tmp/slatehub-zfull-font-test}"
OUT_DIR="$ROOT/backend/assets/fonts/bitmap-1bpp"
ZFULL_TTF="${ZFULL_TTF:-$ROOT/backend/assets/fonts/vector/Zfull-GB.ttf}"
ZFULL_SIZES="${ZFULL_SIZES:-10 12 14 16 18}"
LV_FONT_CONV_BIN="$(command -v lv_font_conv || true)"

mkdir -p "$WORK_DIR" "$OUT_DIR"

usage() {
  printf '%s\n' \
    "usage: backend/scripts/fonts/generate-zfull-font-assets.sh [--help]" \
    "" \
    "Generates backend 1bpp Zfull-GB JSON fonts." \
    "Environment:" \
    "  ZFULL_TTF      source TTF path, defaults to backend/assets/fonts/vector/Zfull-GB.ttf" \
    "  ZFULL_SIZES    space-separated sizes, defaults to: 10 12 14 16 18"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing command: $1" >&2
    exit 1
  }
}

case "${1:-}" in
  "")
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    echo "unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac

generate_zfull_gb_symbols() {
  python3 - <<'PY'
import sys

BASE_SYMBOLS = (
    r""" !"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\]^_`abcdefghijklmnopqrstuvwxyz{|}~"""
    "，。！？：；、（）《》【】“”‘’—…·"
    "☀☁☂☃⚡❄"
    "¥€£₿¢"
    "←↑→↓↖↗↘↙↔↕➜➝➞➤"
    "℃℉°‰"
    "±×÷≈≠≤≥∞√"
    "～–「」『』〈〉〔〕〖〗"
    "©®™§¶"
)

hanzi = []
for lead in range(0xB0, 0xF8):
    for trail in range(0xA1, 0xFF):
        try:
            hanzi.append(bytes((lead, trail)).decode("gb2312"))
        except UnicodeDecodeError:
            pass

if len(hanzi) != 6763:
    raise SystemExit(f"expected 6763 GB2312 Hanzi, got {len(hanzi)}")

sys.stdout.write(BASE_SYMBOLS + "".join(hanzi))
PY
}

need bun
need node
need python3
need lv_font_conv

if [[ ! -f "$ZFULL_TTF" ]]; then
  echo "missing Zfull font: $ZFULL_TTF" >&2
  echo "copy Zfull-GB.ttf to backend/assets/fonts/vector/ or set ZFULL_TTF" >&2
  exit 1
fi

symbols="$(generate_zfull_gb_symbols)"

for size in $ZFULL_SIZES; do
  if [[ ! "$size" =~ ^[0-9]+$ ]]; then
    echo "invalid Zfull size: $size" >&2
    exit 1
  fi

  c_file="$WORK_DIR/zfull-gb-$size.c"
  out="$OUT_DIR/zfull-gb-$size.json"
  echo "generating $out"
  node --stack-size=65500 "$LV_FONT_CONV_BIN" \
    --no-compress \
    --bpp 1 \
    --size "$size" \
    --font "$ZFULL_TTF" \
    --autohint-off \
    --symbols "$symbols" \
    --format lvgl \
    -o "$c_file" \
    --lv-font-name "ZfullGB_$size"
  bun "$ROOT/backend/scripts/fonts/extract-lvgl-font.ts" "$c_file" "$out"
done
