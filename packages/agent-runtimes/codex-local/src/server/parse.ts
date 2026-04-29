import { asString, asNumber, parseObject, parseJson } from "@rudderhq/agent-runtime-utils/server-utils";

type ParsedQuestion = {
  prompt: string;
  choices: Array<{ key: string; label: string; description?: string }>;
  questions?: Array<{
    id: string;
    header: string;
    question: string;
    choices: Array<{ key: string; label: string; description?: string }>;
  }>;
};

function normalizeQuestionChoice(value: unknown, fallbackIndex: number) {
  const choice = parseObject(value);
  const label = asString(choice.label, "").trim();
  if (!label) return null;
  return {
    key:
      asString(choice.key, "").trim()
      || asString(choice.id, "").trim()
      || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
      || `option_${fallbackIndex + 1}`,
    label,
    description: asString(choice.description, "").trim() || undefined,
  };
}

function normalizeRequestUserInput(value: unknown): ParsedQuestion | null {
  const payload = parseObject(value);
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : [];
  const questions = rawQuestions
    .slice(0, 3)
    .map((questionRaw, questionIndex) => {
      const question = parseObject(questionRaw);
      const prompt = asString(question.question, "").trim() || asString(question.prompt, "").trim();
      if (!prompt) return null;
      const choices = (Array.isArray(question.options) ? question.options : Array.isArray(question.choices) ? question.choices : [])
        .slice(0, 3)
        .map((choiceRaw, choiceIndex) => normalizeQuestionChoice(choiceRaw, choiceIndex))
        .filter((choice): choice is NonNullable<ReturnType<typeof normalizeQuestionChoice>> => Boolean(choice));
      if (choices.length < 2) return null;
      return {
        id: asString(question.id, "").trim() || `question_${questionIndex + 1}`,
        header: asString(question.header, "").trim() || `Question ${questionIndex + 1}`,
        question: prompt,
        choices,
      };
    })
    .filter((question): question is NonNullable<typeof question> => Boolean(question));

  if (questions.length > 0) {
    return {
      prompt: questions[0]!.question,
      choices: questions[0]!.choices,
      questions,
    };
  }

  const prompt = asString(payload.prompt, "").trim() || asString(payload.question, "").trim();
  if (!prompt) return null;
  const choices = (Array.isArray(payload.choices) ? payload.choices : Array.isArray(payload.options) ? payload.options : [])
    .slice(0, 3)
    .map((choiceRaw, choiceIndex) => normalizeQuestionChoice(choiceRaw, choiceIndex))
    .filter((choice): choice is NonNullable<ReturnType<typeof normalizeQuestionChoice>> => Boolean(choice));
  if (choices.length < 2) return null;
  return {
    prompt,
    choices,
    questions: [{
      id: "question_1",
      header: "Question",
      question: prompt,
      choices,
    }],
  };
}

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  let errorMessage: string | null = null;
  let question: ParsedQuestion | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) messages.push(text);
      }
      if (asString(item.type, "") === "tool_use" && asString(item.name, "") === "request_user_input") {
        question = normalizeRequestUserInput(item.input);
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    errorMessage,
    question,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}
