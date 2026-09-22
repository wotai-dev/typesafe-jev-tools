/**
 * `project(raw, buckets)` — the one function that stands between the game and
 * the model.
 *
 * Every quantity the game produces is compared here and leaves as a named band
 * (R3). Jev receives no number at all: not a distance, not a health value, not
 * an item count. The output has a fixed set of slots, always all present, with
 * the literal string `'none'` where something is absent (KTD4), so every logged
 * row is structurally identical and the model is never asked to interpret a
 * missing key.
 *
 * Nothing here imports mineflayer, and that is load-bearing rather than tidy:
 * U6 re-projects a logged run under a different bucket table with no server
 * running (R8, AE4), and U8's baseline scores the same predicates offline. The
 * import is checked by a test rather than trusted to this comment, because the
 * offline gate cannot catch a leak — importing mineflayer needs no server.
 */

import {
  assertBucketTable,
  DEFAULT_BUCKETS,
  daylightBand,
  levelBand,
  lightBand,
  rangeBand,
  type BucketTable,
} from './buckets.ts';
import type {
  ObservedItem,
  RangeBand,
  RawObservation,
  RequestState,
  ThreatSlot,
  Vec3,
} from './types.ts';

/**
 * Thrown rather than returned. A state built from a bad observation is not a
 * degraded row, it is a row that says something false about the world, and it
 * would sit in the dataset the discrimination pair is computed over.
 */
export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionError';
  }
}

/**
 * Straight-line distance in blocks.
 *
 * `ObservedEntity` also carries a `distance` captured at observation time, for
 * the reflex layer that runs before any of this. The projection deliberately
 * derives its own from the logged positions instead: that makes a re-projection
 * a function of the logged geometry alone, so a sweep that changes what counts
 * as distance is possible at all, and a hand-written or edited fixture cannot
 * disagree with itself. `observe()` fills its `distance` with this same
 * function, so live and re-derived values are identical, not merely close.
 */
export function distanceBetween(from: Vec3, to: Vec3): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

function requireFinite(value: number, field: string, tick: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectionError(
      `cannot project tick ${String(tick)}: ${field} is ${String(value)}, not a finite number. ` +
        'The server sends the health packet just after the spawn event rather than with it, so ' +
        'an observation captured too early carries undefined here — and banding it would put a ' +
        'confidently wrong level on the first rows of the run.',
    );
  }
  return value;
}

function requirePosition(position: Vec3 | undefined, field: string, tick: number): Vec3 {
  if (!position) {
    throw new ProjectionError(`cannot project tick ${String(tick)}: ${field} has no position`);
  }
  requireFinite(position.x, `${field}.position.x`, tick);
  requireFinite(position.y, `${field}.position.y`, tick);
  requireFinite(position.z, `${field}.position.z`, tick);
  return position;
}

function matchesName(
  item: ObservedItem,
  names: readonly string[],
  suffixes: readonly string[] = [],
): boolean {
  return names.includes(item.name) || suffixes.some((suffix) => item.name.endsWith(suffix));
}

function countMatching(
  inventory: readonly ObservedItem[],
  tick: number,
  names: readonly string[],
  suffixes: readonly string[] = [],
): number {
  let total = 0;
  for (const item of inventory) {
    if (!matchesName(item, names, suffixes)) continue;
    total += requireFinite(item.count, `inventory item ${item.name} count`, tick);
  }
  return total;
}

/**
 * Turn a raw observation into the state Jev is shown.
 *
 * @param raw   what the game gave us, unmodified and logged verbatim (KTD6).
 * @param buckets which boundaries to band under. Defaulted so the live loop
 *   never picks a table by accident, and parameterised so replay can pass a
 *   different one over the same logged observation (R8, AE4).
 */
export function project(raw: RawObservation, buckets: BucketTable = DEFAULT_BUCKETS): RequestState {
  assertBucketTable(buckets);

  const tick = raw.tick;
  const health = requireFinite(raw.health, 'health', tick);
  const food = requireFinite(raw.food, 'food', tick);
  const lightLevel = requireFinite(raw.lightLevel, 'lightLevel', tick);
  const timeOfDay = requireFinite(raw.timeOfDay, 'timeOfDay', tick);
  const self = requirePosition(raw.position, 'the bot', tick);

  // --- threats -------------------------------------------------------------
  // Distance is recomputed from the logged positions rather than read off the
  // observation; see `distanceBetween`.
  let nearest: { kind: string; distance: number; visible: boolean } | undefined;
  let hostileCount = 0;

  for (const entity of raw.entities) {
    if (entity.disposition !== 'hostile') continue;
    hostileCount += 1;
    const distance = distanceBetween(self, requirePosition(entity.position, entity.kind, tick));
    if (nearest && nearest.distance <= distance) continue;
    nearest = { kind: entity.kind, distance, visible: entity.hasLineOfSight };
  }

  const nearestThreat: ThreatSlot | 'none' = nearest
    ? {
        kind: nearest.kind,
        range: rangeBand(nearest.distance, buckets.range),
        visible: nearest.visible,
      }
    : 'none';

  // Counted after the nearest is taken out, so `otherThreats` reads as "besides
  // that one". Two hostiles is one more; three or more stops being countable
  // and becomes `several`, because a number here would be a number to Jev.
  const others = Math.max(0, hostileCount - 1);
  const otherThreats: RequestState['otherThreats'] =
    others === 0 ? 'none' : others === 1 ? 'one-more' : 'several';

  // --- inventory -----------------------------------------------------------
  const { items } = buckets;
  const foodCount = countMatching(raw.inventory, tick, items.foodNames);
  const blockCount = countMatching(raw.inventory, tick, items.blockNames, items.blockSuffixes);
  const hasWeapon = raw.inventory.some((item) =>
    matchesName(item, [], items.meleeWeaponSuffixes),
  );

  // --- gatherable ----------------------------------------------------------
  const gatherable: RangeBand | 'none' = raw.nearestResource
    ? rangeBand(
        distanceBetween(
          self,
          requirePosition(raw.nearestResource.position, raw.nearestResource.name, tick),
        ),
        buckets.range,
      )
    : 'none';

  return {
    nearestThreat,
    otherThreats,
    health: levelBand(health, buckets.health),
    hunger: levelBand(food, buckets.hunger),
    light: lightBand(lightLevel, buckets.light),
    daylight: daylightBand(timeOfDay, buckets.daylight),
    foodInInventory: foodCount >= items.minFoodForSome ? 'some' : 'none',
    blocks: blockCount >= items.minBlocksForSome ? 'some' : 'none',
    weapon: hasWeapon ? 'melee' : 'none',
    gatherable,
    previousAction: raw.previousAction ?? 'none',
  };
}
