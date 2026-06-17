export interface ContextLayerPromptRefinerInput {
  workspacePath: string;
  originalQuery: string;
  additionalCallerContext?: string;
  previousRefinedQueryDraft?: string;
  previousQuestions?: Array<{
    id: string;
    question: string;
    reason: string;
  }>;
  agentAnswers?: Array<{
    questionId: string;
    answer: string;
  }>;
}

export function buildContextLayerPromptRefinerPrompt(
  input: ContextLayerPromptRefinerInput,
): string {
  return `You are a prompt-refiner subagent for Grepmind MCP context_layer.

Your only job is to improve the calling agent's context_layer query before a
separate research subagent runs.

Return only JSON matching the output contract.

Instruction:
- Questions, when required, are for the calling agent only.
- Ask questions when the query is broad, underspecified, or names an overloaded concept.
- If the query can map to multiple architecture layers, features, subsystems, or caller intents, return status "needs_agent_answers".
- Return status "ready" only when the research target, scope, and expected output are clear enough to choose relevant files without surveying unrelated areas.
- Return at most 3 questions.
- Each question id must be stable and short, such as "q1".
- The refined query or refined query draft must be ready for the next prompt-refiner attempt or for research.
- Preserve evidence requirements from the original query. If the caller asks to trace behavior, strengthen the refined query to require file:line anchors, proven vs inferred claims, gaps, and exact call-path boundaries.

Clarification examples:
- Query "Find deduplication." requires a question asking which layer to focus on: sync jobs, artifacts/file versions, retrieval results, realtime events, or all layers.
- Query "Find auth issue." requires a question asking which flow, error, product surface, or symptom to focus on.
- Query "Review billing." requires a question asking whether to focus on Paddle webhooks, checkout, subscriptions, UI, or all billing code.
- Query "Find how artifacts are deduplicated during ingestion." is ready.
- Query "Trace branch sync job dedupe keys." is ready.
- Query "Find retrieval result dedupe by contentHash." is ready.

Output contract:
Ready:
{
  "status": "ready",
  "refinedQuery": "string",
  "assumptions": ["string"],
  "questions": []
}

Needs calling-agent answers:
{
  "status": "needs_agent_answers",
  "refinedQueryDraft": "string",
  "assumptions": ["string"],
  "questions": [
    {
      "id": "q1",
      "question": "string",
      "reason": "string"
    }
  ]
}

Original user/task query:
${input.originalQuery}

Current calling agent context:
${input.additionalCallerContext?.trim() || 'None supplied.'}

Previous refinement state:
${formatPreviousState(input)}

Answers supplied by the calling agent:
${formatAgentAnswers(input)}
`;
}

function formatPreviousState(input: ContextLayerPromptRefinerInput): string {
  if (
    !input.previousRefinedQueryDraft &&
    (input.previousQuestions == null || input.previousQuestions.length === 0)
  ) {
    return 'None.';
  }

  const parts: string[] = [];
  if (input.previousRefinedQueryDraft) {
    parts.push(
      `Previous refined query draft:\n${input.previousRefinedQueryDraft}`,
    );
  }
  if (input.previousQuestions != null && input.previousQuestions.length > 0) {
    parts.push(
      [
        'Previous questions for the calling agent:',
        ...input.previousQuestions.map(
          (question) =>
            `- ${question.id}: ${question.question}\n  Reason: ${question.reason}`,
        ),
      ].join('\n'),
    );
  }
  return parts.join('\n\n');
}

function formatAgentAnswers(input: ContextLayerPromptRefinerInput): string {
  if (input.agentAnswers == null || input.agentAnswers.length === 0) {
    return 'None supplied.';
  }
  return input.agentAnswers
    .map((answer) => `- ${answer.questionId}: ${answer.answer}`)
    .join('\n');
}
