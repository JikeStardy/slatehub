import { ICON_FONT_TEST_SAMPLE, type FontTestFontIdT } from 'shared';
import { DEVICE_FONT_IDS, type DeviceFontCatalogEntry } from './font-catalog';
import { hasGlyph, type BitmapFont } from './bitmap-font';

export interface FontSpecimen {
  hero: string;
  body: string[];
  metrics: string[];
  glyphs: string[];
}

export function readFontId(value: unknown): FontTestFontIdT {
  return typeof value === 'string' && DEVICE_FONT_IDS.has(value as FontTestFontIdT)
    ? (value as FontTestFontIdT)
    : 'fusion_pixel_12';
}

export function missingGlyphs(font: BitmapFont, text: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    if (ch === ' ' || ch === '\n') continue;
    if (hasGlyph(font, ch.codePointAt(0)!)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    missing.push(ch);
  }
  return missing;
}

export function fontSpecimen(kind: string, fontId: FontTestFontIdT): FontSpecimen {
  if (kind === 'cjk') {
    const compact = fontId === 'ark_pixel_16';
    return {
      hero: compact ? '中文 0123456789 ABC abc' : '墨水屏字体测试 中文点阵 0123456789',
      body: compact
        ? ['中文标点，。！？～', '23:59 100% OK', 'A0 iIl1 O0 8B']
        : ['今日天气 多云 23°C  风力 2 级', '简繁中文 标点，。！？～', 'ABC abc 0123456789 +12.8%'],
      metrics: ['0123456789 23:59'],
      glyphs: ['一二三 口日目 黑墨屏'],
    };
  }

  if (kind === 'display') {
    return {
      hero: '23:59',
      body: ['86%', '+12.8', '-04'],
      metrics: ['86% +12 -04'],
      glyphs: ['OK RUN'],
    };
  }

  return {
    hero: 'SlateHub UI 0123456789 ABC abc',
    body: ['The quick brown fox jumps.', 'A0 O0 I1 l1 []{} <> /\\', '23:59 100% +12.8 -04'],
    metrics: ['0123456789 23:59'],
    glyphs: ['A0 O0 I1 l1 mwMW'],
  };
}

export function fontTestLineGap(font: BitmapFont): number {
  if (font.lineHeight <= 8) return 5;
  if (font.lineHeight <= 12) return 6;
  if (font.lineHeight <= 16) return 8;
  if (font.lineHeight <= 24) return 10;
  return 12;
}

export function fontReadingLines(
  entry: DeviceFontCatalogEntry,
  specimen: FontSpecimen,
  font: BitmapFont,
  missingCount: number
): string[] {
  const footer = missingCount > 0 ? [`missing ${missingCount}`] : [];
  if (entry.kind === 'cjk') {
    if (entry.id === 'ark_pixel_16') {
      return [
        specimen.hero,
        ...specimen.body,
        ...specimen.metrics,
        ...specimen.glyphs,
        'ABCDEF abcdef 0123456789',
        'A0 O0 I1 l1 []{}<>',
        ...footer,
      ];
    }
    return [
      specimen.hero,
      '中文测试 墨水屏 点阵字体',
      '今天多云 23°C 风力 2级',
      '黑白像素 横竖撇捺 点线面',
      '简繁中文 标点，。！？；：～',
      '一二三四五六七八九十 口日目田回',
      '0123456789 23:59 100% +12.8',
      'ABC abc A0 O0 I1 l1 []{}<>',
      ...footer,
    ];
  }

  const dense = font.lineHeight <= 12;
  return [
    specimen.hero,
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'abcdefghijklmnopqrstuvwxyz',
    '0123456789 23:59 100% +12.8 -04',
    'A0 O0 I1 l1 mwMW []{} <> /\\',
    dense ? 'The quick brown fox jumps over the lazy dog.' : 'The quick brown fox jumps.',
    'SlateHub UI e-paper bitmap font',
    '!@#$%^&*()_+-=;:,.?',
    ...(dense
      ? [
          '0123456789 ABCDEF abcdef',
          'render align width baseline',
          'pixel density row spacing test',
          'left center right edge sample',
        ]
      : []),
    ...footer,
  ];
}

export function fontTestSampleText(specimenKind: string, specimen: FontSpecimen): string {
  return specimenKind === 'icon'
    ? ICON_FONT_TEST_SAMPLE
    : specimenKind === 'display'
      ? '23:59 86% +12 -04 OK RUN'
      : [specimen.hero, ...specimen.body, ...specimen.metrics, ...specimen.glyphs].join(' ');
}
