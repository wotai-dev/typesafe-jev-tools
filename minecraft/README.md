# minecraft

A Minecraft bot whose only judgment is a six-way action choice from Jev, and the harness that
measures whether that model's uncertainty lands on situations a person would call genuinely
ambiguous.

Mineflayer owns the game loop, pathfinding, inventory and block APIs. Jev owns nothing except
judgments. Code observes, Jev judges, code acts.

## What is pinned, and why

Jev's measured p50 is 455ms and a Minecraft tick is 50ms, so the model is nine ticks behind the
game. That rules it out of anything reflexive and puts it at the planning altitude: what to do for
the next second or so. Reflexes stay in deterministic code.

Everything a measurement has to hold constant is an explicit line in `docker-compose.yml` rather
than a default, so a reviewer can challenge it and a reader can reproduce it.

| Pinned | Value | Why |
|---|---|---|
| Minecraft | `1.21.11` | Present in mineflayer 4.39.0's `testedVersions`. `npm test` re-checks this on every run, so upgrading mineflayer cannot drift the pin silently. |
| Server image | `itzg/minecraft-server:2025.9.0` | A floating tag would change the server under a fixed Minecraft version. |
| Seed | `8675309` | Same world on every run, for every reader. |
| Difficulty | `normal` | Hostile spawn rates are the independent variable's context; changing this changes what the numbers mean. |
| Online mode | `false` | No Mojang auth, so the bot logs in with a bare username. |
| Model | `jev-1.13.0` | A versioned ID, not an alias. Aliases move when a release ships, and confidence thresholds are tuned against one version. |

`26.1` is also in mineflayer's tested list and is newer. The `1.21` line is pinned instead because
its pathfinder ecosystem is more settled. Minecraft `26.2` is served by `minecraft-data` but is
**not** in mineflayer's tested list, so it is not a candidate.

## What has not been checked

Honest gaps, in the root README's spirit that an empty cell beats a guess:

- **The 455ms p50 was measured on a different task.** It came from a single-question text
  benchmark. Each decision here batches a six-option Choice carrying per-action criteria plus two
  Nouls over a fixed-slot state, so the real p50 may be higher — and both the run's record count
  and its stated cost move with it. U3 measures it on a live call rather than assuming it.
- **The bot's health and food are `undefined` at the moment it spawns.** Observed in the smoke
  check: the server sends the health packet shortly after the spawn event, not with it. `observe()`
  has to wait for it or handle the gap, or the first projected states of every run carry a bogus
  health band.
- **Whether Jev returns different distributions for identical requests is unknown.** If it is
  deterministic, the self-agreement column is 1.000 by construction and measures nothing. One
  extra live call in U3 settles it.
- **Inter-rater agreement is not measured** unless a second labeler is available. The reason this
  project uses Minecraft rather than text is that a survival situation *looks* legible to anyone —
  and with one labeler that remains an assumption, not a result.

## What has been checked

Verified 2026-09-21 on the pinned compose file: `docker compose up -d` reaches `healthy` in about
80 seconds on first run (world generation included), and a bare mineflayer client connects, spawns
and reports `1.21.11` at `x=20.5 y=64.0 z=83.5` on seed `8675309`.

That run also caught the one thing the config got wrong. `OPS` was a bare username, and on an
offline-mode server the image asks PlayerDB to resolve it — which cannot work, because the whole
point of offline mode is that the account does not exist. The container exited 1 before generating
a world. `OPS` now carries the offline UUID, and `npm test` recomputes it so renaming the bot
cannot silently leave it unopped.

## Layout

```
minecraft/
  docker-compose.yml   the pinned server; every confound is a line here
  .env.example         copy to .env.local; holds TYPESAFE_API_KEY
  src/types.ts         the raw-observation / request-state / decision-record contract
  test/                unit tests, run with node --test
```

`src/types.ts` encodes the split the whole design rests on. `RawObservation` is what the game
gives us; `RequestState` is what Jev is allowed to see; the function between them does every
calculation. Jev never receives a number — distance is a `melee`/`bow`/`far` band, health is a
level, and so on. Nothing in that path imports mineflayer, because the replay and report paths
have to run with no game present.

## Running it

```bash
cp .env.example .env.local     # then fill in TYPESAFE_API_KEY
npm install
npm run typecheck
npm test

docker compose up -d           # wait for the container to report healthy
```

The server wants about 2GB. `docker compose down -v` removes the world volume, which is also what
the calibration pilot does between its run and the measured one — the volume persists across
restarts, so blocks the pilot placed would otherwise leak into the published run.

## License

MIT, same as the rest of the repo.
