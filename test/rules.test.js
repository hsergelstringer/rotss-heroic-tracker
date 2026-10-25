import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../scripts/rules.js";

const library = R.normalizeLibrary({
  companions: [{
    id: "hrolf", name: "Hrolf", actorId: "actor-hrolf", points: 3, refresh: "turn",
    actions: [
      { id: "assist", name: "Assist", cost: 1 },
      { id: "attack", name: "Attack", cost: 2 },
      { id: "luck", name: "Grant Luck", cost: 1, limit: { uses: 1, per: "rest" } }
    ]
  }, {
    id: "mirgal", name: "Mirgal", points: 3, refresh: "count", refreshCount: 15,
    actions: [{ id: "cast", name: "Cast", cost: 1 }]
  }, {
    id: "sprite", name: "Sprite", points: 1, refresh: "round", actions: [{ id: "zap", name: "Zap", cost: 1 }]
  }],
  heroics: [
    { id: "fleet", name: "Hallharn Fleet", ally: "Hallharn", limit: { uses: 2, per: "total" } },
    { id: "surge", name: "Vani's Surge", ally: "Vani" },
    { id: "absent", name: "Dragon's Breath", available: false }
  ]
});
const companion = (id, actionId) => ({ kind: "companion", companionId: id, actionId });
const heroic = id => ({ kind: "heroic", heroicId: id });

describe("library", () => {
  test("fills in defaults and keeps costs within the pool", () => {
    const lib = R.normalizeLibrary({ companions: [{ name: "Siddhe", points: 1, actions: [{ name: "Stabilize", cost: 5 }] }], heroics: [{}] });
    assert.equal(lib.companions[0].refresh, "turn");
    assert.equal(lib.companions[0].actions[0].cost, 1);
    assert.ok(lib.companions[0].id && lib.companions[0].actions[0].id);
    assert.equal(lib.heroics[0].name, "Heroic Action");
    assert.equal(lib.heroics[0].available, true);
  });

  test("an empty or zero limit means unlimited", () => {
    assert.equal(R.normalizeHeroic({ limit: { uses: 0 } }).limit, null);
    assert.deepEqual(R.normalizeHeroic({ limit: { uses: "3", per: "bogus" } }).limit, { uses: 3, per: "combat" });
  });
});

describe("companion actions", () => {
  test("spend points from the pool and refuse when there aren't enough", () => {
    let { state } = R.spend(library, R.emptyCombatState(), {}, companion("hrolf", "attack"));
    assert.equal(R.pointsLeft(library.companions[0], state), 1);
    assert.throws(() => R.spend(library, state, {}, companion("hrolf", "attack")), /1 of 3 actions left; Attack costs 2/);
    ({ state } = R.spend(library, state, {}, companion("hrolf", "assist")));
    assert.equal(R.pointsLeft(library.companions[0], state), 0);
  });

  test("refill at the start of the linked actor's turn only", () => {
    let { state } = R.spend(library, R.emptyCombatState(), {}, companion("hrolf", "attack"));
    let result = R.startTurn(library, state, "someone-else");
    assert.equal(R.pointsLeft(library.companions[0], result.state), 1);
    result = R.startTurn(library, state, "actor-hrolf");
    assert.equal(R.pointsLeft(library.companions[0], result.state), 3);
    assert.deepEqual(result.refreshed.map(c => c.id), ["hrolf"]);
  });

  test("'each round' companions refill when a round starts; 'turn' ones don't", () => {
    let state = R.spend(library, R.emptyCombatState(), {}, companion("sprite", "zap")).state;
    state = R.spend(library, state, {}, companion("hrolf", "assist")).state;
    state = R.startRound(library, state, 2);
    assert.equal(R.pointsLeft(library.companions[2], state), 1);
    assert.equal(R.pointsLeft(library.companions[0], state), 2);
  });

  test("companions away from the party can't act or refresh", () => {
    const away = R.normalizeLibrary({ companions: [{ ...library.companions[0], active: false }] });
    assert.throws(() => R.spend(away, R.emptyCombatState(), {}, companion("hrolf", "assist")), /isn't with the party/);
    assert.deepEqual(R.startTurn(away, R.emptyCombatState(), "actor-hrolf").refreshed, []);
  });

  test("limited uses per rest outlive the combat until a long rest", () => {
    const { state, usage } = R.spend(library, R.emptyCombatState(), {}, companion("hrolf", "luck"));
    const fresh = R.refreshCompanion(state, "hrolf");
    assert.throws(() => R.spend(library, fresh, usage, companion("hrolf", "luck")), /no uses left per long rest/);
    assert.throws(() => R.spend(library, R.emptyCombatState(), usage, companion("hrolf", "luck")), /no uses left/, "a new combat doesn't reset it");
    const rested = R.longRest(library, usage);
    assert.doesNotThrow(() => R.spend(library, R.emptyCombatState(), rested, companion("hrolf", "luck")));
  });
});

describe("heroic actions", () => {
  test("once per round each", () => {
    let { state } = R.spend(library, R.emptyCombatState(), {}, heroic("surge"));
    assert.throws(() => R.spend(library, state, {}, heroic("surge")), /already been used this round/);
    assert.doesNotThrow(() => R.spend(library, state, {}, heroic("fleet")), "other heroic actions are still available");
    state = R.startRound(library, state, 2);
    assert.doesNotThrow(() => R.spend(library, state, {}, heroic("surge")));
  });

  test("limited total uses carry across rounds and combats", () => {
    let state = R.emptyCombatState();
    let usage = {};
    ({ state, usage } = R.spend(library, state, usage, heroic("fleet")));
    state = R.startRound(library, state, 2);
    ({ state, usage } = R.spend(library, state, usage, heroic("fleet")));
    assert.equal(R.usesLeft(library.heroics[0].limit, R.heroicKey("fleet"), state, usage), 0);
    assert.throws(() => R.spend(library, R.emptyCombatState(), usage, heroic("fleet")), /no uses left in total/);
    assert.deepEqual(R.longRest(library, usage), usage, "a long rest doesn't restore 'in total' uses");
  });

  test("unavailable heroic actions can't be used", () => {
    assert.throws(() => R.spend(library, R.emptyCombatState(), {}, heroic("absent")), /isn't available/);
  });
});

describe("undo", () => {
  test("gives back points, the round use and the limited use", () => {
    let state = R.emptyCombatState();
    let usage = {};
    let entry;
    ({ state, usage, entry } = R.spend(library, state, usage, companion("hrolf", "luck"), { by: "Ursula" }));
    assert.equal(entry.by, "Ursula");
    ({ state, usage } = R.undo(library, state, usage, entry.id));
    assert.equal(R.pointsLeft(library.companions[0], state), 3);
    assert.equal(usage[R.companionKey("hrolf", "luck")], 0);
    assert.equal(state.log.length, 0);

    ({ state, usage, entry } = R.spend(library, state, usage, heroic("surge")));
    ({ state, usage } = R.undo(library, state, usage, entry.id));
    assert.doesNotThrow(() => R.spend(library, state, usage, heroic("surge")));
  });
});

describe("turn order", () => {
  test("the previous combatant skips markers and wraps around", () => {
    const turns = [{ id: "a" }, { id: "m1", isMarker: true }, { id: "b" }, { id: "m2", isMarker: true }];
    assert.equal(R.previousCombatant(turns, 2).id, "a");
    assert.equal(R.previousCombatant(turns, 0).id, "b");
    assert.equal(R.previousCombatant([{ id: "m", isMarker: true }], 0), null);
    assert.equal(R.previousCombatant(turns, 0, { wrap: false }), null, "the first turn of a fight has no previous turn");
    assert.equal(R.previousCombatant(turns, 2, { wrap: false }).id, "a");
  });
});

describe("markers", () => {
  const combatants = [
    { id: "fast", initiative: 20 },
    { id: "feeder", initiative: 15 },
    { id: "slow", initiative: 5 }
  ];

  test("sit just after or before their anchor, at a count, or at the top of the round", () => {
    assert.equal(R.markerInitiative({ timing: "endOfTurn", anchorId: "feeder" }, combatants), 14.999);
    assert.equal(R.markerInitiative({ timing: "startOfTurn", anchorId: "feeder" }, combatants), 15.001);
    assert.equal(R.markerInitiative({ timing: "count", count: 15 }, combatants), 14.999);
    assert.equal(R.markerInitiative({ timing: "startOfRound" }, combatants), 21);
    assert.equal(R.markerInitiative({ timing: "endOfTurn", anchorId: "gone" }, combatants), null);
  });

  test("several markers after the same anchor keep their order and never tie", () => {
    const first = R.markerInitiative({ timing: "endOfTurn", anchorId: "feeder" }, combatants);
    const second = R.markerInitiative({ timing: "endOfTurn", anchorId: "feeder" }, [...combatants, { id: "m1", initiative: first, isMarker: true }]);
    assert.ok(second < first && second > 5);
  });

  test("'end of its next turn' waits until the anchor has had a turn", () => {
    const marker = R.normalizeMarker({ text: "Stunned", timing: "endOfTurn", anchorId: "feeder" });
    assert.deepEqual(R.reachMarker(marker), { fire: false, remove: false }, "reached before the feeder's turn: wait");
    assert.deepEqual(R.armMarkers([marker], "feeder"), [marker.id]);
    assert.deepEqual(R.reachMarker({ ...marker, armed: true }), { fire: true, remove: true });
  });

  test("other timings go off the first time they're reached", () => {
    for (const timing of ["startOfTurn", "startOfRound", "count"]) {
      assert.deepEqual(R.reachMarker(R.normalizeMarker({ timing, anchorId: "feeder" })), { fire: true, remove: true }, timing);
    }
  });

  test("repeating markers count down, and repeat forever without a count", () => {
    let marker = R.normalizeMarker({ timing: "startOfTurn", anchorId: "feeder", repeat: true, rounds: 2 });
    let result = R.reachMarker(marker);
    assert.deepEqual(result, { fire: true, remove: false, update: { rounds: 1, armed: false } });
    marker = { ...marker, ...result.update };
    assert.deepEqual(R.reachMarker(marker), { fire: true, remove: true });
    assert.deepEqual(R.reachMarker(R.normalizeMarker({ timing: "count", repeat: true })), { fire: true, remove: false, update: { armed: false } });
  });

  test("timings read naturally", () => {
    assert.equal(R.describeTiming({ timing: "endOfTurn" }, "the feeder"), "end of the feeder's next turn");
    assert.equal(R.describeTiming({ timing: "count", count: 15, repeat: true }), "initiative 15 each round");
    assert.equal(R.describeTiming({ timing: "startOfTurn", repeat: true, rounds: 3 }, "Isen"), "start of each of Isen's turns, 3 more");
  });

  test("anchors only apply to turn-based timings", () => {
    assert.equal(R.normalizeMarker({ timing: "startOfRound", anchorId: "x" }).anchorId, null);
    assert.equal(R.normalizeMarker({ timing: "bogus" }).timing, "endOfTurn");
  });
});
