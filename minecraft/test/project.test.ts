import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOW_MAX_BLOCKS,
  DEFAULT_BUCKETS,
  FAR_MAX_BLOCKS,
  HEALTH_CRITICAL_MAX,
  HEALTH_LOW_MAX,
  HEALTH_MODERATE_MAX,
  HUNGER_CRITICAL_MAX,
  HUNGER_LOW_MAX,
  HUNGER_MODERATE_MAX,
  LIGHT_DARK_MAX,
  LIGHT_DIM_MAX,
  MELEE_MAX_BLOCKS,
  DAWN_STARTS_AT_TICKS,
  DUSK_STARTS_AT_TICKS,
  NIGHT_STARTS_AT_TICKS,
  TICKS_PER_MINECRAFT_DAY,
  type BucketTable,
} from '../src/buckets.ts';
import { ProjectionError, project } from '../src/project.ts';
import type { ObservedEntity, ObservedItem, RawObservation, RequestState } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A quiet moment: full health, full hunger, daylight, nothing nearby. Every
 * test below is this observation with one thing changed, so what a test is
 * about is the line that differs from here.
 */
const QUIET: RawObservation = {
  tick: 1234,
  capturedAt: '2026-09-21T12:00:00.000Z',
  position: { x: 0, y: 64, z: 0 },
  health: 20,
  food: 20,
  oxygen: 20,
  timeOfDay: 1000,
  lightLevel: 15,
  inventory: [],
  entities: [],
  nearestResource: null,
  hasSkyAccess: true,
  previousAction: null,
};

function observation(overrides: Partial<RawObservation> = {}): RawObservation {
  return { ...QUIET, ...overrides };
}

/**
 * A mob placed along +x, so the straight-line distance is exactly the number
 * asked for: `Math.hypot(d, 0, 0)` is `d` with no rounding for the integers the
 * boundary cases use.
 */
function entity(
  kind: string,
  disposition: ObservedEntity['disposition'],
  distance: number,
  hasLineOfSight = true,
): ObservedEntity {
  return {
    kind,
    disposition,
    position: { x: QUIET.position.x + distance, y: QUIET.position.y, z: QUIET.position.z },
    distance,
    hasLineOfSight,
  };
}

function item(name: string, count = 1): ObservedItem {
  return { name, count };
}

/** The slots Jev is shown, in the order `RequestState` declares them. */
const SLOTS: readonly (keyof RequestState)[] = [
  'nearestThreat',
  'otherThreats',
  'health',
  'hunger',
  'light',
  'daylight',
  'foodInInventory',
  'blocks',
  'weapon',
  'gatherable',
  'previousAction',
];

// ---------------------------------------------------------------------------
// AE1 — the acceptance example, in full
// ---------------------------------------------------------------------------

test('a skeleton 9.2 blocks away with line of sight reaches Jev as a band, not a number', () => {
  const state = project(observation({ entities: [entity('skeleton', 'hostile', 9.2)] }));

  assert.deepEqual(state.nearestThreat, { kind: 'skeleton', range: 'bow', visible: true });

  const serialised = JSON.stringify(state);
  assert.ok(!serialised.includes('9.2'), `the raw distance survived into the state: ${serialised}`);
  assert.ok(!serialised.includes('9'), `a digit of the raw distance survived: ${serialised}`);
});

test('no digit survives anywhere in a fully populated state', () => {
  const state = project(
    observation({
      health: 7,
      food: 13,
      lightLevel: 4,
      timeOfDay: 18000,
      entities: [
        entity('zombie', 'hostile', 3),
        entity('skeleton', 'hostile', 12),
        entity('creeper', 'hostile', 20),
        entity('cow', 'passive', 6),
      ],
      inventory: [item('bread', 3), item('oak_planks', 64), item('iron_sword')],
      nearestResource: { name: 'iron_ore', position: { x: 0, y: 58, z: 0 }, distance: 6 },
      previousAction: 'gather',
    }),
  );

  // Every slot is populated, so this is the strongest form of the scan: not one
  // character in the whole request state is a digit. `kind` is the only
  // free-form field and it is covered too.
  for (const slot of SLOTS) {
    assert.notEqual(state[slot], undefined, `slot ${slot} is missing`);
  }
  assert.doesNotMatch(
    JSON.stringify(state),
    /[0-9]/,
    'a number reached the state; R3 says every quantity is computed in code and sent as a band',
  );
});

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

const RANGE_PAIRS = [
  { boundary: MELEE_MAX_BLOCKS, lower: 'melee', upper: 'bow' },
  { boundary: BOW_MAX_BLOCKS, lower: 'bow', upper: 'far' },
  { boundary: FAR_MAX_BLOCKS, lower: 'far', upper: 'out-of-range' },
] as const;

test('each range boundary bands as the lower band at the boundary and the upper band past it', () => {
  for (const { boundary, lower, upper } of RANGE_PAIRS) {
    const at = project(observation({ entities: [entity('zombie', 'hostile', boundary)] }));
    const past = project(observation({ entities: [entity('zombie', 'hostile', boundary + 1)] }));

    assert.deepEqual(at.nearestThreat, { kind: 'zombie', range: lower, visible: true });
    assert.deepEqual(past.nearestThreat, { kind: 'zombie', range: upper, visible: true });
  }
});

test('the gatherable slot uses the same range boundaries as a threat', () => {
  for (const { boundary, lower, upper } of RANGE_PAIRS) {
    const atPosition = { x: boundary, y: QUIET.position.y, z: 0 };
    const pastPosition = { x: boundary + 1, y: QUIET.position.y, z: 0 };

    assert.equal(
      project(
        observation({
          nearestResource: { name: 'oak_log', position: atPosition, distance: boundary },
        }),
      ).gatherable,
      lower,
    );
    assert.equal(
      project(
        observation({
          nearestResource: { name: 'oak_log', position: pastPosition, distance: boundary + 1 },
        }),
      ).gatherable,
      upper,
    );
  }
});

test('each health boundary bands as the lower band at the boundary and the upper band past it', () => {
  const pairs = [
    { boundary: HEALTH_CRITICAL_MAX, lower: 'critical', upper: 'low' },
    { boundary: HEALTH_LOW_MAX, lower: 'low', upper: 'moderate' },
    { boundary: HEALTH_MODERATE_MAX, lower: 'moderate', upper: 'full' },
  ] as const;

  for (const { boundary, lower, upper } of pairs) {
    assert.equal(project(observation({ health: boundary })).health, lower);
    assert.equal(project(observation({ health: boundary + 1 })).health, upper);
  }
});

test('each hunger boundary bands as the lower band at the boundary and the upper band past it', () => {
  const pairs = [
    { boundary: HUNGER_CRITICAL_MAX, lower: 'critical', upper: 'low' },
    { boundary: HUNGER_LOW_MAX, lower: 'low', upper: 'moderate' },
    { boundary: HUNGER_MODERATE_MAX, lower: 'moderate', upper: 'full' },
  ] as const;

  for (const { boundary, lower, upper } of pairs) {
    assert.equal(project(observation({ food: boundary })).hunger, lower);
    assert.equal(project(observation({ food: boundary + 1 })).hunger, upper);
  }
});

test('each light boundary bands as the lower band at the boundary and the upper band past it', () => {
  assert.equal(project(observation({ lightLevel: LIGHT_DARK_MAX })).light, 'dark');
  assert.equal(project(observation({ lightLevel: LIGHT_DARK_MAX + 1 })).light, 'dim');
  assert.equal(project(observation({ lightLevel: LIGHT_DIM_MAX })).light, 'dim');
  assert.equal(project(observation({ lightLevel: LIGHT_DIM_MAX + 1 })).light, 'lit');
});

test('the day/night boundaries band at their start tick, and the cycle wraps', () => {
  assert.equal(project(observation({ timeOfDay: 0 })).daylight, 'day');
  assert.equal(project(observation({ timeOfDay: DUSK_STARTS_AT_TICKS - 1 })).daylight, 'day');
  assert.equal(project(observation({ timeOfDay: DUSK_STARTS_AT_TICKS })).daylight, 'dusk');
  assert.equal(project(observation({ timeOfDay: NIGHT_STARTS_AT_TICKS - 1 })).daylight, 'dusk');
  assert.equal(project(observation({ timeOfDay: NIGHT_STARTS_AT_TICKS })).daylight, 'night');
  assert.equal(project(observation({ timeOfDay: DAWN_STARTS_AT_TICKS - 1 })).daylight, 'night');
  assert.equal(project(observation({ timeOfDay: DAWN_STARTS_AT_TICKS })).daylight, 'dawn');

  // Tick 24000 is the next day's sunrise, not a day-late dawn.
  assert.equal(project(observation({ timeOfDay: TICKS_PER_MINECRAFT_DAY })).daylight, 'day');
  assert.equal(
    project(observation({ timeOfDay: TICKS_PER_MINECRAFT_DAY + NIGHT_STARTS_AT_TICKS })).daylight,
    'night',
  );
});

// ---------------------------------------------------------------------------
// Fixed slots and explicit absence (KTD4)
// ---------------------------------------------------------------------------

test('no entities loaded projects to the string "none", not null and not a missing key', () => {
  const state = project(observation({ entities: [] }));

  assert.ok('nearestThreat' in state, 'the slot must be present even with nothing in it');
  assert.equal(state.nearestThreat, 'none');
  assert.notEqual(state.nearestThreat, null);
  assert.equal(state.otherThreats, 'none');
  assert.equal(state.gatherable, 'none');
  assert.equal(state.previousAction, 'none');
});

test('every slot is present on every row, whatever the observation held', () => {
  const states = [
    project(observation()),
    project(
      observation({
        entities: [entity('creeper', 'hostile', 2, false)],
        inventory: [item('bread'), item('dirt', 12), item('stone_axe')],
        nearestResource: { name: 'coal_ore', position: { x: 3, y: 64, z: 0 }, distance: 3 },
        previousAction: 'flee',
      }),
    ),
  ];

  for (const state of states) {
    assert.deepEqual(
      Object.keys(state).sort(),
      [...SLOTS].sort(),
      'rows must be structurally identical, so a label is never read against a different shape',
    );
  }
});

test('an empty inventory projects to explicit "none" food, block and weapon slots', () => {
  const state = project(observation({ inventory: [] }));

  assert.equal(state.foodInInventory, 'none');
  assert.equal(state.blocks, 'none');
  assert.equal(state.weapon, 'none');
});

test('carried food, placeable blocks and a melee weapon each project to their own slot', () => {
  const state = project(
    observation({ inventory: [item('cooked_beef', 2), item('birch_planks', 30), item('iron_sword')] }),
  );

  assert.equal(state.foodInInventory, 'some');
  assert.equal(state.blocks, 'some');
  assert.equal(state.weapon, 'melee');
});

test('carried food and satiation are separate slots, and a full stomach does not imply supplies', () => {
  // `hunger` is satiation; `foodInInventory` is what is carried. The two are
  // deliberately distinct, and this is the case that separates them.
  const state = project(observation({ food: 20, inventory: [item('oak_planks', 8)] }));

  assert.equal(state.hunger, 'full');
  assert.equal(state.foodInInventory, 'none');
  assert.equal(state.blocks, 'some');
});

test('a pickaxe is not a weapon and a torch is not a block', () => {
  const state = project(observation({ inventory: [item('iron_pickaxe'), item('torch', 16)] }));

  assert.equal(state.weapon, 'none');
  assert.equal(state.blocks, 'none');
});

// ---------------------------------------------------------------------------
// Threat selection
// ---------------------------------------------------------------------------

test('full health and full hunger reach their top bands, and zero health the bottom one', () => {
  const full = project(observation({ health: 20, food: 20 }));
  assert.equal(full.health, 'full');
  assert.equal(full.hunger, 'full');

  const dead = project(observation({ health: 0, food: 0 }));
  assert.equal(dead.health, 'critical');
  assert.equal(dead.hunger, 'critical');
});

test('the nearest hostile fills the slot, whatever order the entities were captured in', () => {
  const state = project(
    observation({
      entities: [
        entity('creeper', 'hostile', 20),
        entity('zombie', 'hostile', 3),
        entity('skeleton', 'hostile', 10),
      ],
    }),
  );

  assert.deepEqual(state.nearestThreat, { kind: 'zombie', range: 'melee', visible: true });
});

test('passive mobs are never threats', () => {
  const state = project(
    observation({ entities: [entity('cow', 'passive', 2), entity('sheep', 'passive', 3)] }),
  );

  assert.equal(state.nearestThreat, 'none');
  assert.equal(state.otherThreats, 'none');
});

test('other threats are counted besides the nearest, and stop being counted at three', () => {
  const hostiles = [
    entity('zombie', 'hostile', 3),
    entity('skeleton', 'hostile', 9),
    entity('creeper', 'hostile', 12),
    entity('spider', 'hostile', 14),
  ];

  assert.equal(project(observation({ entities: hostiles.slice(0, 1) })).otherThreats, 'none');
  assert.equal(project(observation({ entities: hostiles.slice(0, 2) })).otherThreats, 'one-more');
  assert.equal(project(observation({ entities: hostiles.slice(0, 3) })).otherThreats, 'several');
  assert.equal(project(observation({ entities: hostiles })).otherThreats, 'several');
});

test('line of sight is carried through from the observation, not re-derived', () => {
  const blind = project(observation({ entities: [entity('skeleton', 'hostile', 9.2, false)] }));

  assert.deepEqual(blind.nearestThreat, { kind: 'skeleton', range: 'bow', visible: false });
});

test('the band follows the logged positions, not the distance captured beside them', () => {
  // `project()` recomputes distance from the logged geometry so that a sweep is
  // a function of the raw observation alone. A fixture whose captured
  // `distance` disagrees with its position is the case that pins that down.
  const far = entity('skeleton', 'hostile', 30);
  const lying: ObservedEntity = { ...far, distance: 1 };

  assert.deepEqual(project(observation({ entities: [lying] })).nearestThreat, {
    kind: 'skeleton',
    range: 'far',
    visible: true,
  });
});

test('the previous action is carried through, and its absence is the string "none"', () => {
  assert.equal(project(observation({ previousAction: 'shelter' })).previousAction, 'shelter');
  assert.equal(project(observation({ previousAction: null })).previousAction, 'none');
});

// ---------------------------------------------------------------------------
// R8 / AE4 — the boundaries are genuinely parameterised
// ---------------------------------------------------------------------------

test('one observation under two bucket tables yields two different states', () => {
  // AE4: a log written with `bow` spanning 4-16 blocks, re-projected with `bow`
  // spanning 5-20, moves the row whose threat sat at 4.3 blocks into `melee`.
  const shifted: BucketTable = {
    ...DEFAULT_BUCKETS,
    id: 'wider-melee-v1',
    range: { meleeMaxBlocks: 5, bowMaxBlocks: 20, farMaxBlocks: 40 },
  };

  const raw = observation({ entities: [entity('skeleton', 'hostile', 4.3)] });

  const asLogged = project(raw, DEFAULT_BUCKETS);
  const asSwept = project(raw, shifted);

  assert.deepEqual(asLogged.nearestThreat, { kind: 'skeleton', range: 'bow', visible: true });
  assert.deepEqual(asSwept.nearestThreat, { kind: 'skeleton', range: 'melee', visible: true });
  assert.notDeepEqual(asLogged, asSwept);
});

test('a sweep can move a level band without touching the observation', () => {
  const stricter: BucketTable = {
    ...DEFAULT_BUCKETS,
    id: 'cautious-health-v1',
    health: { criticalMax: 10, lowMax: 16, moderateMax: 19 },
  };

  const raw = observation({ health: 8 });

  assert.equal(project(raw, DEFAULT_BUCKETS).health, 'low');
  assert.equal(project(raw, stricter).health, 'critical');
});

test('a bucket table whose boundaries do not increase is refused, not silently applied', () => {
  const broken: BucketTable = {
    ...DEFAULT_BUCKETS,
    id: 'broken-v1',
    range: { meleeMaxBlocks: 16, bowMaxBlocks: 4, farMaxBlocks: 32 },
  };

  assert.throws(
    () => project(observation(), broken),
    /boundaries must increase/,
    'an out-of-order table leaves a band no value can reach, and every band name stays valid',
  );
});

test('a bucket table with no id is refused, because the id is what labels are matched on', () => {
  assert.throws(() => project(observation(), { ...DEFAULT_BUCKETS, id: '' }), /non-empty id/);
});

// ---------------------------------------------------------------------------
// The spawn-time health gap (#3)
// ---------------------------------------------------------------------------

test('an observation captured before the health packet arrives is refused, not banded', () => {
  // The server sends health just after the spawn event. `RawObservation`
  // declares `health: number` and so does mineflayer, so this assignment
  // compiles; the cast here is what the runtime actually hands over.
  const preSpawn = observation({
    health: undefined as unknown as number,
    food: undefined as unknown as number,
  });

  assert.throws(() => project(preSpawn), ProjectionError);
  assert.throws(
    () => project(preSpawn),
    /health is undefined/,
    'the message must name the field, because the loop logs it and the fix is to wait',
  );
});

test('a non-finite health or food is refused rather than banded to whatever compares true', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null as unknown as number]) {
    assert.throws(
      () => project(observation({ health: bad })),
      ProjectionError,
      `health ${String(bad)} must not project`,
    );
    assert.throws(
      () => project(observation({ food: bad })),
      ProjectionError,
      `food ${String(bad)} must not project`,
    );
  }

  // NaN in particular: every comparison against it is false, so the level chain
  // would fall through to `full` and the row would claim the bot is fine.
  assert.notEqual(
    (() => {
      try {
        return project(observation({ health: Number.NaN })).health;
      } catch {
        return 'refused';
      }
    })(),
    'full',
  );
});

test('a non-finite light level or time of day is refused too', () => {
  assert.throws(() => project(observation({ lightLevel: Number.NaN })), ProjectionError);
  assert.throws(() => project(observation({ timeOfDay: Number.NaN })), ProjectionError);
});

test('an entity or resource with no usable position is refused, naming which one', () => {
  const ghost: ObservedEntity = {
    ...entity('skeleton', 'hostile', 9.2),
    position: { x: Number.NaN, y: 64, z: 0 },
  };

  assert.throws(() => project(observation({ entities: [ghost] })), /skeleton/);
  assert.throws(
    () =>
      project(
        observation({
          nearestResource: {
            name: 'iron_ore',
            position: { x: 0, y: Number.NaN, z: 0 },
            distance: 4,
          },
        }),
      ),
    /iron_ore/,
  );
});

test('an item with a non-finite count is refused rather than counted as nothing', () => {
  assert.throws(
    () => project(observation({ inventory: [item('bread', Number.NaN)] })),
    /bread/,
    'NaN would sum to NaN, compare false, and report "none" food while the bot is holding some',
  );
});
