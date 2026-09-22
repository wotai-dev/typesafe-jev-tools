import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/**
 * The compose file pins a Minecraft version because mineflayer only speaks
 * protocols it has been tested against. That pin is a fact about a dependency,
 * so on upgrade it goes stale silently rather than failing visibly -- which is
 * exactly the shape of thing worth asserting instead of checking by hand once.
 *
 * A note for anyone reading the plan alongside this: the plan says to read
 * `mineflayer.supportedVersions`. That property does not exist on mineflayer
 * 4.39.0. The real accessor is `testedVersions`.
 */
const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');

function composeValue(key: string): string | undefined {
  return compose.match(new RegExp(`^\\s*${key}:\\s*"([^"]+)"`, 'm'))?.[1];
}

test('the pinned Minecraft version is one mineflayer has been tested against', () => {
  const { testedVersions } = require_('mineflayer') as { testedVersions: string[] };
  assert.ok(
    Array.isArray(testedVersions) && testedVersions.length > 0,
    'mineflayer should expose a non-empty testedVersions array',
  );

  const pin = composeValue('VERSION');
  assert.ok(pin, 'docker-compose.yml must pin a VERSION');
  assert.ok(
    testedVersions.includes(pin),
    `docker-compose.yml pins Minecraft ${pin}, which is not in mineflayer's testedVersions ` +
      `(${testedVersions.join(', ')}). Either pin a tested version or upgrade mineflayer.`,
  );
});

test('the compose file holds the stated measurement confounds constant', () => {
  const fixed: ReadonlyArray<readonly [string, string]> = [
    ['ONLINE_MODE', 'false'],
    ['DIFFICULTY', 'normal'],
    ['MODE', 'survival'],
    // The exact value, not just "some digits". A different fixed seed is a
    // different world, which silently invalidates the recorded spawn position
    // and every cross-run comparison against the published run.
    ['SEED', '8675309'],
  ];

  for (const [key, expected] of fixed) {
    const actual = composeValue(key);
    assert.ok(actual, `docker-compose.yml must set ${key}`);
    assert.equal(
      actual,
      expected,
      `${key} is a confound this measurement holds constant and must be ${expected}`,
    );
  }

  // The image tag is a confound too: a floating tag would change the server
  // under a fixed Minecraft version.
  const image = compose.match(/^\s*image:\s*(\S+)/m)?.[1];
  assert.ok(image, 'docker-compose.yml must pin an image');
  assert.doesNotMatch(image, /:latest$|^[^:]+$/, `image must be pinned to a tag, got "${image}"`);

  // ONLINE_MODE is false and OPS grants op on login, so a 0.0.0.0 publish
  // would hand operator to anyone who can reach this machine on 25565.
  assert.match(
    compose,
    /^\s*-\s*"127\.0\.0\.1:25565:25565"/m,
    'the server port must be bound to loopback, not published on all interfaces',
  );
});

/**
 * The invariant the whole design rests on: apart from the one module that
 * captures observations, the projection and reporting path never imports
 * mineflayer, so replay and the report run with no game present. A doc comment
 * cannot enforce that, and the later gate that runs replay with the container
 * stopped cannot detect a leak either -- importing mineflayer does not require
 * a server, so a leaked import passes that gate and surfaces much later as a
 * hang or a wrong number.
 *
 * `observe.ts` is the exception by design: something has to hold the `Bot`, and
 * concentrating that in one module is exactly what keeps the rest of the path
 * pure. It is an allowlist rather than a blanket exemption, because the failure
 * this test exists to catch is a second module quietly joining it.
 */
const MINEFLAYER_ALLOWED: readonly string[] = ['observe.ts'];

const SRC_DIR = new URL('../src/', import.meta.url);

function sourceModules(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((entry) =>
    entry.endsWith('.ts'),
  );
}

function importsMineflayer(entry: string): boolean {
  const body = readFileSync(new URL(entry, SRC_DIR), 'utf8');
  // Strip comments so prose about mineflayer does not trip the scan.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /\bfrom\s+['"]mineflayer|require\(\s*['"]mineflayer/.test(code);
}

test('only the observation module imports mineflayer', () => {
  const offenders = sourceModules().filter(
    (entry) => !MINEFLAYER_ALLOWED.includes(entry) && importsMineflayer(entry),
  );

  assert.deepEqual(
    offenders,
    [],
    `these modules import mineflayer and must not: ${offenders.join(', ')}. ` +
      'Block-world facts belong in RawObservation, captured in observe.ts at observation time, ' +
      'so that project(), legality(), replay and the report all run with no game present.',
  );
});

/**
 * The allowlist is itself asserted, because the cheap way past the test above
 * is to add a module to it. Widening it then costs an edit to this literal,
 * which is a line a reviewer reads rather than a constant they scroll past.
 *
 * A type-only `import type { Bot } from 'mineflayer'` is erased before Node
 * runs anything and breaks no offline path, but it still counts here: the scan
 * stays textual, and the allowlist is where the intent gets recorded.
 */
test('the mineflayer allowlist is exactly the observation module', () => {
  assert.deepEqual(
    [...MINEFLAYER_ALLOWED],
    ['observe.ts'],
    'only observe.ts may hold a Bot. A module added here can no longer run in replay or in the ' +
      'report, and neither the offline gate nor the type checker will say so.',
  );

  // A stale entry is the same rot in the other direction: an exemption nothing
  // is using, which the next module to need one silently inherits.
  const modules = sourceModules();
  for (const allowed of MINEFLAYER_ALLOWED) {
    assert.ok(
      modules.includes(allowed),
      `src/${allowed} is allowlisted but does not exist; drop it from MINEFLAYER_ALLOWED`,
    );
    assert.ok(
      importsMineflayer(allowed),
      `src/${allowed} is allowlisted but no longer imports mineflayer; drop it from the allowlist`,
    );
  }
});

/**
 * On an ONLINE_MODE=false server the bot's username is not a Mojang account,
 * so the image cannot resolve a name to a UUID -- it asks PlayerDB, the lookup
 * fails, and the container exits 1 before the world is generated. Offline
 * UUIDs are derived locally instead, so OPS must carry the UUID.
 *
 * Recomputed here rather than hard-coded. Note the limit: this reads
 * .env.example, while the bot logs in with MC_USERNAME from the gitignored
 * .env.local, so a rename made only there still passes. The runtime path has
 * to verify op after connecting; recorded on #6.
 */
test('OPS carries the bot username as an offline UUID, not a name', () => {
  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const username = envExample.match(/^MC_USERNAME=(.+)$/m)?.[1]?.trim();
  assert.ok(username, '.env.example must set MC_USERNAME — it is what OPS has to match');

  const hash = createHash('md5').update(`OfflinePlayer:${username}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8]! & 0x3f) | 0x80; // IETF variant
  const hex = hash.toString('hex');
  const expected = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');

  assert.equal(
    composeValue('OPS'),
    expected,
    `OPS must be the offline UUID for "${username}" (${expected}). A bare username makes the ` +
      'image query PlayerDB, which cannot resolve an offline account, and the container exits 1.',
  );
});
