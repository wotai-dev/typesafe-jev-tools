import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    ['OPS', 'jevbot'],
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
