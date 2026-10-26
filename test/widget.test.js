/**
 * The companions panel on the canvas, against a simulated Foundry with a DOM.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { installFoundry, settle, startFoundry } from "./support/foundry.js";

const world = installFoundry();
const Core = await import("../scripts/core.js");
const Widget = await import("../scripts/widget.js");
await import("../scripts/main.js");
startFoundry();

const ID = "rotss-heroic-widget";
const panel = () => document.getElementById(ID);
const cards = () => [...(panel()?.querySelectorAll(".rhw-card") ?? [])];
const card = name => cards().find(c => c.querySelector("strong").textContent === name);
const set = (key, value) => game.settings.set("rotss-heroic-tracker", key, value);

let combat;

beforeEach(async () => {
  world.as(world.gm);
  for (const c of game.combats.contents) game.combats.delete(c.id);
  await set("widgetShow", true);
  await set("widgetCollapsed", false);
  await set("widgetPosition", { left: 120, top: 90 });
  await set("usage", {});
  await Core.saveLibrary({
    companions: [
      { id: "hrolf", name: "Hrolf", actorId: "hrolf", points: 3, actions: [{ id: "assist", name: "Assist", cost: 1, description: "Advantage on the next attack." }, { id: "attack", name: "Attack", cost: 2 }] },
      { id: "skuld", name: "Skuld", points: 3, refresh: "round", actions: [{ id: "spear", name: "Spear", cost: 1 }] },
      { id: "odur", name: "Odur", active: false, actions: [] }
    ],
    heroics: []
  });
  await settle();
});

const startCombat = async () => {
  combat = await world.newCombat([["isen", 20], ["hrolf", 17], ["feeder", 12], ["astrid", 8]]);
  await combat.startCombat();
  await settle();
};

describe("companions panel", () => {
  test("lists the companions with the party, with portrait, speed and actions left", () => {
    assert.deepEqual(cards().map(c => c.querySelector("strong").textContent), ["Hrolf", "Skuld"]);
    const hrolf = card("Hrolf");
    assert.equal(hrolf.querySelector("img").getAttribute("src"), "actors/hrolf.webp", "the linked actor's portrait");
    assert.match(hrolf.querySelector(".rhw-speed").textContent, /30 ft · swim 30 ft/);
    assert.equal(hrolf.querySelectorAll(".rhw-pip.on").length, 3);
    assert.equal(card("Skuld").querySelector(".rhw-speed"), null, "no actor, no speed");
    assert.equal(card("Skuld").querySelector(".rhw-initial").textContent, "S");
  });

  test("action buttons appear only during combat", async () => {
    assert.equal(panel().querySelectorAll(".rhw-actions button").length, 0);
    await startCombat();
    assert.deepEqual([...card("Hrolf").querySelectorAll(".rhw-actions button")].map(b => b.textContent.replace(/\s+/g, " ").trim()), ["Assist1", "Attack2"]);
  });

  test("clicking an action spends it, and the pips update", async () => {
    await startCombat();
    card("Hrolf").querySelector("[data-action-id=attack]").click();
    await settle();
    assert.equal(Core.getCombatState(combat).spent.hrolf, 2);
    assert.equal(card("Hrolf").querySelectorAll(".rhw-pip.on").length, 1);
    assert.ok(card("Hrolf").querySelector("[data-action-id=attack]").hasAttribute("disabled"), "not enough left for another attack");
  });

  test("a player sees the actions disabled when it isn't their turn, with the reason", async () => {
    await startCombat();
    world.as(world.bjorn);
    Widget.render();
    const button = card("Hrolf").querySelector("[data-action-id=assist]");
    assert.ok(button.hasAttribute("disabled"));
    assert.match(button.dataset.tooltip, /hero whose turn it is/);
    world.as(world.ursula); // Isen's turn
    Widget.render();
    assert.ok(!card("Hrolf").querySelector("[data-action-id=assist]").hasAttribute("disabled"));
  });

  test("collapsing hides speed and actions; hiding removes the panel", async () => {
    await startCombat();
    panel().querySelector("[data-rhw=collapse]").click();
    await settle();
    assert.ok(panel().classList.contains("collapsed"));
    assert.equal(panel().querySelectorAll(".rhw-speed, .rhw-actions").length, 0);
    assert.equal(cards().length, 2, "portraits and pips stay");

    panel().querySelector("[data-rhw=hide]").click();
    await settle();
    assert.equal(panel(), null);
    assert.equal(Widget.isShown(), false);
    await Widget.setShown(true);
    await settle();
    assert.ok(panel());
  });

  test("goes away when no companion is with the party", async () => {
    const library = Core.getLibrary();
    library.companions.forEach(c => { c.active = false; });
    await Core.saveLibrary(library);
    await settle();
    assert.equal(panel(), null);
  });

  test("sits where it was left, kept on screen", async () => {
    assert.deepEqual([panel().style.left, panel().style.top], ["120px", "90px"]);
    await set("widgetPosition", { left: 99999, top: -50 });
    Widget.render();
    assert.ok(parseInt(panel().style.left, 10) <= window.innerWidth);
    assert.equal(panel().style.top, "0px");
  });

  test("updates when a linked actor's speed changes", async () => {
    world.actors.get("hrolf").system.attributes.movement.speeds.walk = 15;
    Hooks.callAll("updateActor", world.actors.get("hrolf"), {});
    assert.match(card("Hrolf").querySelector(".rhw-speed").textContent, /15 ft/);
  });

  test("escapes names and descriptions", async () => {
    const library = Core.getLibrary();
    library.companions[0].name = "<img src=x onerror=alert(1)>";
    library.companions[0].actions[0].description = "\"><script>alert(2)</script>";
    await Core.saveLibrary(library);
    await startCombat();
    assert.equal(panel().querySelectorAll("script, img[onerror]").length, 0);
  });
});
