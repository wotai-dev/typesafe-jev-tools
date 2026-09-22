import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  assert.match(
    compose,
    /^\s*SEED:\s*"\d+"/m,
    'SEED must be pinned to a fixed value so every run gets the same world',
  );
});

/**
 * On an ONLINE_MODE=false server the bot's username is not a Mojang account,
 * so the image cannot resolve a name to a UUID -- it asks PlayerDB, the lookup
 * fails, and the container exits 1 before the world is generated. Offline
 * UUIDs are derived locally instead, so OPS must carry the UUID.
 *
 * Recomputed here rather than hard-coded: renaming the bot without updating
 * OPS would otherwise silently leave it unopped, and it cannot then reset
 * itself between the calibration pilot and the measured run.
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
