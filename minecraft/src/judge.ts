/**
 * The judgement call: one batched TypeSafe request per decision (KTD3).
 *
 * The action Choice and the speculative Nouls travel in a single `systemOne`
 * call. Jev ingests `state` once and evaluates every question against it in
 * parallel, so extra questions cost tokens rather than round trips -- and the
 * round trip is the expensive part of a 500ms decision budget.
 *
 * The question text itself is not in this file. It lives in
 * `questions/base.json` (KTD5) so a later unit can swap it with a flag and so
 * the exact prompt under review is a diff in git rather than a string literal.
 *
 * Nothing here imports mineflayer, and nothing here does arithmetic on the
 * bot's situation: `project()` has already turned every quantity into a named
 * band before a `RequestState` reaches this module.
 *
 * ## How the model is pinned
 *
 * Per request. `SystemOneRequest.model` is an optional per-call override --
 * "Model override; omitted values inherit `defaultModel`" -- and the client's
 * `defaultModel` falls back to `TYPESAFE_DEFAULT_MODEL` and then to the alias
 * `jev-latest` (`TypeSafeClientConfig` in
 * `node_modules/@typesafe-ai/sdk/dist/index.d.mts`, and
 * https://docs.typesafe.ai/models "Aliases"). An alias moves when a release
 * ships, and this project's confidence thresholds are tuned against one
 * version, so `model` is a required argument here with no default: there is no
 * code path that can quietly fall through to `jev-latest`.
 *
 * The version that answered is read back off the RESPONSE (`SystemOneResult.model`,
 * https://docs.typesafe.ai/api "Response body"), never assumed to be the string
 * that was sent.
 */

import { readFileSync } from 'node:fs';

import { APIError } from '@typesafe-ai/sdk';
import type {
  ChoiceQuestion,
  NoulQuestion,
  Questions,
  RequestOptions,
  SystemOneRequestPayload,
  TypeSafeClient,
} from '@typesafe-ai/sdk';

import { ACTIONS } from './types.ts';
import type { Action, JudgementOutcome, JudgementResult, RequestState } from './types.ts';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * jev-1.13's context budgets, from https://docs.typesafe.ai/models: 64k tokens
 * per request in total, and 32k for `state` plus the single longest question.
 * The second is the tighter one for this shape of request, because one state
 * is measured against one question at a time.
 */
export const STATE_PLUS_LONGEST_QUESTION_TOKENS = 32_000;
export const REQUEST_TOKENS = 64_000;

/**
 * Characters per token, used to bound the request from above.
 *
 * There is no tokenizer for Jev on this side of the wire, and adding one would
 * mean a new dependency. So this is measured instead of guessed: a real
 * request on 2026-09-21 was 3,989 characters of JSON and the response reported
 * 1,331 `input_tokens`, which is 3.00 characters per token on exactly the
 * content this module sends.
 *
 * 2.5 is used rather than the measured 3.0 so the estimate over-counts by
 * about a fifth. An oversize guard should err towards refusing, and the
 * headroom costs nothing: a real request is around 1,300 tokens against a
 * 32,000 budget, so the guard only ever fires on something pathological --
 * an unbounded entity name arriving from the game, say -- which is exactly
 * the case worth catching before it becomes a 422 mid-run.
 */
const CHARS_PER_TOKEN = 2.5;

/** Thrown before anything is sent, when a request cannot fit the model's context. */
export class StateTooLargeError extends Error {
  readonly estimatedTokens: number;
  readonly limitTokens: number;

  constructor(what: string, estimatedTokens: number, limitTokens: number) {
    super(
      `${what} is about ${estimatedTokens} tokens, over jev's ${limitTokens}-token budget. ` +
        'Refusing to send: the projection has to shrink, because truncating here would ' +
        'silently change the situation the model judged.',
    );
    this.name = 'StateTooLargeError';
    this.estimatedTokens = estimatedTokens;
    this.limitTokens = limitTokens;
  }
}

// ---------------------------------------------------------------------------
// The question set
// ---------------------------------------------------------------------------

/**
 * A versioned question file (KTD5). `questions` is the wire shape verbatim, so
 * what is reviewed in git is what is sent -- there is no layer in between that
 * could rewrite an instruction on its way out.
 */
export interface QuestionSet {
  id: string;
  version: string;
  description?: string;
  questions: Questions;
}

export const DEFAULT_QUESTION_SET_PATH = new URL('../questions/base.json', import.meta.url);

/** The Choice every decision turns on. */
const ACTION_QUESTION = 'action';
/** The speculative Nouls. They ride along for free in round trips, not in tokens. */
const NOUL_QUESTIONS = ['in_danger', 'situation_is_ambiguous'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read and validate a question set.
 *
 * The validation is not ceremony. KTD5 exists so a later unit can swap this
 * file behind a flag, and a swapped file that renames an action or drops the
 * ambiguity Noul would not fail until a fifteen-minute run had already been
 * logged against it.
 */
export function loadQuestionSet(path: string | URL = DEFAULT_QUESTION_SET_PATH): QuestionSet {
  const source = typeof path === 'string' ? path : path.pathname;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));

  if (!isRecord(parsed)) throw new Error(`${source}: question set must be a JSON object`);
  const { id, version, description, questions } = parsed;

  if (typeof id !== 'string' || id === '') throw new Error(`${source}: needs a non-empty "id"`);
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${source}: needs a semver "version" — a swapped set has to be identifiable`);
  }
  if (!isRecord(questions) || Object.keys(questions).length === 0) {
    throw new Error(`${source}: needs a non-empty "questions" map`);
  }

  const action = questions[ACTION_QUESTION];
  if (!isChoiceQuestion(action)) {
    throw new Error(`${source}: "${ACTION_QUESTION}" must be a Choice question`);
  }
  const offered = Object.keys(action.criteria).sort();
  const expected = [...ACTIONS].sort();
  if (offered.join() !== expected.join()) {
    throw new Error(
      `${source}: "${ACTION_QUESTION}" must offer exactly the six bounded actions ` +
        `(${expected.join(', ')}); it offers ${offered.join(', ') || '(none)'}`,
    );
  }

  for (const name of NOUL_QUESTIONS) {
    if (!isNoulQuestion(questions[name])) {
      throw new Error(`${source}: "${name}" must be a Noul question`);
    }
  }

  const set: QuestionSet = { id, version, questions: questions as Questions };
  if (typeof description === 'string') set.description = description;
  return set;
}

function isChoiceQuestion(value: unknown): value is ChoiceQuestion {
  return isRecord(value) && value.type === 'choice' && isRecord(value.criteria);
}

function isNoulQuestion(value: unknown): value is NoulQuestion {
  return isRecord(value) && value.type === 'noul';
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * The exact body sent to `POST /v1/systemone`. Logging this object is what
 * makes a row replayable with no Minecraft server running (R7).
 *
 * This is `SystemOneRequestPayload` with `state` narrowed from the SDK's
 * `EntryType` to the one thing this project ever sends. It is written out
 * rather than intersected because the SDK's JSON-object branch is an index
 * signature, and TypeScript will not accept an interface where one is
 * required -- see `asPayload` below.
 */
export interface JevRequest {
  state: RequestState;
  /** The versioned model ID sent. The response reports which one answered. */
  model: string;
  questions: Questions;
}

/**
 * `RequestState` is a plain JSON object of strings and small string-valued
 * objects, but it is declared as an interface, so it is not assignable to the
 * SDK's `{ [key: string]: JsonValue }` branch. The assertion restates that
 * fact and widens nothing: nothing in a `RequestState` is a number, a
 * function, or a cycle. The object itself is passed through unchanged, so the
 * body that goes on the wire is the body that goes in the log.
 */
function asPayload(request: JevRequest): SystemOneRequestPayload {
  return request as unknown as SystemOneRequestPayload;
}

/** Build one batched request. The questions go out verbatim from the file. */
export function buildRequest(
  state: RequestState,
  questionSet: QuestionSet,
  model: string,
): JevRequest {
  if (model === '') throw new Error('a model must be pinned explicitly; see the header comment');
  return { state, model, questions: questionSet.questions };
}

/**
 * Refuse to send a request that cannot fit the model's context.
 *
 * Deliberately not called on the replay path: a logged request was accepted
 * once already, and a conservative estimate that rejected it now would make
 * old rows unreplayable, which is the one thing R7 rules out.
 */
export function assertWithinBudget(request: JevRequest): void {
  const stateChars = JSON.stringify(request.state).length;
  const questionChars = Object.values(request.questions).map(
    (question) => JSON.stringify(question).length,
  );
  const longest = questionChars.reduce((max, n) => (n > max ? n : max), 0);
  const all = questionChars.reduce((sum, n) => sum + n, 0);

  const statePlusLongest = Math.ceil((stateChars + longest) / CHARS_PER_TOKEN);
  if (statePlusLongest > STATE_PLUS_LONGEST_QUESTION_TOKENS) {
    throw new StateTooLargeError(
      'state plus the longest question',
      statePlusLongest,
      STATE_PLUS_LONGEST_QUESTION_TOKENS,
    );
  }

  const whole = Math.ceil((stateChars + all) / CHARS_PER_TOKEN);
  if (whole > REQUEST_TOKENS) {
    throw new StateTooLargeError('the whole request', whole, REQUEST_TOKENS);
  }
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * One decision's worth of judgement: the exact request, and either the parsed
 * result with the full response beside it or the reason there is neither.
 *
 * A caller assembles this into a `DecisionRecord` -- it holds everything R6
 * asks for except the raw observation and what the override layer decided.
 */
export interface Judgement {
  request: JevRequest;
  outcome: JudgementOutcome;
}

export interface JudgeOptions {
  /** Injected so tests can stub the transport, and so one client is reused. */
  client: TypeSafeClient;
  /** The versioned model ID. No default: an alias would drift under the gate. */
  model: string;
  requestOptions?: RequestOptions;
}

/**
 * Make one batched judgement.
 *
 * Throws only when the request cannot legitimately be sent -- an oversize
 * state, a broken question set. A call that fails on the wire comes back as
 * `{ ok: false }`, because a failed decision is still a row the run has to
 * account for, not a gap in the log.
 */
export async function judge(
  state: RequestState,
  questionSet: QuestionSet,
  options: JudgeOptions,
): Promise<Judgement> {
  const request = buildRequest(state, questionSet, options.model);
  assertWithinBudget(request);
  return send(request, options);
}

/**
 * Re-run a logged request (R7). Takes the request body off a record and sends
 * it unchanged, so a replay differs from the original only in when it ran --
 * which is what makes the pair a determinism measurement.
 */
export async function replay(
  request: JevRequest,
  options: Omit<JudgeOptions, 'model'>,
): Promise<Judgement> {
  return send(request, options);
}

async function send(
  request: JevRequest,
  options: Omit<JudgeOptions, 'model'>,
): Promise<Judgement> {
  // Wall clock around the whole call, so a decision that the SDK retried
  // internally records the time the bot actually spent waiting rather than the
  // duration of the attempt that happened to succeed.
  const started = performance.now();
  try {
    const response = await options.client.systemOne(asPayload(request), options.requestOptions);
    const latencyMs = performance.now() - started;
    return { request, outcome: { ok: true, judgement: parse(response, latencyMs), response } };
  } catch (error) {
    return { request, outcome: { ok: false, failure: describe(error) } };
  }
}

function describe(error: unknown): string {
  if (error instanceof APIError) {
    const id = error.requestId ? ` (request ${error.requestId})` : '';
    return `HTTP ${error.status}${id}: ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `non-error thrown: ${String(error)}`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The response is typed as a union across the three question types, because
 * the questions were loaded from a file rather than written as literals. That
 * union has to be narrowed at run time anyway, and doing it strictly is the
 * point: a mis-shaped answer becomes a loud failure on the row rather than a
 * confident `undefined` in a published column.
 */
function parse(response: unknown, latencyMs: number): JudgementResult {
  if (!isRecord(response)) throw new ParseError('response is not an object');

  const model = response.model;
  if (typeof model !== 'string' || model === '') {
    throw new ParseError('response carries no model ID');
  }

  const usage = response.usage;
  if (!isRecord(usage) || typeof usage.input_tokens !== 'number') {
    throw new ParseError('response carries no usage.input_tokens');
  }

  const answers = response.answers;
  if (!isRecord(answers)) throw new ParseError('response carries no answers');

  const action = answers[ACTION_QUESTION];
  if (!isRecord(action) || action.type !== 'choice') {
    throw new ParseError(`answers.${ACTION_QUESTION} is missing or not a Choice answer`);
  }
  if (typeof action.choice !== 'string' || !isAction(action.choice)) {
    throw new ParseError(
      `answers.${ACTION_QUESTION}.choice is ${JSON.stringify(action.choice)}, ` +
        `not one of the six bounded actions`,
    );
  }
  if (typeof action.confidence !== 'number' || !Number.isFinite(action.confidence)) {
    throw new ParseError(`answers.${ACTION_QUESTION}.confidence is not a number`);
  }
  const probabilities = readDistribution(action.probabilities);

  const nouls: Record<string, number> = {};
  for (const name of NOUL_QUESTIONS) {
    const answer = answers[name];
    if (!isRecord(answer) || answer.type !== 'noul') {
      throw new ParseError(`answers.${name} is missing or not a Noul answer`);
    }
    if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
      throw new ParseError(`answers.${name}.noul is not a number`);
    }
    nouls[name] = answer.noul;
  }

  return {
    action: action.choice,
    probabilities,
    // Derived by the model from the distribution, not the top probability;
    // read off the response rather than recomputed. See
    // https://docs.typesafe.ai/confidence.
    confidence: action.confidence,
    inDanger: nouls.in_danger as number,
    situationIsAmbiguous: nouls.situation_is_ambiguous as number,
    model,
    inputTokens: usage.input_tokens,
    latencyMs,
  };
}

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}

/**
 * The distribution is what the confidence gate and the whole report rest on,
 * so it is checked rather than trusted: every action present, every entry a
 * finite number, and the six summing to 1. The tolerance is loose enough for
 * float noise and tight enough that a renormalisation bug cannot hide in it.
 */
function readDistribution(value: unknown): Record<Action, number> {
  if (!isRecord(value)) throw new ParseError('probabilities is not an object');

  const extra = Object.keys(value).filter((key) => !isAction(key));
  if (extra.length > 0) {
    throw new ParseError(`probabilities carries unknown options: ${extra.join(', ')}`);
  }

  const distribution = {} as Record<Action, number>;
  let total = 0;
  for (const name of ACTIONS) {
    const probability = value[name];
    if (typeof probability !== 'number' || !Number.isFinite(probability)) {
      throw new ParseError(`probabilities.${name} is missing or not a number`);
    }
    distribution[name] = probability;
    total += probability;
  }

  if (Math.abs(total - 1) > 1e-3) {
    throw new ParseError(`the six action probabilities sum to ${total}, not 1`);
  }
  return distribution;
}
