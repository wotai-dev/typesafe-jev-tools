import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';

import {
  DEFAULT_QUESTION_SET_PATH,
  StateTooLargeError,
  buildRequest,
  judge,
  loadQuestionSet,
  replay,
} from '../src/judge.ts';
import { ACTIONS } from '../src/types.ts';
import type { Action, RequestState } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MODEL = 'jev-1.13.0';

/**
 * A fixture that is deliberately not a clear-cut case: a zombie in melee range
 * with low health and food in the bag. `flee`, `fight` and `eat` are all
 * defensible, which is the shape of row the ambiguity noul has to discriminate.
 */
const FIXTURE_STATE: RequestState = {
  nearestThreat: { kind: 'zombie', range: 'melee', visible: true },
  otherThreats: 'none',
  health: 'low',
  hunger: 'moderate',
  light: 'dark',
  daylight: 'night',
  foodInInventory: 'some',
  blocks: 'some',
  weapon: 'melee',
  gatherable: 'far',
  previousAction: 'gather',
};

/** The distribution the stub hands back. Deliberately not a one-hot answer. */
const PROBABILITIES: Record<Action, number> = {
  flee: 0.41,
  fight: 0.33,
  eat: 0.09,
  shelter: 0.11,
  gather: 0.04,
  hold: 0.02,
};

function responseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Deliberately a different string from the alias a caller might send, so
    // the test can tell the reported model from the requested one.
    model: MODEL,
    answers: {
      action: {
        type: 'choice',
        choice: 'flee',
        probabilities: { ...PROBABILITIES },
        confidence: 0.42,
      },
      in_danger: { type: 'noul', noul: 0.88 },
      situation_is_ambiguous: { type: 'noul', noul: 0.71 },
    },
    usage: { input_tokens: 412, output_tokens: 57 },
    ...overrides,
  };
}

interface Attempt {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A client whose transport is a queue of canned HTTP responses. Nothing here
 * touches the network, but the request still travels through the real SDK, so
 * the tests exercise the SDK's own serialisation, retry and parsing rather than
 * a hand-rolled imitation of them.
 */
function stubClient(
  queue: ReadonlyArray<{ status: number; body: unknown; delayMs?: number }>,
): { client: TypeSafeClient; attempts: Attempt[] } {
  const attempts: Attempt[] = [];
  let index = 0;

  const client = new TypeSafeClient({
    apiKey: 'test-key-not-a-real-credential',
    // Retries are the point of one of the tests below; the default 500ms first
    // backoff would make it slow for no added coverage.
    retry: { backoffInitialMs: 25, backoffJitter: 0 },
    logLevel: 'off',
    fetch: async (url, init) => {
      const raw = typeof init?.body === 'string' ? init.body : '';
      attempts.push({
        url,
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: raw === '' ? undefined : JSON.parse(raw),
      });
      const next = queue[Math.min(index, queue.length - 1)];
      index += 1;
      assert.ok(next, 'stub client ran out of canned responses');
      if (next.delayMs) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return { client, attempts };
}

function ok(queue: ReadonlyArray<{ status: number; body: unknown; delayMs?: number }>) {
  return stubClient(queue);
}

/** One recorded attempt, asserted present so a missing call reads as a missing call. */
function sent(attempts: readonly Attempt[], index = 0): Attempt {
  const attempt = attempts[index];
  assert.ok(attempt, `expected at least ${index + 1} attempt(s), saw ${attempts.length}`);
  return attempt;
}

// ---------------------------------------------------------------------------
// The question file
// ---------------------------------------------------------------------------

test('the shipped question set declares the action Choice and both speculative Nouls', () => {
  const set = loadQuestionSet();

  assert.deepEqual(
    Object.keys(set.questions).sort(),
    ['action', 'in_danger', 'situation_is_ambiguous'],
    'base.json must carry the action Choice and the two speculative Nouls',
  );

  const action = set.questions.action;
  assert.ok(action && action.type === 'choice');
  assert.deepEqual(
    Object.keys(action.criteria).sort(),
    [...ACTIONS].sort(),
    'the Choice must offer exactly the six bounded actions',
  );

  for (const name of ACTIONS) {
    const description: unknown = action.criteria[name];
    assert.equal(typeof description, 'string', `${name} must be described`);
    // Jaggedness #1, literal reading: jev-1.13 answers the question written,
    // so a bare label is a bug. Each entry has to describe the situation in
    // which that action is the right call, which takes more than a few words.
    assert.ok(
      typeof description === 'string' && description.length > 60,
      `criteria entry "${name}" reads like a label, not a condition: ${JSON.stringify(description)}`,
    );
    assert.notEqual(
      String(description).trim().toLowerCase(),
      name,
      `criteria entry "${name}" is a bare label`,
    );
  }

  for (const name of ['in_danger', 'situation_is_ambiguous'] as const) {
    const question = set.questions[name];
    assert.ok(question && question.type === 'noul', `${name} must be a Noul`);
    assert.ok(question.criteria?.true, `${name} must describe what a yes means`);
    assert.ok(question.criteria?.false, `${name} must describe what a no means`);
  }

  assert.ok(set.id, 'the set must be identifiable');
  assert.match(set.version, /^\d+\.\d+\.\d+$/, 'the set must be versioned (KTD5)');
});

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

test('a fixture state produces a request carrying exactly the keys the question file declares', () => {
  const set = loadQuestionSet();
  const request = buildRequest(FIXTURE_STATE, set, MODEL);

  assert.deepEqual(Object.keys(request.questions).sort(), Object.keys(set.questions).sort());
  // Verbatim, not re-derived: the prompt text under review in git is the prompt
  // text that was sent.
  assert.deepEqual(request.questions, set.questions);
  assert.deepEqual(request.state, FIXTURE_STATE);
  assert.equal(request.model, MODEL);
  assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
});

test('the request body that reaches the wire is the request body that is logged', async () => {
  const { client, attempts } = ok([{ status: 200, body: responseBody() }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.equal(attempts.length, 1);
  assert.equal(sent(attempts).url, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(sent(attempts).body, result.request);
  assert.equal((sent(attempts).body as { model: string }).model, MODEL);
});

test('swapping the question file changes the request with no code change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-questions-'));
  try {
    const base = JSON.parse(readFileSync(DEFAULT_QUESTION_SET_PATH, 'utf8')) as {
      id: string;
      version: string;
      questions: Record<string, unknown>;
    };
    const swapped = {
      ...base,
      id: 'experiment-terse',
      version: '2.0.0',
      questions: {
        ...base.questions,
        action: {
          ...(base.questions.action as Record<string, unknown>),
          instructions: 'Which single action should the bot commit to for the next second?',
        },
        // A speculative extra: adding a question must cost tokens, not code.
        has_escape_route: {
          type: 'noul',
          instructions: 'Can the bot break away from `nearestThreat` without being cornered?',
          criteria: { true: 'There is somewhere to go.', false: 'The bot is boxed in.' },
        },
      },
    };
    const path = join(dir, 'terse.json');
    writeFileSync(path, JSON.stringify(swapped, null, 2));

    const { client, attempts } = ok([
      {
        status: 200,
        body: responseBody({
          answers: {
            ...(responseBody().answers as Record<string, unknown>),
            has_escape_route: { type: 'noul', noul: 0.3 },
          },
        }),
      },
    ]);

    const set = loadQuestionSet(path);
    assert.equal(set.id, 'experiment-terse');
    const result = await judge(FIXTURE_STATE, set, { client, model: MODEL });

    const body = sent(attempts).body as { questions: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.questions).sort(), [
      'action',
      'has_escape_route',
      'in_danger',
      'situation_is_ambiguous',
    ]);
    assert.notDeepEqual(body.questions.action, loadQuestionSet().questions.action);
    assert.ok(result.outcome.ok, 'the swapped set must still produce a judgement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The record — every field R6 requires
// ---------------------------------------------------------------------------

test('the response parses into a record carrying every field R6 requires', async () => {
  const { client } = ok([{ status: 200, body: responseBody() }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.ok(result.outcome.ok, `expected a judgement, got: ${JSON.stringify(result.outcome)}`);
  const { judgement, response } = result.outcome;

  assert.equal(judgement.action, 'flee');
  for (const name of ACTIONS) {
    assert.equal(
      typeof judgement.probabilities[name],
      'number',
      `probabilities must carry an entry for ${name}`,
    );
  }
  assert.deepEqual(Object.keys(judgement.probabilities).sort(), [...ACTIONS].sort());
  assert.equal(judgement.confidence, 0.42);
  assert.equal(judgement.inDanger, 0.88);
  assert.equal(judgement.situationIsAmbiguous, 0.71);
  assert.equal(judgement.inputTokens, 412);
  assert.equal(judgement.model, MODEL);
  assert.equal(typeof judgement.latencyMs, 'number');
  assert.ok(judgement.latencyMs >= 0 && Number.isFinite(judgement.latencyMs));

  // R6 also wants the exact request and the full response on the row, and R7
  // wants that to be enough to re-run the judgement offline.
  assert.deepEqual(result.request.state, FIXTURE_STATE);
  assert.deepEqual(response, responseBody());
});

test('the recorded model is the one the response reports, not the alias that was sent', async () => {
  const { client, attempts } = ok([{ status: 200, body: responseBody({ model: 'jev-1.14.2' }) }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: 'jev-latest' });

  assert.equal((sent(attempts).body as { model: string }).model, 'jev-latest');
  assert.ok(result.outcome.ok);
  assert.equal(result.outcome.judgement.model, 'jev-1.14.2');
});

test('the probabilities over the six actions sum to 1', async () => {
  const { client } = ok([{ status: 200, body: responseBody() }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.ok(result.outcome.ok);
  const { probabilities } = result.outcome.judgement;
  const summed = ACTIONS.reduce((total, name) => total + probabilities[name], 0);
  assert.ok(
    Math.abs(summed - 1) < 1e-9,
    `the six action probabilities summed to ${summed}, not 1`,
  );
});

test('a distribution that is not a distribution is rejected rather than acted on', async () => {
  const broken = responseBody();
  (broken.answers as Record<string, Record<string, unknown>>).action = {
    type: 'choice',
    choice: 'flee',
    probabilities: { ...PROBABILITIES, flee: 0.9 },
    confidence: 0.42,
  };
  const { client } = ok([{ status: 200, body: broken }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.equal(result.outcome.ok, false);
  assert.ok(
    !result.outcome.ok && /sum/i.test(result.outcome.failure),
    `failure should name the unnormalised distribution, got: ${JSON.stringify(result.outcome)}`,
  );
});

test('a missing answer is a loud failure, not a silently absent column', async () => {
  const body = responseBody();
  delete (body.answers as Record<string, unknown>).situation_is_ambiguous;
  const { client } = ok([{ status: 200, body }]);
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.equal(result.outcome.ok, false);
  assert.ok(!result.outcome.ok && result.outcome.failure.includes('situation_is_ambiguous'));
});

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

test('a state padded past the token budget raises rather than sending', async () => {
  const { client, attempts } = ok([{ status: 200, body: responseBody() }]);
  const padded: RequestState = {
    ...FIXTURE_STATE,
    // `kind` is mineflayer's entity name, a plain string, so nothing in the
    // type system stops a pathological one reaching the request builder.
    nearestThreat: { kind: 'z'.repeat(200_000), range: 'melee', visible: true },
  };

  await assert.rejects(
    () => judge(padded, loadQuestionSet(), { client, model: MODEL }),
    (error: unknown) => {
      assert.ok(error instanceof StateTooLargeError, `wrong error type: ${String(error)}`);
      assert.match(String(error), /32/, 'the message should name the budget it blew');
      return true;
    },
  );

  assert.equal(attempts.length, 0, 'nothing may be sent once the budget is known to be blown');
});

test('a state inside the budget is not rejected', () => {
  const set = loadQuestionSet();
  const request = buildRequest(FIXTURE_STATE, set, MODEL);
  assert.doesNotThrow(() => buildRequest(FIXTURE_STATE, set, MODEL));
  assert.ok(Object.keys(request.questions).length > 0);
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a 429 surfaces as a retry rather than a dropped decision, and the latency covers both attempts', async () => {
  const { client, attempts } = ok([
    { status: 429, body: { error: 'rate limited' } },
    { status: 200, body: responseBody() },
  ]);

  const started = performance.now();
  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });
  const wall = performance.now() - started;

  assert.equal(attempts.length, 2, 'the 429 must be retried, not dropped');
  assert.ok(result.outcome.ok, 'the retried decision must still produce a judgement');
  // 25ms is the stub client's first backoff. The measured latency has to span
  // the whole decision including the wait, or a retried row understates the
  // time the bot actually spent blind.
  assert.ok(
    result.outcome.judgement.latencyMs >= 25,
    `latency ${result.outcome.judgement.latencyMs}ms does not include the retry backoff`,
  );
  assert.ok(result.outcome.judgement.latencyMs <= wall + 1);
});

test('an exhausted retry budget becomes a recorded failure, not a thrown decision', async () => {
  const { client, attempts } = ok([
    { status: 429, body: { error: 'rate limited' } },
    { status: 429, body: { error: 'rate limited' } },
    { status: 429, body: { error: 'rate limited' } },
  ]);

  const result = await judge(FIXTURE_STATE, loadQuestionSet(), { client, model: MODEL });

  assert.equal(attempts.length, 3, 'the SDK default is two retries after the first attempt');
  assert.equal(result.outcome.ok, false);
  assert.ok(!result.outcome.ok && /429/.test(result.outcome.failure));
  // The request still has to be on the row: a failed call is a row the
  // override layer explains, not a gap in the log.
  assert.deepEqual(result.request.state, FIXTURE_STATE);
});

// ---------------------------------------------------------------------------
// Replay (R7)
// ---------------------------------------------------------------------------

test('a logged request alone is enough to re-run the judgement', async () => {
  const { client: first } = ok([{ status: 200, body: responseBody() }]);
  const original = await judge(FIXTURE_STATE, loadQuestionSet(), { client: first, model: MODEL });

  // Round-tripped through JSON, which is how a record reaches a replay.
  const logged = JSON.parse(JSON.stringify(original.request)) as typeof original.request;

  const { client: second, attempts } = ok([{ status: 200, body: responseBody() }]);
  const again = await replay(logged, { client: second });

  assert.deepEqual(sent(attempts).body, logged);
  assert.ok(again.outcome.ok && original.outcome.ok);
  assert.deepEqual(again.outcome.judgement.probabilities, original.outcome.judgement.probabilities);
});
