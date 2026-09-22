/**
 * Shared types for the Jev decision layer.
 *
 * The split this file encodes is the whole design: `RawObservation` is what the
 * game gives us, `RequestState` is what Jev is allowed to see, and the function
 * between them does every calculation. Jev never receives a number.
 *
 * Nothing here imports mineflayer. `project()` and `legality()` both consume
 * `RawObservation` and must run with no game present, or the offline replay and
 * report paths cannot work.
 */

/** The six bounded actions. Always all six are offered (KD5). */
export const ACTIONS = ['flee', 'fight', 'eat', 'shelter', 'gather', 'hold'] as const;
export type Action = (typeof ACTIONS)[number];

// ---------------------------------------------------------------------------
// Raw observation — what the game gave us, before any judgement or arithmetic
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ObservedEntity {
  /** mineflayer's entity name, e.g. `zombie`, `skeleton`, `cow`. */
  kind: string;
  /** `hostile` for mobs that attack, `passive` otherwise. Classified in code. */
  disposition: 'hostile' | 'passive';
  position: Vec3;
  /** Euclidean distance in blocks. Bucketed before Jev sees it. */
  distance: number;
  /**
   * Whether the bot can actually see this entity. Needs a block-world raycast,
   * so it cannot be recovered from a log later — it is captured here, at
   * observation time, not derived in `project()`.
   */
  hasLineOfSight: boolean;
}

export interface ObservedItem {
  name: string;
  count: number;
}

/**
 * The nearest block worth gathering. Needs a block search, so like line of
 * sight it is captured rather than derived, and `legality('gather')` reads it.
 */
export interface ObservedResource {
  name: string;
  position: Vec3;
  distance: number;
}

export interface RawObservation {
  /** Server tick and wall clock, so a row can be located in a run. */
  tick: number;
  capturedAt: string;

  position: Vec3;
  /**
   * Satiation, not carried food. Both of these are `undefined` at the moment
   * the bot spawns -- the server sends the health packet just after the spawn
   * event -- so `observe()` must not capture until it has arrived. Capturing
   * early assigns `undefined` into a `number` with no compile error, and the
   * projection then bands a NaN, so the first rows of every run would carry a
   * confidently wrong health band.
   */
  health: number;
  food: number;
  oxygen: number;

  /** Minecraft time of day in ticks (0-24000) and the light level underfoot. */
  timeOfDay: number;
  lightLevel: number;

  inventory: ObservedItem[];
  entities: ObservedEntity[];
  nearestResource: ObservedResource | null;

  /**
   * Whether the bot has open sky above it. Like line of sight and the nearest
   * resource this needs the block world, so it is captured rather than derived.
   * Without it `legality('shelter')` collapses to "does it hold blocks", and
   * the bot can choose to shelter while already enclosed. Adding it later
   * would invalidate replay of every row captured before the change.
   */
  hasSkyAccess: boolean;

  /**
   * The action already executing. A logged input, not loop state: the override
   * layer reads it from the record so replay can re-derive overrides exactly.
   */
  previousAction: Action | null;
}

// ---------------------------------------------------------------------------
// Request state — fixed slots, named buckets, no numbers
// ---------------------------------------------------------------------------

export type RangeBand = 'melee' | 'bow' | 'far' | 'out-of-range';
export type LevelBand = 'critical' | 'low' | 'moderate' | 'full';
export type LightBand = 'dark' | 'dim' | 'lit';
export type DaylightBand = 'day' | 'dusk' | 'night' | 'dawn';

export interface ThreatSlot {
  kind: string;
  range: RangeBand;
  visible: boolean;
}

/**
 * Every slot is always present. Absent things are the literal string `'none'`
 * rather than null or a missing key, so every logged row has the same shape and
 * the model is never asked to interpret an absence.
 */
export interface RequestState {
  nearestThreat: ThreatSlot | 'none';
  otherThreats: 'none' | 'one-more' | 'several';
  health: LevelBand;
  hunger: LevelBand;
  light: LightBand;
  daylight: DaylightBand;
  /**
   * Carried food, not satiation -- `hunger` above is satiation. These are
   * deliberately not both called "food": this object is the model's entire
   * input and the human labeler reads the same slots, so two keys sharing a
   * word with different meanings biases the one judgment being measured.
   */
  foodInInventory: 'none' | 'some';
  blocks: 'none' | 'some';
  weapon: 'none' | 'melee';
  gatherable: 'none' | RangeBand;
  previousAction: Action | 'none';
}

// ---------------------------------------------------------------------------
// Decision record — one per decision, the unit of the dataset
// ---------------------------------------------------------------------------

export type OverrideReason =
  | 'low-confidence-commitment'
  | 'illegal-action'
  | 'call-failed'
  | null;

export interface JudgementResult {
  action: Action;
  /** Every option's probability. Sums to 1. */
  probabilities: Record<Action, number>;
  /** Derived from distribution concentration. Not the top-action probability. */
  confidence: number;
  inDanger: number;
  situationIsAmbiguous: number;
  /** The versioned model ID the response reported, not the alias we sent. */
  model: string;
  inputTokens: number;
  latencyMs: number;
}

/**
 * A union rather than two nullable fields, so a row cannot claim both a
 * judgement and a failure, or neither. `overrideReason: 'call-failed'` then
 * explains every `actionTaken` the model did not choose -- otherwise a failed
 * call carries the same `null` reason a clean model answer does, and any
 * report grouping by that field counts failures as model-answered.
 */
export type JudgementOutcome =
  | {
      ok: true;
      judgement: JudgementResult;
      /**
       * The raw response body, before parsing. Without it a mis-mapped
       * probability or a misread noul is undetectable in the published rows,
       * and there is nothing for a replay to be diffed against -- which is
       * also how the run would establish whether Jev is deterministic at all.
       */
      response: unknown;
    }
  | { ok: false; failure: string };

export interface DecisionRecord {
  id: string;
  /** Raw first: without it the projection can never be varied and re-run. */
  observation: RawObservation;
  state: RequestState;
  /** The exact request body sent, so a row is replayable verbatim. */
  request: unknown;
  outcome: JudgementOutcome;
  /** What actually ran, after the confidence gate and the legality check. */
  actionTaken: Action;
  overrideReason: OverrideReason;
  /** Set when the model picked something not currently legal. */
  rejectedAction: Action | null;
  /** Which bucket table produced `state`, so labels can be matched to it. */
  bucketTableId: string;
  /** Which bands the gate ran under. The report prints these beside its own. */
  bandsId: string;
}
