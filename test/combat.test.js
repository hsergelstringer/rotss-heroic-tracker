/**
 * The module's combat handling, end to end, against a simulated Foundry:
 * spending actions as players and the GM, refreshes as turns pass, and effect
 * markers placing, skipping, firing and removing themselves.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, settle, startFoundry } from "./support/foundry.js";

const world = installFoundry();
const Core = await import("../scripts/core.js");
const Markers = await import("../scripts/markers.js");
const { request } = await import("../scripts/requests.js");
await import("../scripts/main.js");
startFoundry();

const library = {
  companions: [
    { id: "hrolf", name: "Hrolf", actorId: "hrolf", points: 3, refresh: "turn",
      actions: [{ id: "assist", name: "Assist", cost: 1, description: "Advantage on the next attack." }, { id: "attack", name: "Attack", cost: 2 }] },
    { id: "mirgal", name: "Mirgal", points: 3, refresh: "count", refreshCount: 15, actions: [{ id: "cast", name: "Cast", cost: 1 }] }
  ],
  heroics: [
    { id: "fleet", name: "Hallharn Fleet", ally: "Hallharn", limit: { uses: 2, per: "total" }, description: "An enemy loses a legendary action." },
    { id: "surge", name: "Vani's Surge", ally: "Vani" }
  ]
};

let combat;
const names = () => combat.turns.map(c => c.name);
const current = () => combat.combatant?.name;
const state = () => Core.getCombatState(combat);
const markerNamed = text => combat.combatants.find(c => c.name === text);
const reminders = () => world.messages.filter(m => m.speaker?.alias === "Reminder").map(m => m.content.match(/<\/i> ([^<]+)<\/h3>/)?.[1]);
const spend = req => request("spend", { combatId: combat.id, request: req });
const next = async () => { await combat.nextTurn(); await settle(); };

beforeEach(async () => {
  world.as(world.gm);
  for (const c of game.combats.contents) game.combats.delete(c.id);
  world.messages.clear();
  world.sent.length = 0;
  await Core.saveLibrary(library);
  await game.settings.set("rotss-heroic-tracker", "usage", {});
  await game.settings.set("rotss-heroic-tracker", "whoSpends", "turn");
  // Isen 20, Hrolf 17, Feeder 12, Astrid 8
  combat = await world.newCombat([["isen", 20], ["hrolf", 17], ["feeder", 12], ["astrid", 8]]);
  await combat.startCombat();
  await settle();
});

describe("refresh markers", () => {
  test("a companion that refreshes at a count gets a repeating marker at that count", () => {
    assert.deepEqual(names(), ["Isen", "Hrolf", "Mirgal regains actions", "The Feeder", "Astrid"]);
    assert.equal(markerNamed("Mirgal regains actions").initiative, 14.999);
  });

  test("it refills Mirgal each round, whispered to the GM, and stays", async () => {
    await spend({ kind: "companion", companionId: "mirgal", actionId: "cast" });
    assert.equal(state().spent.mirgal, 1);
    await next(); // Hrolf
    await next(); // the marker: refresh, then on to the Feeder
    assert.equal(current(), "The Feeder");
    assert.equal(state().spent.mirgal, undefined);
    const message = world.messages.find(m => m.content.includes("Mirgal regains actions"));
    assert.deepEqual(message.whisper, ["gm"]);
    assert.ok(markerNamed("Mirgal regains actions"), "the marker repeats");
  });
});

describe("companion actions", () => {
  test("refill at the start of the companion's own turn", async () => {
    await spend({ kind: "companion", companionId: "hrolf", actionId: "attack" });
    assert.equal(state().spent.hrolf, 2);
    await next(); // Hrolf's turn
    assert.equal(state().spent.hrolf, undefined);
  });

  test("a player can spend on their own turn and just after it, not later", async () => {
    world.as(world.ursula); // Isen's player; it's Isen's turn
    await spend({ kind: "companion", companionId: "hrolf", actionId: "assist" });
    world.as(world.gm);
    await settle();
    assert.equal(state().spent.hrolf, 1);

    await next(); // Hrolf's turn: Isen's just ended; Hrolf refills
    world.as(world.ursula);
    await spend({ kind: "companion", companionId: "hrolf", actionId: "assist" });
    world.as(world.gm);
    await settle();
    assert.equal(state().spent.hrolf, 1, "allowed just after Isen's turn");

    await next(); // past the marker to the Feeder
    world.as(world.ursula);
    await spend({ kind: "companion", companionId: "hrolf", actionId: "assist" });
    world.as(world.gm);
    await settle();
    assert.equal(state().spent.hrolf, 1, "refused two turns later");
    assert.match(world.sent.at(-1).message, /hero whose turn it is, or whose turn just ended/);
  });

  test("another player can't spend on someone else's turn", async () => {
    world.as(world.bjorn);
    await spend({ kind: "companion", companionId: "hrolf", actionId: "assist" });
    world.as(world.gm);
    await settle();
    assert.equal(state().spent.hrolf, undefined);
  });

  test("not enough points is refused with the reason", async () => {
    await spend({ kind: "companion", companionId: "hrolf", actionId: "attack" });
    await spend({ kind: "companion", companionId: "hrolf", actionId: "attack" });
    assert.equal(state().spent.hrolf, 2);
  });

  test("quick repeated taps are all counted", async () => {
    await Promise.all([1, 2, 3].map(() => spend({ kind: "companion", companionId: "hrolf", actionId: "assist" })));
    assert.equal(state().spent.hrolf, 3);
    assert.equal(state().log.length, 3);
  });

  test("each use posts a chat card with what's left; undo gives it back and removes the card", async () => {
    await spend({ kind: "companion", companionId: "hrolf", actionId: "assist" });
    const card = world.messages.find(m => m.content.includes("rotss-heroic-card"));
    assert.match(card.content, /Hrolf: Assist/);
    assert.match(card.content, /Costs 1 · 2 of 3 left/);
    assert.match(card.content, /Advantage on the next attack/);
    assert.match(card.content, /Used by GM/);

    await request("undo", { combatId: combat.id, entryId: state().log[0].id });
    assert.equal(state().spent.hrolf, 0);
    assert.ok(!world.messages.some(m => m.content.includes("rotss-heroic-card")));
  });
});

describe("heroic actions", () => {
  test("any player, once per round, back next round", async () => {
    world.as(world.bjorn); // not Bjorn's turn: heroic actions don't care
    await spend({ kind: "heroic", heroicId: "surge" });
    world.as(world.gm);
    await settle();
    assert.deepEqual(state().usedThisRound, ["surge"]);
    await spend({ kind: "heroic", heroicId: "surge" });
    assert.equal(state().log.length, 1, "second use this round refused");
    for (let i = 0; i < 5; i++) await next(); // round 2
    assert.equal(combat.round, 2);
    assert.deepEqual(state().usedThisRound, []);
  });

  test("limited total uses carry into the next combat", async () => {
    await spend({ kind: "heroic", heroicId: "fleet" });
    for (let i = 0; i < 5; i++) await next();
    await spend({ kind: "heroic", heroicId: "fleet" });
    assert.equal(Core.getUsage()["h:fleet"], 2);
    combat = await world.newCombat([["isen", 10]]);
    await combat.startCombat();
    await settle();
    await spend({ kind: "heroic", heroicId: "fleet" });
    assert.equal(Core.getUsage()["h:fleet"], 2, "no third use");
  });

  test("only the GM when set to GM only", async () => {
    await game.settings.set("rotss-heroic-tracker", "whoSpends", "gm");
    world.as(world.ursula);
    await spend({ kind: "heroic", heroicId: "surge" });
    world.as(world.gm);
    await settle();
    assert.deepEqual(state().usedThisRound, []);
  });
});

describe("effect markers", () => {
  const addMarker = input => request("addMarker", { combatId: combat.id, input });

  test("'end of its next turn', added before that turn, goes off right after it", async () => {
    await addMarker({ text: "Feeder stunned", timing: "endOfTurn", anchorId: combat.turns.find(c => c.name === "The Feeder").id });
    await settle();
    assert.deepEqual(names(), ["Isen", "Hrolf", "Mirgal regains actions", "The Feeder", "Feeder stunned", "Astrid"]);
    await next(); // Hrolf
    await next(); // Mirgal's marker, skipped to the Feeder
    assert.equal(current(), "The Feeder");
    await next(); // the stun marker fires, and we land on Astrid
    assert.equal(current(), "Astrid");
    assert.ok(reminders().includes("Feeder stunned"));
    assert.equal(markerNamed("Feeder stunned"), undefined, "removed once done");
  });

  test("added during the anchor's own turn, it waits for the anchor's next turn", async () => {
    const isen = combat.turns.find(c => c.name === "Isen");
    await addMarker({ text: "Isen's rage", timing: "endOfTurn", anchorId: isen.id });
    await settle();
    await next(); // the marker right after Isen: not armed yet, skipped silently
    assert.equal(current(), "Hrolf");
    assert.ok(!reminders().includes("Isen's rage"));
    assert.ok(markerNamed("Isen's rage"), "still waiting");
    for (let i = 0; i < 3; i++) await next(); // Feeder, Astrid, round 2 Isen
    assert.equal(current(), "Isen");
    await next(); // end of Isen's next turn
    assert.ok(reminders().includes("Isen's rage"));
    assert.equal(current(), "Hrolf");
  });

  test("'start of the next round' sits at the top and goes off when the round turns", async () => {
    await addMarker({ text: "+1 AC ends", timing: "startOfRound" });
    await settle();
    assert.equal(names()[0], "+1 AC ends");
    while (combat.round === 1) await next();
    assert.ok(reminders().includes("+1 AC ends"));
    assert.equal(current(), "Isen");
  });

  test("repeating markers go off each time and count down", async () => {
    await addMarker({ text: "Burning", timing: "startOfTurn", anchorId: combat.turns.find(c => c.name === "Astrid").id, repeat: true, rounds: 2 });
    await settle();
    for (let i = 0; i < 3; i++) await next(); // Hrolf, the Feeder (past Mirgal's marker), Astrid (past Burning)
    assert.equal(current(), "Astrid");
    assert.equal(Markers.markerOf(markerNamed("Burning")).rounds, 1);
    for (let i = 0; i < 4; i++) await next(); // round 2, Astrid again
    assert.equal(reminders().filter(r => r === "Burning").length, 2);
    assert.equal(markerNamed("Burning"), undefined);
  });

  test("markers follow their anchor when its initiative changes", async () => {
    const feeder = combat.turns.find(c => c.name === "The Feeder");
    await addMarker({ text: "Feeder stunned", timing: "endOfTurn", anchorId: feeder.id });
    await settle();
    await feeder.update({ initiative: 5 });
    await settle();
    assert.equal(markerNamed("Feeder stunned").initiative, 4.999);
    assert.deepEqual(names().slice(-2), ["The Feeder", "Feeder stunned"]);
  });

  test("if its anchor leaves, the marker still goes off the next time it's reached", async () => {
    const feeder = combat.turns.find(c => c.name === "The Feeder");
    await addMarker({ text: "Feeder stunned", timing: "endOfTurn", anchorId: feeder.id });
    await settle();
    await feeder.delete();
    await settle();
    while (current() !== "Astrid") await next();
    assert.ok(reminders().includes("Feeder stunned"));
  });

  test("going back through the turns doesn't fire or remove markers", async () => {
    await next(); // Hrolf
    await next(); // past Mirgal's marker to the Feeder
    const before = world.messages.size;
    await combat.previousTurn(); await settle(); // onto Mirgal's marker: steps back past it
    assert.equal(current(), "Hrolf");
    assert.equal(world.messages.size, before);
  });

  test("hidden markers whisper the GM; players can't make hidden ones", async () => {
    await addMarker({ text: "Secret", timing: "startOfTurn", anchorId: combat.turns.find(c => c.name === "Hrolf").id, hidden: true });
    world.as(world.ursula);
    await addMarker({ text: "Mine", timing: "startOfTurn", anchorId: combat.turns.find(c => c.name === "Hrolf").id, hidden: true });
    world.as(world.gm);
    await settle();
    assert.equal(markerNamed("Secret").hidden, true);
    assert.equal(markerNamed("Mine").hidden, false);
    await next();
    assert.deepEqual(world.messages.find(m => m.content.includes("Secret")).whisper, ["gm"]);
    assert.deepEqual(world.messages.find(m => m.content.includes("Mine")).whisper, []);
  });

  test("players can't add markers when the GM turns it off", async () => {
    await game.settings.set("rotss-heroic-tracker", "playersAddMarkers", false);
    world.as(world.ursula);
    await addMarker({ text: "Nope", timing: "startOfRound" });
    world.as(world.gm);
    await settle();
    assert.equal(markerNamed("Nope"), undefined);
  });

  test("dnd5e's per-round recovery skips markers", () => {
    const marker = markerNamed("Mirgal regains actions");
    assert.equal(Hooks.call("dnd5e.preCombatRecovery", marker, ["round"]), false);
    assert.equal(Hooks.call("dnd5e.preCombatRecovery", combat.turns[0], ["round"]), true);
  });
});
