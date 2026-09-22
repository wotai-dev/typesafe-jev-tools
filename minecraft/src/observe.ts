/**
 * `observe(bot)` — the one module on this path that touches mineflayer.
 *
 * It snapshots the raw facts of a moment into a plain JSON `RawObservation`,
 * and it is deliberately the ONLY place a `Bot` appears. Everything downstream
 * — `project()`, `legality()`, replay, the report — consumes that snapshot and
 * runs with no game present (R7, R8). `test/version-pin.test.ts` holds the
 * allowlist that keeps it that way.
 *
 * Three of the captured facts need the block world and cannot be recovered from
 * a log later, so they are captured here rather than derived in `project()`:
 * per-entity line of sight (AE1's `visible` slot), the nearest gatherable
 * resource (U4's `legality('gather')`), and sky access (`legality('shelter')`).
 *
 * The capture is gated. The server sends the health packet just after the spawn
 * event rather than with it, so `bot.health` and `bot.food` are `undefined` for
 * the first moments of every run even though mineflayer's types — and
 * `RawObservation` — declare them `number`. Nothing catches that at compile
 * time, and a projection built from it would band a NaN, so `observe()` returns
 * a not-ready capture until the packet lands instead of manufacturing a row.
 */

import type { Bot } from 'mineflayer';
import { distanceBetween } from './project.ts';
import type {
  Action,
  ObservedEntity,
  ObservedItem,
  ObservedResource,
  RawObservation,
  Vec3,
} from './types.ts';

/** The vec3 instance type, reached through mineflayer so vec3 need not be imported directly. */
type WorldVec3 = Bot['entity']['position'];

/**
 * How far out entities are captured.
 *
 * This is a capture radius, not a bucket boundary, and it must stay well above
 * the largest `farMaxBlocks` any sweep might use: `project()` can re-band a
 * logged entity under a wider table, but it cannot invent one that was never
 * written down. Entities beyond mineflayer's own tracking distance are not
 * loaded at all, so this is a ceiling rather than a promise.
 */
export const ENTITY_SCAN_RADIUS_BLOCKS = 48;

/** How far out a gatherable block is looked for. Same reasoning as above. */
export const GATHER_SCAN_RADIUS_BLOCKS = 32;

/**
 * Blocks worth walking to. Ore first, then wood and stone: `gather` has to mean
 * something a person would call progress, or the action is noise in the label.
 */
export const GATHERABLE_BLOCK_NAMES: readonly string[] = [
  'coal_ore',
  'deepslate_coal_ore',
  'iron_ore',
  'deepslate_iron_ore',
  'copper_ore',
  'deepslate_copper_ore',
  'oak_log',
  'birch_log',
  'spruce_log',
  'jungle_log',
  'acacia_log',
  'dark_oak_log',
  'stone',
  'cobblestone',
];

/**
 * minecraft-data's entity types. Anything outside this list — projectiles,
 * dropped items, experience orbs, paintings — is not a participant in a
 * six-way survival choice and would only add rows to the log.
 */
export const OBSERVED_ENTITY_TYPES: readonly string[] = [
  'hostile',
  'animal',
  'passive',
  'mob',
  'living',
  'ambient',
  'player',
];

/** minecraft-data marks every hostile mob with this type and this category. */
export const HOSTILE_ENTITY_TYPES: readonly string[] = ['hostile'];
export const HOSTILE_ENTITY_CATEGORIES: readonly string[] = ['Hostile mobs'];

/**
 * Sky light stays at 15 outdoors all night — it is the sun's angle that changes,
 * not the value — so a bare `max(blockLight, skyLight)` would report a moonlit
 * field as `lit`. Minecraft subtracts 11 from sky light after dusk when it asks
 * how dark a place is, and so does this.
 */
export const NIGHT_SKY_LIGHT_PENALTY = 11;

/** Above the 1.21 build limit, so an unobstructed ray upward reaches open sky. */
export const WORLD_TOP_Y = 320;

/**
 * mineflayer only sets `oxygenLevel` when the air-supply metadata changes, which
 * is to say when the bot is actually losing air. Not yet reported means full,
 * so this is the real value rather than a placeholder.
 */
export const FULL_OXYGEN = 20;

/**
 * Either a complete observation or the named reasons it is not one yet.
 *
 * A union rather than a nullable return, because "not ready" has to be
 * legible in the loop's log: the alternative is a silently skipped decision
 * that looks identical to a slow tick.
 */
export type Capture =
  | { ready: true; observation: RawObservation }
  | { ready: false; missing: readonly string[] };

function toPlainVec3(position: WorldVec3): Vec3 {
  return { x: position.x, y: position.y, z: position.z };
}

function isHostile(entity: Bot['entity']): boolean {
  return (
    HOSTILE_ENTITY_TYPES.includes(entity.type) ||
    HOSTILE_ENTITY_CATEGORIES.includes(entity.kind ?? '')
  );
}

/**
 * Whether the bot can actually see a target, by raycasting from its eyes.
 *
 * An unloaded chunk along the ray throws rather than answering, and the honest
 * answer there is "cannot see it": claiming visibility the bot does not have
 * would put `visible: true` beside a threat it has no shot at.
 */
function canSee(bot: Bot, eye: WorldVec3, target: Bot['entity']): boolean {
  try {
    const centre = target.position.offset(0, (target.height || 1) / 2, 0);
    const range = eye.distanceTo(centre);
    if (!(range > 0)) return true;
    return bot.world.raycast(eye, centre.minus(eye).normalize(), range) === null;
  } catch {
    return false;
  }
}

function hasOpenSky(bot: Bot, eye: WorldVec3): boolean {
  try {
    const headroom = WORLD_TOP_Y - eye.y;
    if (headroom <= 0) return true;
    // A unit +Y vector derived from an existing instance: `vec3` is mineflayer's
    // dependency rather than this package's, so its constructor is not imported.
    const up = eye.offset(0, 1, 0).minus(eye);
    return bot.world.raycast(eye, up, headroom) === null;
  } catch {
    return false;
  }
}

function lightAt(bot: Bot, position: WorldVec3): number {
  try {
    const block = position.floored();
    const blockLight = bot.world.getBlockLight(block);
    const skyLight = bot.world.getSkyLight(block);
    const fromSky = bot.time.isDay ? skyLight : skyLight - NIGHT_SKY_LIGHT_PENALTY;
    const level = Math.max(Number.isFinite(blockLight) ? blockLight : 0, fromSky);
    return Number.isFinite(level) ? Math.max(0, level) : 0;
  } catch {
    // An unreadable chunk reports dark, which is the cautious direction: it
    // makes shelter look reasonable rather than making a cave look safe.
    return 0;
  }
}

function nearestResource(bot: Bot, self: Vec3): ObservedResource | null {
  const ids: number[] = [];
  for (const name of GATHERABLE_BLOCK_NAMES) {
    const id = bot.registry.blocksByName[name]?.id;
    if (typeof id === 'number') ids.push(id);
  }
  if (ids.length === 0) return null;

  const block = bot.findBlock({ matching: ids, maxDistance: GATHER_SCAN_RADIUS_BLOCKS });
  if (!block) return null;

  const position = toPlainVec3(block.position);
  return { name: block.name, position, distance: distanceBetween(self, position) };
}

function observedEntities(bot: Bot, self: Vec3, eye: WorldVec3): ObservedEntity[] {
  const observed: ObservedEntity[] = [];

  for (const entity of Object.values(bot.entities)) {
    if (!entity || entity.id === bot.entity.id || !entity.position) continue;
    if (!OBSERVED_ENTITY_TYPES.includes(entity.type)) continue;

    const kind = entity.name ?? entity.username;
    if (!kind) continue;

    const position = toPlainVec3(entity.position);
    const distance = distanceBetween(self, position);
    if (!Number.isFinite(distance) || distance > ENTITY_SCAN_RADIUS_BLOCKS) continue;

    observed.push({
      kind,
      disposition: isHostile(entity) ? 'hostile' : 'passive',
      position,
      distance,
      hasLineOfSight: canSee(bot, eye, entity),
    });
  }

  return observed;
}

function inventoryOf(bot: Bot): ObservedItem[] {
  return bot.inventory.items().map((item) => ({ name: item.name, count: item.count }));
}

/**
 * Snapshot the moment, or say what is still missing.
 *
 * @param previousAction the action already executing. It is a logged input
 *   rather than loop state, so replay can re-derive the confidence override
 *   from the record alone (KTD2).
 */
export function observe(bot: Bot, previousAction: Action | null): Capture {
  const missing: string[] = [];

  const self: Bot['entity'] | undefined = bot.entity;
  if (!self?.position) missing.push('position');
  if (!Number.isFinite(bot.health)) missing.push('health');
  if (!Number.isFinite(bot.food)) missing.push('food');
  if (!Number.isFinite(bot.time?.timeOfDay)) missing.push('timeOfDay');

  if (!self?.position || missing.length > 0) return { ready: false, missing };

  const position = toPlainVec3(self.position);
  const eye = self.position.offset(0, self.height || 1, 0);

  return {
    ready: true,
    observation: {
      tick: bot.time.age,
      capturedAt: new Date().toISOString(),
      position,
      health: bot.health,
      food: bot.food,
      oxygen: Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : FULL_OXYGEN,
      timeOfDay: bot.time.timeOfDay,
      lightLevel: lightAt(bot, self.position),
      inventory: inventoryOf(bot),
      entities: observedEntities(bot, position, eye),
      nearestResource: nearestResource(bot, position),
      hasSkyAccess: hasOpenSky(bot, eye),
      previousAction,
    },
  };
}
