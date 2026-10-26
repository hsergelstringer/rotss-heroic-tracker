/**
 * Raiders of the Serpent Sea: Heroic & Companion Actions.
 *
 * Tracks companion actions (Companion Rules, Chapter 1 and Appendix D) and
 * Heroic Actions (Chapter 12, Ragnarök) during combat, and puts effect
 * reminders into the initiative order.
 *
 *  - rules.js     the rules, with no Foundry dependencies (tested on their own)
 *  - core.js      settings, saved state, who may act, chat cards
 *  - markers.js   effect markers and what happens as turns change
 *  - requests.js  every change, carried out by the active GM's browser
 *  - apps.js      the tracker window, the library editor, the marker dialog
 */

import * as Core from "./core.js";
import * as Markers from "./markers.js";
import { HeroicTracker, LibraryEditor, markerDialog } from "./apps.js";
import { listen, request } from "./requests.js";
import * as Widget from "./widget.js";

const { MODULE_ID } = Core;

/** Redraw everything that shows companion and heroic action state. */
function refreshViews() {
  HeroicTracker.refresh();
  Widget.render();
}

Hooks.once("init", () => {
  Core.registerSettings(() => {
    refreshViews();
    Markers.syncRefreshMarkers(game.combat);
  });
  Widget.registerWidgetSettings();

  game.modules.get(MODULE_ID).api = {
    open: () => HeroicTracker.open(),
    edit: () => LibraryEditor.open(),
    /** Add a marker to the current combat, e.g. { text: "Stunned", timing: "endOfTurn", anchorId }. */
    addMarker: input => request("addMarker", { combatId: game.combat?.id, input }),
    /** Ask for a marker with the dialog, anchored to a combatant if given. */
    markerDialog: async anchorId => {
      if (!game.combat) return ui.notifications.warn("There's no combat running.");
      const input = await markerDialog(game.combat, { anchorId });
      if (input) await request("addMarker", { combatId: game.combat.id, input });
    },
    getLibrary: Core.getLibrary,
    /** Show or hide the companions panel on the canvas, for this browser. */
    toggleWidget: shown => Widget.setShown(shown ?? !Widget.isShown())
  };
});

Hooks.once("ready", () => {
  listen();
  Widget.watchResize();
  Widget.render();
  if (Core.isActiveGM()) Markers.syncRefreshMarkers(game.combat);
});

/* -------------------------------------------- */
/*  Combat                                      */
/* -------------------------------------------- */

Hooks.on("updateCombat", (combat, changed, options) => {
  Markers.onUpdateCombat(combat, changed, options).catch(err => console.error(`${MODULE_ID} | turn change failed`, err));
  refreshViews();
});
Hooks.on("updateCombatant", (combatant, changed) => {
  Markers.onUpdateCombatant(combatant, changed).catch(err => console.error(`${MODULE_ID} | marker reposition failed`, err));
  refreshViews();
});
Hooks.on("deleteCombatant", combatant => {
  Markers.onDeleteCombatant(combatant).catch(err => console.error(`${MODULE_ID} | marker update failed`, err));
  refreshViews();
});
for (const hook of ["createCombatant", "createCombat", "deleteCombat"]) Hooks.on(hook, () => refreshViews());

// A linked actor's speed or portrait changed (a condition, a spell, a new image).
Hooks.on("updateActor", actor => {
  if (Core.getLibrary().companions.some(c => c.actorId === actor.id)) refreshViews();
});
Hooks.on("combatStart", combat => {
  if (Core.isActiveGM()) Markers.syncRefreshMarkers(combat);
});

// dnd5e recovers combat uses for every combatant each round and assumes each
// one has an actor; markers don't, so leave them out.
Hooks.on("dnd5e.preCombatRecovery", combatant => (Core.isMarker(combatant) ? false : undefined));

/* -------------------------------------------- */
/*  Combat tracker                              */
/* -------------------------------------------- */

/** Mark marker rows so they can be styled, explain them on hover, and add a button to open the tracker. */
Hooks.on("renderCombatTracker", (app, html) => {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root) return;
  for (const combatant of Markers.markersIn(game.combat)) {
    const row = root.querySelector(`[data-combatant-id="${combatant.id}"]`);
    if (!row) continue;
    const marker = Markers.markerOf(combatant);
    row.classList.add("rotss-heroic-marker");
    row.dataset.tooltip = [Markers.describeMarker(game.combat, marker), marker.details].filter(Boolean).join(" — ");
  }
  const header = root.querySelector(".encounter-controls, .combat-tracker-header, header");
  if (header && !header.querySelector(".rotss-heroic-open")) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "inline-control icon rotss-heroic-open fa-solid fa-shield-heart";
    button.dataset.tooltip = "Heroic & companion actions";
    button.setAttribute("aria-label", "Heroic & companion actions");
    button.addEventListener("click", event => {
      event.preventDefault();
      HeroicTracker.open();
    });
    header.append(button);
  }
});

Hooks.on("getSceneControlButtons", controls => {
  const tokens = controls.tokens;
  if (!tokens) return;
  tokens.tools.rotssHeroic = {
    name: "rotssHeroic",
    title: "Heroic & Companion Actions",
    icon: "fa-solid fa-shield-heart",
    order: Object.keys(tokens.tools).length,
    button: true,
    visible: true,
    onChange: () => HeroicTracker.open()
  };
  tokens.tools.rotssHeroicWidget = {
    name: "rotssHeroicWidget",
    title: "Companions panel",
    icon: "fa-solid fa-people-group",
    order: Object.keys(tokens.tools).length,
    toggle: true,
    active: Widget.isShown(),
    visible: true,
    onChange: (event, active) => Widget.setShown(active)
  };
});
