const SAFE_DIAGNOSTIC_LINE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}T.*\b(ERROR|WARN)\b/i,
  /^ERROR[:\s]/i,
  /^error[:\s]/i,
  /^warning[:\s]/i,
  /^warn[:\s]/i,
  /^thread .* panicked/i,
  /^caused by:/i,
  /\b(invalid|unsupported|not found|permission denied|timed out|timeout|failed|unknown argument|exit code)\b/i,
];

const MAX_SAFE_DIAGNOSTIC_LINES = 30;

export function formatDiagnosticTail(value: string | undefined): string {
  const safeText = safeDiagnosticText(value);
  return safeText
    ? `stderr tail: ${safeText}`
    : 'No safe stderr diagnostics were produced.';
}

export function safeDiagnosticText(value: string | undefined): string {
  const lines = stripAnsi(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) =>
      SAFE_DIAGNOSTIC_LINE_PATTERNS.some((pattern) => pattern.test(line)),
    );

  return lines.slice(-MAX_SAFE_DIAGNOSTIC_LINES).join('\n');
}

export function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}
