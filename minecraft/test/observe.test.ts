import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'mineflayer';

import { FULL_OXYGEN, NIGHT_SKY_LIGHT_PENALTY, observe } from '../src/observe.ts';
import { project } from '../src/project.ts';

/**
 * `observe()` is the one module that holds a `Bot`, so it is the one module
 * that cannot be tested against the real thing without a server — and #3's
 * finding is precisely about a moment (the tick after spawn) that a live smoke
 * check races past. The bot below is a stand-in for the surface `observe()`
 * reads, and these tests pin its contract: what it refuses, what it carries
 * through, and what it computes. Whether mineflayer really behaves this way is
 * a separate question that only a live run answers, and U5 runs one.
 */

class FakeVec3 {
  x: number;
  y: number;
  z: number;

  constructor(x: number, y: number, z: number) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  offset(dx: number, dy: number, dz: number): FakeVec3 {
    return new FakeVec3(this.x + dx, this.y + dy, this.z + dz);
  }

  minus(other: FakeVec3): FakeVec3 {
    return new FakeVec3(this.x - other.x, this.y - other.y, this.z - other.z);
  }

  normalize(): FakeVec3 {
    const length = Math.hypot(this.x, this.y, this.z) || 1;
    return new FakeVec3(this.x / length, this.y / length, this.z / length);
  }

  distanceTo(other: FakeVec3): number {
    return Math.hypot(other.x - this.x, other.y - this.y, other.z - this.z);
  }

  floored(): FakeVec3 {
    return new FakeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z));
  }
}

interface FakeEntity {
  id: number;
  type: string;
  name?: string;
  username?: string;
  kind?: string;
  height: number;
  position: FakeVec3;
}

interface FakeBotOptions {
  health?: number | undefined;
  food?: number | undefined;
  oxygenLevel?: number | undefined;
  timeOfDay?: number;
  isDay?: boolean;
  entity?: FakeEntity | undefined;
  others?: FakeEntity[];
  items?: { name: string; count: number }[];
  blockLight?: number;
  skyLight?: number;
  /** `null` is a clear ray; anything else is something in the way. */
  raycastHit?: unknown;
  resourceAt?: FakeVec3 | null;
}

const SELF: FakeEntity = {
  id: 1,
  type: 'player',
  name: 'player',
  height: 1.8,
  position: new FakeVec3(0, 64, 0),
};

function mob(id: number, name: string, type: string, x: number, kind?: string): FakeEntity {
  return {
    id,
    type,
    name,
    height: 1.8,
    position: new FakeVec3(x, 64, 0),
    ...(kind === undefined ? {} : { kind }),
  };
}

function fakeBot(options: FakeBotOptions = {}): Bot {
  const self = 'entity' in options ? options.entity : SELF;
  const entities: Record<string, FakeEntity> = {};
  if (self) entities[String(self.id)] = self;
  for (const other of options.others ?? []) entities[String(other.id)] = other;

  const resource = options.resourceAt;

  return {
    entity: self,
    entities,
    health: 'health' in options ? options.health : 20,
    food: 'food' in options ? options.food : 20,
    oxygenLevel: 'oxygenLevel' in options ? options.oxygenLevel : 20,
    time: {
      timeOfDay: options.timeOfDay ?? 1000,
      age: 4242,
      isDay: options.isDay ?? true,
    },
    inventory: { items: () => options.items ?? [] },
    world: {
      raycast: () => options.raycastHit ?? null,
      getBlockLight: () => options.blockLight ?? 0,
      getSkyLight: () => options.skyLight ?? 15,
    },
    registry: { blocksByName: { iron_ore: { id: 73 }, oak_log: { id: 17 } } },
    findBlock: () =>
      resource ? { name: 'iron_ore', position: resource } : null,
  } as unknown as Bot;
}

function ready(capture: ReturnType<typeof observe>) {
  assert.equal(capture.ready, true, 'expected a complete capture');
  if (!capture.ready) throw new Error('unreachable');
  return capture.observation;
}

// ---------------------------------------------------------------------------
// The spawn-time health gap (#3)
// ---------------------------------------------------------------------------

test('a capture before the health packet arrives is refused, and names what is missing', () => {
  // The exact shape of the finding on #3: at the spawn event mineflayer's own
  // types say `health: number`, and the value is `undefined`.
  const capture = observe(fakeBot({ health: undefined, food: undefined }), null);

  assert.equal(capture.ready, false);
  if (capture.ready) throw new Error('unreachable');
  assert.deepEqual([...capture.missing], ['health', 'food']);
});

test('a capture before the bot has an entity at all is refused', () => {
  const capture = observe(fakeBot({ entity: undefined }), null);

  assert.equal(capture.ready, false);
  if (capture.ready) throw new Error('unreachable');
  assert.ok(capture.missing.includes('position'));
});

test('no state can be projected from a pre-spawn capture, because none is produced', () => {
  const capture = observe(fakeBot({ health: undefined }), null);

  assert.equal(capture.ready, false);
  // There is nothing to hand `project()`, which is the point: the refusal
  // happens before a row exists rather than after one is in the log.
  assert.ok(!('observation' in capture));
});

test('once health has arrived the same bot captures cleanly and the state projects', () => {
  const observation = ready(observe(fakeBot({ health: 14, food: 9 }), 'gather'));

  assert.equal(observation.health, 14);
  assert.equal(observation.food, 9);
  assert.equal(observation.previousAction, 'gather');
  assert.equal(observation.tick, 4242);

  const state = project(observation);
  assert.equal(state.health, 'moderate');
  assert.equal(state.hunger, 'low');
  assert.equal(state.previousAction, 'gather');
});

// ---------------------------------------------------------------------------
// What the snapshot contains
// ---------------------------------------------------------------------------

test('hostile and passive mobs are classified, and the bot itself is not an entity', () => {
  const observation = ready(
    observe(
      fakeBot({
        others: [
          mob(2, 'skeleton', 'hostile', 9.2, 'Hostile mobs'),
          mob(3, 'cow', 'animal', 4, 'Passive mobs'),
        ],
      }),
      null,
    ),
  );

  assert.deepEqual(
    observation.entities.map((e) => [e.kind, e.disposition]),
    [
      ['skeleton', 'hostile'],
      ['cow', 'passive'],
    ],
  );
  assert.ok(
    !observation.entities.some((e) => e.kind === 'player'),
    'the bot must not observe itself as a nearby entity',
  );

  assert.deepEqual(project(observation).nearestThreat, {
    kind: 'skeleton',
    range: 'bow',
    visible: true,
  });
});

test('projectiles, dropped items and orbs are left out of the observation', () => {
  const observation = ready(
    observe(
      fakeBot({
        others: [
          mob(2, 'arrow', 'projectile', 3),
          mob(3, 'item', 'other', 2),
          mob(4, 'experience_orb', 'other', 2),
          mob(5, 'zombie', 'hostile', 3, 'Hostile mobs'),
        ],
      }),
      null,
    ),
  );

  assert.deepEqual(
    observation.entities.map((e) => e.kind),
    ['zombie'],
  );
});

test('entities past the capture radius are not written down', () => {
  const observation = ready(
    observe(fakeBot({ others: [mob(2, 'creeper', 'hostile', 400, 'Hostile mobs')] }), null),
  );

  assert.deepEqual(observation.entities, []);
});

test('a blocked ray records no line of sight rather than claiming one', () => {
  const observation = ready(
    observe(
      fakeBot({
        others: [mob(2, 'skeleton', 'hostile', 9.2, 'Hostile mobs')],
        raycastHit: { name: 'stone' },
      }),
      null,
    ),
  );

  assert.equal(observation.entities[0]?.hasLineOfSight, false);
  assert.equal(observation.hasSkyAccess, false, 'a ray that hits something is not open sky');
  assert.deepEqual(project(observation).nearestThreat, {
    kind: 'skeleton',
    range: 'bow',
    visible: false,
  });
});

test('the captured distance agrees with the one the projection re-derives', () => {
  const observation = ready(
    observe(fakeBot({ others: [mob(2, 'zombie', 'hostile', 7, 'Hostile mobs')] }), null),
  );

  // Both come from the same function, so this is equality and not closeness.
  // A drift here would move the band Jev sees away from the band the reflex
  // layer and `legality()` act on.
  assert.equal(observation.entities[0]?.distance, 7);
});

test('sky light is discounted at night, so a moonlit field is not reported as lit', () => {
  const day = ready(observe(fakeBot({ isDay: true, skyLight: 15, blockLight: 0 }), null));
  const night = ready(observe(fakeBot({ isDay: false, skyLight: 15, blockLight: 0 }), null));

  assert.equal(day.lightLevel, 15);
  assert.equal(night.lightLevel, 15 - NIGHT_SKY_LIGHT_PENALTY);
  assert.equal(project(day).light, 'lit');
  assert.equal(project(night).light, 'dim');
});

test('a torch-lit cave reads by its block light, not by the sky it cannot see', () => {
  const observation = ready(observe(fakeBot({ isDay: true, skyLight: 0, blockLight: 12 }), null));

  assert.equal(observation.lightLevel, 12);
  assert.equal(project(observation).light, 'lit');
});

test('the inventory is carried through as names and counts', () => {
  const observation = ready(
    observe(fakeBot({ items: [{ name: 'bread', count: 3 }, { name: 'dirt', count: 64 }] }), null),
  );

  assert.deepEqual(observation.inventory, [
    { name: 'bread', count: 3 },
    { name: 'dirt', count: 64 },
  ]);
  const state = project(observation);
  assert.equal(state.foodInInventory, 'some');
  assert.equal(state.blocks, 'some');
});

test('the nearest gatherable block is captured with its position, so gather stays checkable offline', () => {
  const observation = ready(observe(fakeBot({ resourceAt: new FakeVec3(0, 58, 0) }), null));

  assert.deepEqual(observation.nearestResource, {
    name: 'iron_ore',
    position: { x: 0, y: 58, z: 0 },
    distance: 6,
  });
  // `gatherable` reuses `RangeBand`, so a block six blocks down reads as `bow`.
  // The band names are threat-flavoured; the boundaries are what they mean.
  assert.equal(project(observation).gatherable, 'bow');
});

test('no gatherable block in range projects to the string "none"', () => {
  const observation = ready(observe(fakeBot({ resourceAt: null }), null));

  assert.equal(observation.nearestResource, null);
  assert.equal(project(observation).gatherable, 'none');
});

test('positions are captured as plain JSON, so a logged row round-trips', () => {
  const observation = ready(
    observe(fakeBot({ others: [mob(2, 'zombie', 'hostile', 5, 'Hostile mobs')] }), null),
  );

  const roundTripped = JSON.parse(JSON.stringify(observation)) as typeof observation;
  assert.deepEqual(roundTripped, observation);
  assert.deepEqual(project(roundTripped), project(observation));
});

test('an unreported oxygen level means full air, not a missing capture', () => {
  // mineflayer only sets `oxygenLevel` when the air-supply metadata changes,
  // which is to say when the bot is losing air. Gating the capture on it would
  // stall the loop for a bot that simply never went underwater.
  const observation = ready(observe(fakeBot({ oxygenLevel: undefined }), null));

  assert.equal(observation.oxygen, FULL_OXYGEN);
});
