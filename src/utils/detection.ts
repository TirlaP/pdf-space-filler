import type {
  PDFDocumentProxy,
  PDFPageProxy,
  TextItem,
} from 'pdfjs-dist/types/src/display/api';
import type { Field, PageMeta } from '../store/usePdfStore';

const MIN_UNDERSCORE_RUN = 8;
const MIN_FIELD_WIDTH = 20;
const MIN_FIELD_HEIGHT = 14;
const FIELD_VERTICAL_OFFSET: number = -2; // Adjust to shift detected fields vertically (negative lifts up).

type GlyphSegment = {
  start: number;
  end: number;
  width: number;
};

type GlyphMetrics = {
  totalUnits: number;
  segments: GlyphSegment[];
};

const buildGlyphMetrics = (
  page: PDFPageProxy,
  item: TextItem,
): GlyphMetrics | null => {
  const commonObjs = (page as unknown as { commonObjs?: { get?: (key: string) => unknown } })
    .commonObjs;
  if (!commonObjs?.get) return null;

  let font: unknown;
  try {
    font = commonObjs.get(item.fontName);
  } catch (error) {
    return null;
  }

  if (!font || typeof (font as { charsToGlyphs?: unknown }).charsToGlyphs !== 'function') {
    return null;
  }

  const glyphs = (font as { charsToGlyphs: (value: string) => unknown[] }).charsToGlyphs(
    item.str,
  );

  if (!Array.isArray(glyphs) || glyphs.length === 0) {
    return null;
  }

  const segments: GlyphSegment[] = [];
  let cursor = 0;
  let totalUnits = 0;

  for (const glyph of glyphs) {
    if (!glyph) continue;
    const glyphObj = glyph as { unicode?: unknown; width?: unknown };
    const unicode = typeof glyphObj.unicode === 'string' ? glyphObj.unicode : '';
    const span = unicode.length > 0 ? unicode.length : 1;
    const width = Number.isFinite(glyphObj.width) ? Number(glyphObj.width) : 0;

    segments.push({
      start: cursor,
      end: cursor + span,
      width,
    });

    totalUnits += width;
    cursor += span;
  }

  if (!Number.isFinite(totalUnits) || totalUnits === 0) {
    return null;
  }

  return { totalUnits, segments };
};

const measureRunUsingGlyphs = (
  metrics: GlyphMetrics,
  runStart: number,
  runLength: number,
): { prefix: number; run: number } => {
  const runEnd = runStart + runLength;
  let prefixUnits = 0;
  let runUnits = 0;

  for (const segment of metrics.segments) {
    if (segment.end <= runStart) {
      prefixUnits += segment.width;
      continue;
    }

    if (segment.start >= runEnd) {
      break;
    }

    const segmentSpan = Math.max(segment.end - segment.start, 1);

    if (segment.start < runStart) {
      const beforePortion = (runStart - segment.start) / segmentSpan;
      prefixUnits += segment.width * beforePortion;
    }

    const overlapStart = Math.max(segment.start, runStart);
    const overlapEnd = Math.min(segment.end, runEnd);
    const overlapLength = Math.max(overlapEnd - overlapStart, 0);

    if (overlapLength > 0) {
      runUnits += (segment.width * overlapLength) / segmentSpan;
    }
  }

  return { prefix: prefixUnits, run: runUnits };
};

const clampSize = (value: number, min: number, available: number) => {
  const safeAvailable = Number.isFinite(available) && available > 0 ? available : min;
  const lowerBound = Math.min(min, safeAvailable);
  const expanded = Math.max(value, lowerBound);
  return Math.min(expanded, safeAvailable);
};

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `field_${Math.random().toString(36).slice(2, 9)}`;

export async function detectFieldsForPage(
  page: PDFPageProxy,
  pageMeta: PageMeta,
): Promise<Field[]> {
  const viewport = page.getViewport({ scale: pageMeta.scale });
  const textContent = await page.getTextContent();

  const detected: Field[] = [];
  let pageFieldCount = 0;

  for (const item of textContent.items) {
    if (!('str' in item)) continue;
    const str = item.str ?? '';
    if (!str.includes('_')) continue;

    const matches = [...str.matchAll(/(_{3,})/g)];
    if (!matches.length) continue;

    const glyphCount = str.length || 1;
    const itemWidth = Number.isFinite(item.width) ? item.width : 0;
    const charWidth = glyphCount > 0 ? itemWidth / glyphCount : 0;
    const glyphMetrics = buildGlyphMetrics(page, item as TextItem);
    const transform = item.transform;
    const baseX = transform[4];
    const baseY = transform[5];
    const fontHeight = Math.sqrt(transform[2] ** 2 + transform[3] ** 2) || 10;

    for (const match of matches) {
      if (match.index === undefined) continue;
      const runLength = match[0].length;
      if (runLength < MIN_UNDERSCORE_RUN) continue;

      const startOffset = match.index ?? 0;
      let measuredWidth = charWidth * runLength;
      let measuredStartOffset = charWidth * startOffset;

      if (glyphMetrics) {
        const { prefix, run } = measureRunUsingGlyphs(glyphMetrics, startOffset, runLength);
        const scale = glyphMetrics.totalUnits !== 0 ? itemWidth / glyphMetrics.totalUnits : 0;
        if (scale > 0 && run > 0) {
          measuredStartOffset = prefix * scale;
          measuredWidth = run * scale;
        }
      }

      const sourceX =
        item.dir === 'rtl'
          ? baseX - (measuredStartOffset + measuredWidth)
          : baseX + measuredStartOffset;

      const fallbackWidth = charWidth > 0 ? charWidth * runLength : itemWidth;
      const lineWidth = measuredWidth > 0 ? measuredWidth : fallbackWidth;
      if (!(lineWidth > 0)) {
        continue;
      }

      const rect = viewport.convertToViewportRectangle([
        sourceX,
        baseY - fontHeight * 0.6,
        sourceX + lineWidth,
        baseY + fontHeight * 0.2,
      ]);

      const [x1, y1, x2, y2] = rect;
      let x = Math.min(x1, x2);
      const rawWidth = Math.abs(x2 - x1);
      const rawHeight = Math.abs(y2 - y1) || fontHeight * pageMeta.scale * 0.4;
      const minWidthTarget = Math.max(MIN_FIELD_WIDTH, rawWidth ? rawWidth : MIN_FIELD_WIDTH);
      let width = clampSize(rawWidth, MIN_FIELD_WIDTH, pageMeta.width - x);
      if (width < minWidthTarget) {
        width = Math.min(minWidthTarget, pageMeta.width - x);
      }
      const heightCandidate = clampSize(
        rawHeight,
        MIN_FIELD_HEIGHT,
        pageMeta.height,
      );
      const height = Math.min(heightCandidate, MIN_FIELD_HEIGHT + 16);
      const centerY = (y1 + y2) / 2;
      let y = centerY - height;
      if (y < 0) y = 0;
      if (y + height > pageMeta.height) {
        y = Math.max(pageMeta.height - height, 0);
      }
      if (FIELD_VERTICAL_OFFSET !== 0) {
        const shiftedY = y + FIELD_VERTICAL_OFFSET;
        const maxY = Math.max(pageMeta.height - height, 0);
        y = Math.min(Math.max(shiftedY, 0), maxY);
      }
      x = Math.max(x, 0);
      if (x + width > pageMeta.width) {
        width = Math.max(pageMeta.width - x, 1);
      }

      pageFieldCount += 1;

      detected.push({
        id: makeId(),
        pageIndex: pageMeta.index,
        x,
        y,
        width,
        height,
        multiline: false,
        confidence: 0.6,
        name: `page${pageMeta.index + 1}_field_${pageFieldCount}`,
      });
    }
  }

  return detected;
}

export async function detectFields(
  pdfDoc: PDFDocumentProxy,
  pages: PageMeta[],
): Promise<Field[]> {
  const aggregated: Field[] = [];

  for (const meta of pages) {
    const page = await pdfDoc.getPage(meta.index + 1);
    const pageFields = await detectFieldsForPage(page, meta);
    aggregated.push(...pageFields);
    page.cleanup();
  }

  return aggregated;
}
