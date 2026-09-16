import { FRAME_HEIGHT, FRAME_WIDTH, type DashboardTemplateT } from 'shared';
import { BitmapCanvas, PIXEL_BLACK, PIXEL_WHITE } from './bitmap-canvas';
import {
  blockRect,
  resolveDashboardRenderInput,
  resolvePercentage,
  resolveSeries,
  resolveTemplate,
} from './dashboard-template';
import type { DynamicRenderContext } from './dynamic-render-context';
import { type FrameDrawKit } from './frame-draw-kit';
import {
  CONTENT_SAFE_BOTTOM,
  CONTENT_SAFE_TOP,
  CONTENT_WIDTH,
  STATUS_BAR_H,
} from './frame-renderer-layout';
import { type FontSet } from './fonts/dynamic-frame-font.service';
import { readAlign, readInt, pickText } from './helpers/frame-value-utils';
import { textWidthFallback } from './frame-text-layout';

export function renderDashboardFrame(
  c: BitmapCanvas,
  fonts: FontSet,
  ctx: DynamicRenderContext,
  draw: FrameDrawKit
): void {
  const resolved = resolveDashboardRenderInput(ctx);
  if (!resolved) {
    const centerY = Math.round((CONTENT_SAFE_TOP + CONTENT_SAFE_BOTTOM) / 2);
    draw.drawText(c, fonts.sans16, '等待外部数据', FRAME_WIDTH / 2, centerY - 20, {
      align: 'center',
      maxWidth: CONTENT_WIDTH,
    });
    draw.drawText(
      c,
      fonts.sans12,
      'POST /api/v2/contents/:id/data',
      FRAME_WIDTH / 2,
      centerY + 12,
      {
        align: 'center',
        maxWidth: CONTENT_WIDTH,
      }
    );
    return;
  }

  renderDashboardTemplate(c, fonts, resolved.template, resolved.data, draw);
}

function renderDashboardTemplate(
  c: BitmapCanvas,
  fonts: FontSet,
  template: DashboardTemplateT,
  dataRoot: Record<string, unknown>,
  draw: FrameDrawKit
): void {
  for (const rawBlock of template.blocks) {
    const type = rawBlock.type;
    if (type === 'text') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      const font = rawBlock.font_size === 12 ? fonts.sans12 : fonts.sans16;
      const color = rawBlock.color === 'white' ? PIXEL_WHITE : PIXEL_BLACK;
      const align = readAlign(rawBlock.align);
      const text = resolveTemplate(pickText(rawBlock.value, ''), dataRoot);
      const anchorX =
        align === 'center'
          ? rect.x + Math.round(rect.w / 2)
          : align === 'right'
            ? rect.x + rect.w
            : rect.x;
      draw.drawText(c, font, text, anchorX, rect.y, {
        align,
        maxWidth: rect.w,
        maxLines: readInt(rawBlock.max_lines, 1, 1, 4),
        ellipsis: true,
        color,
      });
    } else if (type === 'metric') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawMetricBlock(
        c,
        fonts,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolveTemplate(pickText(rawBlock.label, ''), dataRoot),
        resolveTemplate(pickText(rawBlock.value, ''), dataRoot),
        resolveSeries(rawBlock.sparkline, dataRoot),
        draw
      );
    } else if (type === 'progress') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      drawProgressBlock(
        c,
        fonts,
        rect.x,
        rect.y,
        rect.w,
        rect.h,
        resolveTemplate(pickText(rawBlock.label, ''), dataRoot),
        resolveTemplate(pickText(rawBlock.value_text, ''), dataRoot),
        resolvePercentage(rawBlock.percentage, rawBlock.value, rawBlock.max, dataRoot),
        rawBlock.label_font_size,
        rawBlock.value_font_size,
        rawBlock.bar_height,
        draw
      );
    } else if (type === 'sparkline') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      const series = resolveSeries(rawBlock.values, dataRoot);
      if (series.length >= 2) draw.drawSparkline(c, rect.x, rect.y, rect.w, rect.h, series);
    } else if (type === 'line') {
      const x1 = readInt(rawBlock.x1, -1, 0, FRAME_WIDTH - 1);
      const y1 = readInt(rawBlock.y1, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
      const x2 = readInt(rawBlock.x2, -1, 0, FRAME_WIDTH - 1);
      const y2 = readInt(rawBlock.y2, -1, STATUS_BAR_H, FRAME_HEIGHT - 1);
      if (x1 >= 0 && y1 >= STATUS_BAR_H && x2 >= 0 && y2 >= STATUS_BAR_H) {
        if (rawBlock.style === 'dashed' && y1 === y2) {
          draw.drawRule(c, Math.min(x1, x2), y1, Math.abs(x2 - x1), 'dashed');
        } else {
          c.drawLine(x1, y1, x2, y2, PIXEL_BLACK);
        }
      }
    } else if (type === 'rect') {
      const rect = blockRect(rawBlock);
      if (!rect) continue;
      if (rawBlock.fill === 'black') c.fillRect(rect.x, rect.y, rect.w, rect.h, PIXEL_BLACK);
      else if (rawBlock.fill === 'white') c.fillRect(rect.x, rect.y, rect.w, rect.h, PIXEL_WHITE);
      if (rawBlock.stroke !== false) c.strokeRect(rect.x, rect.y, rect.w, rect.h, PIXEL_BLACK);
    }
  }
}

function drawMetricBlock(
  c: BitmapCanvas,
  fonts: FontSet,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  series: number[],
  draw: FrameDrawKit
): void {
  c.strokeRect(x, y, w, h, PIXEL_BLACK);
  draw.drawText(c, fonts.sans12, label, x + 7, y + 4, { maxWidth: w - 14, ellipsis: true });
  draw.drawText(c, fonts.sans16, value, x + 7, y + 27, { maxWidth: w - 14, ellipsis: true });
  if (series.length >= 2 && h >= 54) {
    draw.drawSparkline(c, x + 7, y + h - 18, w - 14, 10, series);
  }
}

function drawProgressBlock(
  c: BitmapCanvas,
  fonts: FontSet,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  valueText: string,
  percentage: number,
  labelFontSize: number | undefined,
  valueFontSize: number | undefined,
  barHeight: number | undefined,
  draw: FrameDrawKit
): void {
  const labelFont = labelFontSize === 16 ? fonts.sans16 : fonts.sans12;
  const valueFont = valueFontSize === 16 ? fonts.sans16 : fonts.sans12;
  const labelTextW = textWidthFallback(labelFont, draw.fallbackForFont(labelFont), label);
  const valueTextW = valueText
    ? textWidthFallback(valueFont, draw.fallbackForFont(valueFont), valueText)
    : 0;
  const labelW = Math.min(Math.max(labelTextW + 8, 58), Math.round(w * 0.36));
  const barX = x + labelW;
  const valueW = valueText ? Math.min(Math.max(valueTextW + 4, 34), 78) : 0;
  const barW = Math.max(12, w - labelW - valueW - 10);
  const barH = Math.max(4, Math.min(barHeight ?? 9, h - 4));
  const centerY = y + Math.round(h / 2);
  const barY = centerY - Math.floor(barH / 2);
  draw.drawTextCenteredY(c, labelFont, label, x, centerY, {
    maxWidth: labelW - 6,
    ellipsis: true,
  });
  c.strokeRect(barX, barY, barW, barH, PIXEL_BLACK);
  const fillW = Math.max(0, Math.min(barW - 2, Math.round(((barW - 2) * percentage) / 100)));
  if (fillW > 0) c.fillRect(barX + 1, barY + 1, fillW, barH - 2, PIXEL_BLACK);
  if (valueText) {
    draw.drawTextCenteredY(c, valueFont, valueText, x + w, centerY, {
      align: 'right',
      maxWidth: valueW,
      ellipsis: true,
    });
  }
}
