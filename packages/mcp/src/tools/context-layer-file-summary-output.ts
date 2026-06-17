import { stripAnsi } from './context-layer-diagnostics.js';
import { ContextLayerError } from './context-layer-errors.js';

export const REQUIRED_FILE_SUMMARY_HEADINGS = [
  '# file_summary',
  '## File',
  '## Relevance',
  '## Required Snippets',
  '## Explanation',
] as const;

type RequiredFileSummaryHeading =
  (typeof REQUIRED_FILE_SUMMARY_HEADINGS)[number];

interface ParsedFileSummarySection {
  heading: RequiredFileSummaryHeading;
  content: string;
}

export function normalizeFileSummaryMarkdown(
  raw: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): string {
  const sections = parseFileSummaryMarkdown(raw, options);
  return renderFileSummary(sections);
}

export function summarizeFileSummaryForLimit(input: {
  output: string;
  maxOutputBytes: number;
  runtimeDurationMs?: number;
}): string {
  const sections = parseFileSummaryMarkdown(input.output, {
    runtimeDurationMs: input.runtimeDurationMs,
  });
  const suffix = '\n\n[file_summary output truncated.]';
  const suffixBytes = byteLength(suffix);
  const renderOverhead = byteLength(
    renderFileSummary(sections.map((section) => ({ ...section, content: '' }))),
  );
  const bodySections = sections.filter(
    (section) => section.heading !== '# file_summary',
  );
  const markerBytes =
    bodySections.length * byteLength('\n\n[section truncated]');
  const bodyBudget = Math.max(
    0,
    input.maxOutputBytes - suffixBytes - renderOverhead - markerBytes,
  );
  const perSectionBudget = Math.max(
    80,
    Math.floor(bodyBudget / Math.max(1, bodySections.length)),
  );

  const summarized = sections.map((section) => {
    if (section.heading === '# file_summary') {
      return section;
    }
    const truncated = truncateUtf8(section.content, perSectionBudget);
    return {
      heading: section.heading,
      content:
        truncated === section.content.trim()
          ? truncated
          : `${truncated}\n\n[section truncated]`,
    };
  });
  const summary = `${renderFileSummary(summarized)}${suffix}`;

  if (byteLength(summary) <= input.maxOutputBytes) {
    return summary;
  }

  return renderFileSummary(
    sections.map((section) => ({
      heading: section.heading,
      content:
        section.heading === '# file_summary'
          ? ''
          : '[section omitted because output exceeded the response limit.]',
    })),
  );
}

function parseFileSummaryMarkdown(
  raw: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): ParsedFileSummarySection[] {
  const text = stripAnsi(raw).replaceAll(/\r\n?/g, '\n').trim();
  if (!text) {
    throwMalformedFileSummary('empty file_summary output', options);
  }

  const lines = text.split('\n');
  const headingMatches = collectMarkdownHeadings(lines);
  const actualHeadings = headingMatches.map((match) => match.heading);
  const expectedHeadings = [...REQUIRED_FILE_SUMMARY_HEADINGS];

  if (headingMatches.length !== expectedHeadings.length) {
    throwMalformedFileSummary(
      `expected exactly ${expectedHeadings.length} file_summary headings, got ${headingMatches.length}`,
      options,
    );
  }

  for (let index = 0; index < expectedHeadings.length; index += 1) {
    if (actualHeadings[index] !== expectedHeadings[index]) {
      throwMalformedFileSummary(
        `expected heading "${expectedHeadings[index]}" at position ${index + 1}, got "${actualHeadings[index] ?? 'none'}"`,
        options,
      );
    }
  }

  if (headingMatches[0]?.lineIndex !== 0) {
    throwMalformedFileSummary(
      'the first non-empty line must be "# file_summary"',
      options,
    );
  }

  const h1Content = lines
    .slice(headingMatches[0].lineIndex + 1, headingMatches[1].lineIndex)
    .join('\n')
    .trim();
  if (h1Content) {
    throwMalformedFileSummary(
      'do not put prose between "# file_summary" and "## File"',
      options,
    );
  }

  const sections: ParsedFileSummarySection[] = headingMatches.map(
    (match, index) => {
      const next = headingMatches[index + 1];
      return {
        heading: requireFileSummaryHeading(match.heading, options),
        content: lines
          .slice(match.lineIndex + 1, next?.lineIndex ?? lines.length)
          .join('\n')
          .trim(),
      };
    },
  );

  for (const section of sections) {
    if (section.heading === '# file_summary') {
      continue;
    }
    if (!section.content) {
      throwMalformedFileSummary(
        `${section.heading} must contain content`,
        options,
      );
    }
  }

  return sections;
}

function collectMarkdownHeadings(lines: string[]): Array<{
  heading: RequiredFileSummaryHeading | string;
  lineIndex: number;
}> {
  const headings: Array<{
    heading: RequiredFileSummaryHeading | string;
    lineIndex: number;
  }> = [];
  let insideFence = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim() ?? '';
    if (/^(```|~~~)/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      continue;
    }

    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    headings.push({
      heading: `${match[1]} ${match[2]}`,
      lineIndex,
    });
  }

  return headings;
}

function requireFileSummaryHeading(
  heading: RequiredFileSummaryHeading | string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): RequiredFileSummaryHeading {
  if (REQUIRED_FILE_SUMMARY_HEADINGS.includes(heading as never)) {
    return heading as RequiredFileSummaryHeading;
  }

  throwMalformedFileSummary(`unexpected heading "${heading}"`, options);
}

function renderFileSummary(sections: ParsedFileSummarySection[]): string {
  return sections
    .map((section) =>
      section.heading === '# file_summary'
        ? section.heading
        : `${section.heading}\n\n${section.content.trim()}`,
    )
    .join('\n\n')
    .trim();
}

function throwMalformedFileSummary(
  reason: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): never {
  throw new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    `Codex context_layer file summary subagent returned malformed file_summary: ${reason}.`,
    { runtimeDurationMs: options?.runtimeDurationMs },
  );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const text = value.trim();
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return text;
  }

  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return buffer.subarray(0, end).toString('utf8').trimEnd();
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
