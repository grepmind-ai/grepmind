import { randomBytes } from 'node:crypto';
import { ContextLayerError } from './context-layer-errors.js';
import type { ResolvedContextLayerModel } from './context-layer-model-config.js';
import type { ContextLayerFocus } from './context-layer-prompt.js';
import type { PromptRefinerQuestion } from './prompt-refiner-output.js';

export interface RefinementAgentAnswer {
  questionId: string;
  answer: string;
}

export interface RefinementSession {
  id: string;
  workspacePath: string;
  originalQuery: string;
  additionalCallerContext?: string;
  focus: ContextLayerFocus;
  maxFiles: number;
  maxSearchCalls: number;
  model: ResolvedContextLayerModel;
  refinedQueryDraft: string;
  assumptions: string[];
  questions: PromptRefinerQuestion[];
  answerHistory: Array<{
    questionId: string;
    answer: string;
    receivedAt: number;
  }>;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const DEFAULT_REFINEMENT_TTL_MS = 30 * 60 * 1000;
const MAX_REFINEMENT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_REFINEMENT_SESSIONS = 100;
const DEFAULT_MAX_REFINEMENT_ATTEMPTS = 3;

const refinementSessions = new Map<string, RefinementSession>();

export function createRefinementSession(input: {
  workspacePath: string;
  originalQuery: string;
  additionalCallerContext?: string;
  focus: ContextLayerFocus;
  maxFiles: number;
  maxSearchCalls: number;
  model: ResolvedContextLayerModel;
  refinedQueryDraft: string;
  assumptions: string[];
  questions: PromptRefinerQuestion[];
}): RefinementSession {
  cleanupExpiredSessions();
  evictOldestSessions(resolveMaxRefinementSessions() - 1);

  const now = Date.now();
  const session: RefinementSession = {
    id: `clr_${randomBytes(16).toString('base64url')}`,
    workspacePath: input.workspacePath,
    originalQuery: input.originalQuery,
    additionalCallerContext: input.additionalCallerContext,
    focus: input.focus,
    maxFiles: input.maxFiles,
    maxSearchCalls: input.maxSearchCalls,
    model: input.model,
    refinedQueryDraft: input.refinedQueryDraft,
    assumptions: input.assumptions,
    questions: input.questions,
    answerHistory: [],
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + resolveRefinementTtlMs(),
  };
  refinementSessions.set(session.id, session);
  return session;
}

export function getRefinementSession(id: string): RefinementSession {
  const session = refinementSessions.get(id);
  if (session == null) {
    throw new ContextLayerError(
      'REFINEMENT_SESSION_NOT_FOUND',
      `Refinement session ${id} was not found. Start a new context_layer call without refinementSession.`,
    );
  }
  if (session.expiresAt <= Date.now()) {
    refinementSessions.delete(id);
    throw new ContextLayerError(
      'REFINEMENT_SESSION_EXPIRED',
      `Refinement session ${id} has expired. Start a new context_layer call without refinementSession.`,
    );
  }
  cleanupExpiredSessions();
  return session;
}

export function recordRefinementAttempt(
  session: RefinementSession,
  answers: RefinementAgentAnswer[],
): RefinementSession {
  if (session.attempts >= DEFAULT_MAX_REFINEMENT_ATTEMPTS) {
    throw new ContextLayerError(
      'REFINEMENT_SESSION_ATTEMPTS_EXCEEDED',
      `Refinement session ${session.id} exceeded ${DEFAULT_MAX_REFINEMENT_ATTEMPTS} attempts.`,
    );
  }

  validateRefinementAnswers(session, answers);
  const now = Date.now();
  const updated: RefinementSession = {
    ...session,
    attempts: session.attempts + 1,
    answerHistory: [
      ...session.answerHistory,
      ...answers.map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer,
        receivedAt: now,
      })),
    ],
    updatedAt: now,
    expiresAt: now + resolveRefinementTtlMs(),
  };
  refinementSessions.set(session.id, updated);
  return updated;
}

export function updateRefinementSessionQuestions(
  session: RefinementSession,
  input: {
    refinedQueryDraft: string;
    assumptions: string[];
    questions: PromptRefinerQuestion[];
  },
): RefinementSession {
  const now = Date.now();
  const updated: RefinementSession = {
    ...session,
    refinedQueryDraft: input.refinedQueryDraft,
    assumptions: input.assumptions,
    questions: input.questions,
    updatedAt: now,
    expiresAt: now + resolveRefinementTtlMs(),
  };
  refinementSessions.set(session.id, updated);
  return updated;
}

export function deleteRefinementSession(id: string | undefined): void {
  if (id != null) {
    refinementSessions.delete(id);
  }
}

export function validateRefinementAnswers(
  session: RefinementSession,
  answers: RefinementAgentAnswer[],
): void {
  if (answers.length === 0) {
    throw new ContextLayerError(
      'REFINEMENT_SESSION_ANSWER_REQUIRED',
      `Refinement session ${session.id} requires non-empty agentAnswers to continue.`,
    );
  }

  const knownQuestionIds = new Set(
    session.questions.map((question) => question.id),
  );
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!knownQuestionIds.has(answer.questionId)) {
      throw new ContextLayerError(
        'REFINEMENT_SESSION_UNKNOWN_QUESTION',
        `Refinement session ${session.id} has no question with id "${answer.questionId}".`,
      );
    }
    if (seen.has(answer.questionId)) {
      throw new ContextLayerError(
        'REFINEMENT_SESSION_UNKNOWN_QUESTION',
        `Refinement session ${session.id} received duplicate answer for "${answer.questionId}".`,
      );
    }
    seen.add(answer.questionId);
  }
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of refinementSessions) {
    if (session.expiresAt <= now) {
      refinementSessions.delete(id);
    }
  }
}

function evictOldestSessions(maxSessionsAfterEviction: number): void {
  if (refinementSessions.size <= maxSessionsAfterEviction) {
    return;
  }

  const ordered = [...refinementSessions.values()].sort(
    (left, right) => left.updatedAt - right.updatedAt,
  );
  for (const session of ordered) {
    if (refinementSessions.size <= maxSessionsAfterEviction) {
      return;
    }
    refinementSessions.delete(session.id);
  }
}

function resolveRefinementTtlMs(): number {
  const raw = process.env.GREPMIND_CONTEXT_LAYER_REFINEMENT_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_REFINEMENT_TTL_MS;
  }
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_REFINEMENT_TTL_MS
  ) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      `GREPMIND_CONTEXT_LAYER_REFINEMENT_TTL_MS must be a positive integer no greater than ${MAX_REFINEMENT_TTL_MS}.`,
    );
  }
  return value;
}

function resolveMaxRefinementSessions(): number {
  const raw =
    process.env.GREPMIND_CONTEXT_LAYER_MAX_REFINEMENT_SESSIONS?.trim();
  if (!raw) {
    return DEFAULT_MAX_REFINEMENT_SESSIONS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 10_000) {
    throw new ContextLayerError(
      'CODEX_SUBAGENT_FAILED',
      'GREPMIND_CONTEXT_LAYER_MAX_REFINEMENT_SESSIONS must be a positive integer no greater than 10000.',
    );
  }
  return value;
}
