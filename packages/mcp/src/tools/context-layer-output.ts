import {
  formatDiagnosticTail,
  stripAnsi,
} from './context-layer-diagnostics.js';
import { ContextLayerError } from './context-layer-errors.js';

export const REQUIRED_CONTEXT_PACK_HEADINGS = [
  '# context_pack',
  '## Answer',
  '## Evidence Quality',
  '## Sufficiency',
  '## Code Context',
  '## Docs Context',
  '## Flow',
] as const;

type RequiredContextPackHeading =
  (typeof REQUIRED_CONTEXT_PACK_HEADINGS)[number];

interface ParsedContextPackSection {
  heading: RequiredContextPackHeading;
  content: string;
}

interface ParsedContextPack {
  sections: ParsedContextPackSection[];
}

export function normalizeContextPackMarkdown(
  raw: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): string {
  const parsed = parseContextPackMarkdown(raw, options);
  return renderContextPack(parsed.sections);
}

export function summarizeContextPackForLimit(input: {
  contextPackMarkdown: string;
  maxOutputBytes: number;
  runtimeDurationMs?: number;
}): string {
  const parsed = parseContextPackMarkdown(input.contextPackMarkdown, {
    runtimeDurationMs: input.runtimeDurationMs,
  });
  const suffix = '\n\n[context_layer output truncated.]';
  const suffixBytes = byteLength(suffix);
  const minimal = renderContextPack(
    parsed.sections.map((section) => ({
      heading: section.heading,
      content:
        section.heading === '# context_pack'
          ? ''
          : '[section omitted because output exceeded the response limit.]',
    })),
  );

  if (byteLength(minimal) + suffixBytes > input.maxOutputBytes) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_OUTPUT_TOO_LARGE',
      'Codex context_layer output exceeded the response limit and even the compact context_pack summary is too large.',
      { runtimeDurationMs: input.runtimeDurationMs },
    );
  }

  const weightedSections = parsed.sections.filter(
    (section) => section.heading !== '# context_pack',
  );
  const weights = new Map<RequiredContextPackHeading, number>([
    ['## Answer', 1],
    ['## Evidence Quality', 2],
    ['## Sufficiency', 2],
    ['## Code Context', 3],
    ['## Docs Context', 2],
    ['## Flow', 2],
  ]);
  const renderOverhead = byteLength(
    renderContextPack(
      parsed.sections.map((section) => ({ ...section, content: '' })),
    ),
  );
  const markerBytes =
    weightedSections.length * byteLength('\n\n[section truncated]');
  const bodyBudget = Math.max(
    0,
    input.maxOutputBytes - suffixBytes - renderOverhead - markerBytes,
  );
  const totalWeight = weightedSections.reduce(
    (total, section) => total + (weights.get(section.heading) ?? 1),
    0,
  );

  const summarizedSections = parsed.sections.map((section) => {
    if (section.heading === '# context_pack') {
      return section;
    }
    const budget = Math.max(
      120,
      Math.floor(
        (bodyBudget * (weights.get(section.heading) ?? 1)) / totalWeight,
      ),
    );
    const truncated = truncateUtf8(section.content, budget);
    return {
      heading: section.heading,
      content:
        truncated === section.content.trim()
          ? truncated
          : `${truncated}\n\n[section truncated]`,
    };
  });

  const summary = `${renderContextPack(summarizedSections)}${suffix}`;
  if (byteLength(summary) <= input.maxOutputBytes) {
    return summary;
  }

  return `${minimal}${suffix}`;
}

function parseContextPackMarkdown(
  raw: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): ParsedContextPack {
  const text = stripAnsi(raw).replaceAll(/\r\n?/g, '\n').trim();
  if (!text) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_EMPTY_OUTPUT',
      `Codex context_layer subagent returned an empty output message. ${formatDiagnosticTail(options?.stderrTail)}`,
      { runtimeDurationMs: options?.runtimeDurationMs },
    );
  }

  const subagentError = parseSubagentError(text);
  if (subagentError) {
    throw new ContextLayerError(subagentError.code, subagentError.message, {
      runtimeDurationMs: options?.runtimeDurationMs,
    });
  }

  const lines = text.split('\n');
  const headingMatches = collectMarkdownHeadings(lines);
  const actualHeadings = headingMatches.map((match) => match.heading);
  const expectedHeadings = [...REQUIRED_CONTEXT_PACK_HEADINGS];

  if (headingMatches.length !== expectedHeadings.length) {
    throwMalformedContextPack(
      `expected exactly ${expectedHeadings.length} top-level context_pack headings, got ${headingMatches.length}`,
      options,
    );
  }

  for (let index = 0; index < expectedHeadings.length; index += 1) {
    if (actualHeadings[index] !== expectedHeadings[index]) {
      throwMalformedContextPack(
        `expected heading "${expectedHeadings[index]}" at position ${index + 1}, got "${actualHeadings[index] ?? 'none'}"`,
        options,
      );
    }
  }

  if (headingMatches[0]?.lineIndex !== 0) {
    throwMalformedContextPack(
      'the first non-empty line must be "# context_pack"',
      options,
    );
  }

  const h1Content = lines
    .slice(headingMatches[0].lineIndex + 1, headingMatches[1].lineIndex)
    .join('\n')
    .trim();
  if (h1Content) {
    throwMalformedContextPack(
      'do not put prose between "# context_pack" and "## Answer"',
      options,
    );
  }

  const sections: ParsedContextPackSection[] = headingMatches.map(
    (match, index) => {
      const next = headingMatches[index + 1];
      const content = lines
        .slice(match.lineIndex + 1, next?.lineIndex ?? lines.length)
        .join('\n')
        .trim();
      return {
        heading: requireContextPackHeading(match.heading, options),
        content,
      };
    },
  );

  for (const section of sections) {
    if (section.heading === '# context_pack') {
      continue;
    }
    if (!section.content) {
      throwMalformedContextPack(
        `${section.heading} must contain concise content; use "No relevant docs found" for an empty docs layer`,
        options,
      );
    }
  }
  validateEvidenceQuality(sections, options);
  validateSufficiency(sections, options);

  return { sections };
}

function validateEvidenceQuality(
  sections: ParsedContextPackSection[],
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): void {
  const evidence = sections.find(
    (section) => section.heading === '## Evidence Quality',
  );
  if (evidence == null) {
    throwMalformedContextPack(
      'missing required "## Evidence Quality" section',
      options,
    );
  }

  const requiredLabels = [
    'Proven anchors:',
    'Inferences:',
    'Gaps:',
    'Failed or truncated summaries:',
  ];
  for (const label of requiredLabels) {
    if (!evidence.content.includes(label)) {
      throwMalformedContextPack(
        `Evidence Quality must include "${label}"`,
        options,
      );
    }
  }

  const hasConfidence =
    /(^|\n)\s*-?\s*Confidence:\s*(high|medium|low)\b/im.test(
      evidence.content,
    );
  if (!hasConfidence) {
    throwMalformedContextPack(
      'Evidence Quality must include "Confidence: high|medium|low"',
      options,
    );
  }
}

function validateSufficiency(
  sections: ParsedContextPackSection[],
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): void {
  const sufficiency = sections.find(
    (section) => section.heading === '## Sufficiency',
  );
  if (sufficiency == null) {
    throwMalformedContextPack('missing required "## Sufficiency" section', options);
  }

  const requiredLabels = [
    'Enough to answer:',
    'Missing context:',
    'Suggested next context queries:',
  ];
  for (const label of requiredLabels) {
    if (!sufficiency.content.includes(label)) {
      throwMalformedContextPack(
        `Sufficiency must include "${label}"`,
        options,
      );
    }
  }

  const hasEnough =
    /(^|\n)\s*-?\s*Enough to answer:\s*(yes|no)\b/im.test(
      sufficiency.content,
    );
  if (!hasEnough) {
    throwMalformedContextPack(
      'Sufficiency must include "Enough to answer: yes|no"',
      options,
    );
  }
}

function collectMarkdownHeadings(lines: string[]): Array<{
  heading: RequiredContextPackHeading | string;
  lineIndex: number;
}> {
  const headings: Array<{
    heading: RequiredContextPackHeading | string;
    lineIndex: number;
  }> = [];
  let insideFence = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
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
    const heading = `${match[1]} ${match[2]}`;
    if (!REQUIRED_CONTEXT_PACK_HEADINGS.includes(heading as never)) {
      headings.push({ heading, lineIndex });
      continue;
    }
    headings.push({
      heading: heading as RequiredContextPackHeading,
      lineIndex,
    });
  }

  return headings;
}

function parseSubagentError(text: string): {
  code: 'CODE_SEARCH_UNAVAILABLE';
  message: string;
} | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== 'ERROR: CODE_SEARCH_UNAVAILABLE') {
    return null;
  }

  return {
    code: 'CODE_SEARCH_UNAVAILABLE',
    message:
      lines.slice(1).join(' ').trim() ||
      'Grepmind code_search is unavailable or index is not ready.',
  };
}

function requireContextPackHeading(
  heading: RequiredContextPackHeading | string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): RequiredContextPackHeading {
  if (REQUIRED_CONTEXT_PACK_HEADINGS.includes(heading as never)) {
    return heading as RequiredContextPackHeading;
  }

  throwMalformedContextPack(`unexpected heading "${heading}"`, options);
}

function renderContextPack(sections: ParsedContextPackSection[]): string {
  return sections
    .map((section) =>
      section.heading === '# context_pack'
        ? section.heading
        : `${section.heading}\n\n${section.content.trim()}`,
    )
    .join('\n\n')
    .trim();
}

function throwMalformedContextPack(
  reason: string,
  options?: { runtimeDurationMs?: number; stderrTail?: string },
): never {
  throw new ContextLayerError(
    'CODEX_SUBAGENT_FAILED',
    `Codex context_layer subagent returned malformed context_pack: ${reason}. ${formatDiagnosticTail(options?.stderrTail)}`,
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
