/**
 * Every boundary the projection compares against, under a name.
 *
 * KTD4: bucket boundaries are named exported constants rather than inline
 * literals, because U6's sweep re-projects a logged run under a different table
 * (R8/AE4) and a literal buried in a comparison cannot be varied. The same
 * constants are what U4's `legality()` predicates must read: if legality
 * carried its own distances, a sweep would move the band Jev sees without
 * moving the band legality enforces, and the illegal-action rate would measure
 * that divergence rather than the model.
 *
 * Nothing here imports mineflayer, and nothing here touches a bot. A table is
 * plain JSON so a sweep can supply one from a file.
 *
 * Two naming conventions, because the quantities differ in shape:
 *
 *   `*_MAX_*`         an inclusive upper bound. A value AT the boundary is the
 *                     lower band; the next value up is the upper band.
 *   `*_STARTS_AT_*`   an inclusive lower bound, used for the day/night cycle,
 *                     where the canonical Minecraft boundaries (sunset at tick
 *                     12000) are written as starts everywhere else and an
 *                     inclusive-max spelling would read as 11999.
 */

import type { DaylightBand, LevelBand, LightBand, RangeBand } from './types.ts';

// ---------------------------------------------------------------------------
// Range — how far away a threat or a resource is
// ---------------------------------------------------------------------------

/**
 * A skeleton's bow outranges a sword, so the melee/bow split is the one that
 * changes what an action means: `fight` at `melee` closes no distance, `fight`
 * at `bow` means walking through arrows. 4 blocks is roughly the reach a player
 * has plus a step; 16 is inside a skeleton's aggro and firing range.
 */
export const MELEE_MAX_BLOCKS = 4;
export const BOW_MAX_BLOCKS = 16;
/** Past this a mob is visible but not yet a participant in this decision. */
export const FAR_MAX_BLOCKS = 32;

// ---------------------------------------------------------------------------
// Health and hunger — both 0-20 in Minecraft, both banded as levels
// ---------------------------------------------------------------------------

/** 6 health is three hearts: one creeper blast from dead. */
export const HEALTH_CRITICAL_MAX = 6;
export const HEALTH_LOW_MAX = 12;
/** Anything short of the full 20 is `moderate`, so `full` means full. */
export const HEALTH_MODERATE_MAX = 19;

/** Below 6 the player cannot sprint, which removes fleeing as an escape. */
export const HUNGER_CRITICAL_MAX = 6;
export const HUNGER_LOW_MAX = 12;
/** Regeneration needs 18 or more, so 17 is the top of "eating still buys you something". */
export const HUNGER_MODERATE_MAX = 17;

// ---------------------------------------------------------------------------
// Light — 0-15
// ---------------------------------------------------------------------------

/** Block light 0 is where hostile mobs can spawn; that is the line that matters. */
export const LIGHT_DARK_MAX = 0;
/** Dim enough that a mob can close before it is seen. */
export const LIGHT_DIM_MAX = 7;

// ---------------------------------------------------------------------------
// Time of day — 0-23999 ticks
// ---------------------------------------------------------------------------

export const TICKS_PER_MINECRAFT_DAY = 24000;
/** Sunset begins at 12000, hostile spawning at 13000, sunrise at 23000. */
export const DUSK_STARTS_AT_TICKS = 12000;
export const NIGHT_STARTS_AT_TICKS = 13000;
export const DAWN_STARTS_AT_TICKS = 23000;

// ---------------------------------------------------------------------------
// Inventory — item counts, and which item names count as what
// ---------------------------------------------------------------------------

/**
 * R3 names item count as a quantity that must reach Jev as a bucket, and the
 * `'none' | 'some'` slots are that bucket. The threshold is the boundary, so it
 * is a constant like any other: a sweep can ask whether one block is really
 * "some blocks" when `shelter` needs several.
 */
export const MIN_FOOD_ITEMS_FOR_SOME = 1;
export const MIN_BLOCK_ITEMS_FOR_SOME = 1;

/**
 * What counts as food, as a placeable block, and as a melee weapon. These are
 * classifications rather than thresholds, but they live here for the same
 * reason: `project()` must hold no literals, and U4's `legality('eat')` and
 * `legality('shelter')` have to agree with what Jev was shown.
 */
export const FOOD_ITEM_NAMES: readonly string[] = [
  'apple',
  'baked_potato',
  'beetroot',
  'beetroot_soup',
  'bread',
  'cake',
  'carrot',
  'cooked_beef',
  'cooked_chicken',
  'cooked_cod',
  'cooked_mutton',
  'cooked_porkchop',
  'cooked_rabbit',
  'cooked_salmon',
  'cookie',
  'dried_kelp',
  'glow_berries',
  'golden_apple',
  'golden_carrot',
  'honey_bottle',
  'melon_slice',
  'mushroom_stew',
  'pumpkin_pie',
  'rabbit_stew',
  'suspicious_stew',
  'sweet_berries',
  // Raw meat and rotten flesh are deliberately absent: they feed, but eating
  // them is a different decision, and lumping them in would make `eat` look
  // free when it is not.
];

/** Named exactly, for the blocks that do not share a suffix with anything. */
export const BLOCK_ITEM_NAMES: readonly string[] = [
  'andesite',
  'cobblestone',
  'diorite',
  'dirt',
  'granite',
  'gravel',
  'netherrack',
  'sand',
  'stone',
];

/** Matched by suffix, which covers every wood and stone variant at once. */
export const BLOCK_ITEM_SUFFIXES: readonly string[] = [
  '_planks',
  '_log',
  '_wood',
  '_slab',
  '_stairs',
  '_bricks',
  '_terracotta',
  '_concrete',
  '_wool',
];

/** A sword or an axe. A pickaxe digs; it does not make `fight` a real option. */
export const MELEE_WEAPON_SUFFIXES: readonly string[] = ['_sword', '_axe'];

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export interface RangeBoundaries {
  meleeMaxBlocks: number;
  bowMaxBlocks: number;
  farMaxBlocks: number;
}

export interface LevelBoundaries {
  criticalMax: number;
  lowMax: number;
  moderateMax: number;
}

export interface LightBoundaries {
  darkMax: number;
  dimMax: number;
}

export interface DaylightBoundaries {
  duskStartsAtTicks: number;
  nightStartsAtTicks: number;
  dawnStartsAtTicks: number;
}

export interface ItemBoundaries {
  minFoodForSome: number;
  minBlocksForSome: number;
  foodNames: readonly string[];
  blockNames: readonly string[];
  blockSuffixes: readonly string[];
  meleeWeaponSuffixes: readonly string[];
}

/**
 * One complete set of boundaries. `id` is what `DecisionRecord.bucketTableId`
 * carries, so a label made against one rendering is never scored against
 * another (U8 emits an empty cell when they differ).
 */
export interface BucketTable {
  id: string;
  range: RangeBoundaries;
  health: LevelBoundaries;
  hunger: LevelBoundaries;
  light: LightBoundaries;
  daylight: DaylightBoundaries;
  items: ItemBoundaries;
}

export const DEFAULT_BUCKETS: BucketTable = {
  id: 'default-v1',
  range: {
    meleeMaxBlocks: MELEE_MAX_BLOCKS,
    bowMaxBlocks: BOW_MAX_BLOCKS,
    farMaxBlocks: FAR_MAX_BLOCKS,
  },
  health: {
    criticalMax: HEALTH_CRITICAL_MAX,
    lowMax: HEALTH_LOW_MAX,
    moderateMax: HEALTH_MODERATE_MAX,
  },
  hunger: {
    criticalMax: HUNGER_CRITICAL_MAX,
    lowMax: HUNGER_LOW_MAX,
    moderateMax: HUNGER_MODERATE_MAX,
  },
  light: {
    darkMax: LIGHT_DARK_MAX,
    dimMax: LIGHT_DIM_MAX,
  },
  daylight: {
    duskStartsAtTicks: DUSK_STARTS_AT_TICKS,
    nightStartsAtTicks: NIGHT_STARTS_AT_TICKS,
    dawnStartsAtTicks: DAWN_STARTS_AT_TICKS,
  },
  items: {
    minFoodForSome: MIN_FOOD_ITEMS_FOR_SOME,
    minBlocksForSome: MIN_BLOCK_ITEMS_FOR_SOME,
    foodNames: FOOD_ITEM_NAMES,
    blockNames: BLOCK_ITEM_NAMES,
    blockSuffixes: BLOCK_ITEM_SUFFIXES,
    meleeWeaponSuffixes: MELEE_WEAPON_SUFFIXES,
  },
};

// ---------------------------------------------------------------------------
// Banding — the comparisons themselves
// ---------------------------------------------------------------------------

/**
 * Boundaries are inclusive upper bounds: a distance exactly at
 * `meleeMaxBlocks` is `melee`, and anything above it is `bow`.
 */
export function rangeBand(distanceInBlocks: number, bounds: RangeBoundaries): RangeBand {
  if (distanceInBlocks <= bounds.meleeMaxBlocks) return 'melee';
  if (distanceInBlocks <= bounds.bowMaxBlocks) return 'bow';
  if (distanceInBlocks <= bounds.farMaxBlocks) return 'far';
  return 'out-of-range';
}

/** Used for both health and hunger; they share `LevelBand` and differ only in bounds. */
export function levelBand(value: number, bounds: LevelBoundaries): LevelBand {
  if (value <= bounds.criticalMax) return 'critical';
  if (value <= bounds.lowMax) return 'low';
  if (value <= bounds.moderateMax) return 'moderate';
  return 'full';
}

export function lightBand(level: number, bounds: LightBoundaries): LightBand {
  if (level <= bounds.darkMax) return 'dark';
  if (level <= bounds.dimMax) return 'dim';
  return 'lit';
}

/**
 * The only cyclic quantity here, so it reads as lower bounds and normalises the
 * tick first: a logged `timeOfDay` of 24000 is tick 0 of the next day, and
 * banding it as `dawn` would put sunrise an entire day late.
 */
export function daylightBand(timeOfDay: number, bounds: DaylightBoundaries): DaylightBand {
  const tick =
    ((timeOfDay % TICKS_PER_MINECRAFT_DAY) + TICKS_PER_MINECRAFT_DAY) % TICKS_PER_MINECRAFT_DAY;
  if (tick >= bounds.dawnStartsAtTicks) return 'dawn';
  if (tick >= bounds.nightStartsAtTicks) return 'night';
  if (tick >= bounds.duskStartsAtTicks) return 'dusk';
  return 'day';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function ascending(label: string, values: readonly (readonly [string, number])[]): void {
  let previous: readonly [string, number] | undefined;
  for (const entry of values) {
    const [name, value] = entry;
    if (!Number.isFinite(value)) {
      throw new Error(`bucket table ${label}.${name} must be a finite number, got ${String(value)}`);
    }
    if (previous && value <= previous[1]) {
      throw new Error(
        `bucket table ${label} boundaries must increase: ${previous[0]} is ${previous[1]} ` +
          `but ${name} is ${value}, which leaves a band no value can ever fall into`,
      );
    }
    previous = entry;
  }
}

/**
 * A sweep supplies tables from a file (R8), and a table whose boundaries are
 * out of order produces a band no value reaches — silently, because every
 * comparison still returns a valid band name. Checking costs nothing beside a
 * model call and turns that into a message naming the two boundaries.
 */
export function assertBucketTable(table: BucketTable): void {
  if (typeof table.id !== 'string' || table.id.length === 0) {
    throw new Error('bucket table must carry a non-empty id; it is logged beside every decision');
  }

  ascending('range', [
    ['meleeMaxBlocks', table.range.meleeMaxBlocks],
    ['bowMaxBlocks', table.range.bowMaxBlocks],
    ['farMaxBlocks', table.range.farMaxBlocks],
  ]);

  for (const [label, bounds] of [
    ['health', table.health],
    ['hunger', table.hunger],
  ] as const) {
    ascending(label, [
      ['criticalMax', bounds.criticalMax],
      ['lowMax', bounds.lowMax],
      ['moderateMax', bounds.moderateMax],
    ]);
  }

  ascending('light', [
    ['darkMax', table.light.darkMax],
    ['dimMax', table.light.dimMax],
  ]);

  ascending('daylight', [
    ['duskStartsAtTicks', table.daylight.duskStartsAtTicks],
    ['nightStartsAtTicks', table.daylight.nightStartsAtTicks],
    ['dawnStartsAtTicks', table.daylight.dawnStartsAtTicks],
  ]);

  for (const [name, value] of [
    ['minFoodForSome', table.items.minFoodForSome],
    ['minBlocksForSome', table.items.minBlocksForSome],
  ] as const) {
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(
        `bucket table items.${name} must be at least 1, got ${String(value)} — a threshold of 0 ` +
          'would report "some" for an empty inventory',
      );
    }
  }
}
