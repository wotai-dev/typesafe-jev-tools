# minecraft

A Minecraft bot whose only judgment is a six-way action choice from Jev, and the harness that
measures whether that model's uncertainty lands on situations a person would call genuinely
ambiguous.

Mineflayer owns the game loop, pathfinding, inventory and block APIs. Jev owns nothing except
judgments. Code observes, Jev judges, code acts.

## What is pinned, and why

A decision costs about 232ms on this request shape (measured; see below) and a Minecraft tick is
50ms, so the model is roughly five ticks behind the game. That rules it out of anything reflexive
and puts it at the planning altitude: what to do for the next second or so. Reflexes stay in
deterministic code.

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
| Port | `127.0.0.1:25565` | Loopback only. Online mode is off and `OPS` grants operator on login, so a `0.0.0.0` publish would hand op to anyone who can reach this machine — and on Linux a Docker publish bypasses host firewall rules. |

`26.1` is also in mineflayer's tested list and is newer. The `1.21` line is pinned instead because
its pathfinder ecosystem is more settled. Minecraft `26.2` is served by `minecraft-data` but is
**not** in mineflayer's tested list, so it is not a candidate.

## What has not been checked

Honest gaps, in the root README's spirit that an empty cell beats a guess:

- **The bot's health and food are `undefined` at the moment it spawns.** Observed in the smoke
  check: the server sends the health packet shortly after the spawn event, not with it. `observe()`
  has to wait for it or handle the gap, or the first projected states of every run carry a bogus
  health band.
- **Inter-rater agreement is not measured** unless a second labeler is available. The reason this
  project uses Minecraft rather than text is that a survival situation *looks* legible to anyone —
  and with one labeler that remains an assumption, not a result.

## What has been checked

Verified 2026-09-21 against the live API, over 12 calls on the real batched request shape (the
action Choice with per-action criteria plus both Nouls, against a fixed-slot state):

- **The batched request is faster than the 455ms the plan assumed, not slower.** The first call in
  a process takes 511–554ms; every call after it on the same client takes 167–284ms, median
  232ms. The difference is connection setup, paid once. So the headline risk — that batching three
  questions would push a decision past its 500ms budget — did not materialise: steady state is
  about 232ms and leaves roughly half the budget. A freshly started bot, or one idle long enough to
  lose its connection, does pay the 500ms+ first call, and at that point a later unit's shortened
  re-check collapses to the response time.
- **Jev is not deterministic, and the variance is concentrated exactly where the measurement
  lives.** Identical requests, repeated:
  - On a *confident* state (`flee` at p=0.98), all seven repeats returned a bit-identical
    distribution and confidence. Only the Nouls moved, by ±0.01.
  - On a deliberately *ambiguous* state, all five repeats differed: `flee` 0.40–0.44, `fight`
    0.26–0.31, `shelter` 0.23–0.30, confidence 0.28–0.33, and the second- and third-place actions
    swapped between samples. The argmax happened to hold across those five, but the runners-up were
    within 0.05 of each other.

  So the self-agreement column is **not** 1.000 by construction and does measure something. It will
  read near 1.000 on easy rows and carry real spread on the ambiguous ones, which is the behaviour
  that makes it worth printing. It also means a confidence threshold sitting inside a ±0.05 band
  can flip a row between runs; the gate's bands should be wider than that or the report should say
  how many rows sit within one.
- **Token cost per decision is about 1,330 input tokens** for the three-question set, at 3.0
  characters of request JSON per token.

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
  src/judge.ts         one batched Jev request per decision; latency, tokens and model pin
  questions/base.json  the versioned question set — the exact prompt text, reviewable in git
  test/                unit tests, run with node --test
```

The question text is a JSON file rather than string literals in `judge.ts` so it can be swapped
behind a flag without a code change, and so a change to what the model is actually asked shows up
as a diff. Each `criteria` entry states the condition under which that action is right rather than
naming it: `jev-1.13` answers the question written, not the one meant, so a bare label like
`"flee": "flee"` is a bug. `judge()` sends one request per decision — the Choice and both Nouls
together — because the round trip is the expensive part and extra questions cost only tokens.

`src/types.ts` encodes the split the whole design rests on. `RawObservation` is what the game
gives us; `RequestState` is what Jev is allowed to see; the function between them does every
calculation. Jev never receives a number — distance is a `melee`/`bow`/`far` band, health is a
level, and so on. Nothing in that path imports mineflayer, because the replay and report paths
have to run with no game present — and `npm test` enforces that rather than trusting the comment,
because a leaked import would pass the offline gate too (importing mineflayer needs no server).

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
