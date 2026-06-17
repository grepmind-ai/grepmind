import { z } from 'zod';
import { ContextLayerError } from './context-layer-errors.js';

export interface PromptRefinerQuestion {
  id: string;
  question: string;
  reason: string;
}

export type PromptRefinerOutput =
  | {
      status: 'ready';
      refinedQuery: string;
      assumptions: string[];
      questions: [];
    }
  | {
      status: 'needs_agent_answers';
      refinedQueryDraft: string;
      assumptions: string[];
      questions: PromptRefinerQuestion[];
    };

const questionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

const outputSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      refinedQuery: z.string().min(1),
      assumptions: z.array(z.string()).max(20),
      questions: z.tuple([]),
    })
    .strict(),
  z
    .object({
      status: z.literal('needs_agent_answers'),
      refinedQueryDraft: z.string().min(1),
      assumptions: z.array(z.string()).max(20),
      questions: z.array(questionSchema).min(1).max(3),
    })
    .strict(),
]);

export function parsePromptRefinerOutput(raw: string): PromptRefinerOutput {
  const stripped = stripAnsi(raw).trim();
  if (!stripped) {
    throw new ContextLayerError(
      'PROMPT_REFINER_EMPTY_OUTPUT',
      'Codex prompt-refiner did not return an output message.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractOptionalJsonFence(stripped));
  } catch (error) {
    throw new ContextLayerError(
      'PROMPT_REFINER_MALFORMED_OUTPUT',
      `Codex prompt-refiner returned malformed JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const validation = outputSchema.safeParse(parsed);
  if (!validation.success) {
    throw new ContextLayerError(
      'PROMPT_REFINER_MALFORMED_OUTPUT',
      `Codex prompt-refiner JSON did not match the required contract: ${validation.error.message}`,
    );
  }

  return normalizePromptRefinerOutput(validation.data);
}

function normalizePromptRefinerOutput(
  output: z.infer<typeof outputSchema>,
): PromptRefinerOutput {
  const assumptions = output.assumptions
    .map((assumption) => assumption.trim())
    .filter(Boolean);

  if (output.status === 'ready') {
    const refinedQuery = output.refinedQuery.trim();
    if (!refinedQuery) {
      throw new ContextLayerError(
        'PROMPT_REFINER_MALFORMED_OUTPUT',
        'Codex prompt-refiner returned an empty refinedQuery.',
      );
    }
    return {
      status: 'ready',
      refinedQuery,
      assumptions,
      questions: [],
    };
  }

  const refinedQueryDraft = output.refinedQueryDraft.trim();
  if (!refinedQueryDraft) {
    throw new ContextLayerError(
      'PROMPT_REFINER_MALFORMED_OUTPUT',
      'Codex prompt-refiner returned an empty refinedQueryDraft.',
    );
  }

  const seen = new Set<string>();
  const questions = output.questions.map((question) => {
    const normalized = {
      id: question.id.trim(),
      question: question.question.trim(),
      reason: question.reason.trim(),
    };
    if (
      !normalized.id ||
      !normalized.question ||
      !normalized.reason
    ) {
      throw new ContextLayerError(
        'PROMPT_REFINER_MALFORMED_OUTPUT',
        'Codex prompt-refiner returned an empty question field.',
      );
    }
    if (seen.has(normalized.id)) {
      throw new ContextLayerError(
        'PROMPT_REFINER_MALFORMED_OUTPUT',
        `Codex prompt-refiner returned duplicate question id "${normalized.id}".`,
      );
    }
    seen.add(normalized.id);
    return normalized;
  });

  return {
    status: 'needs_agent_answers',
    refinedQueryDraft,
    assumptions,
    questions,
  };
}

function extractOptionalJsonFence(value: string): string {
  const match = /^```(?:json)?\s*\n(?<body>[\s\S]*?)\n```\s*$/i.exec(value);
  return match?.groups?.body?.trim() ?? value;
}

const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

function stripAnsi(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_PATTERN, '');
}
