/**
 * Effect markers in the combat tracker, and what happens as turns change.
 *
 * A marker is a real Combatant with no actor or token, flagged with its
 * reminder. It's placed in the initiative order next to the creature it's
 * about (see Rules.markerInitiative). When the tracker reaches it, the active
 * GM's browser posts the reminder if it's due, moves the turn on, and removes
 * the marker once it's done.
 *
 * Turn changes also drive the action rules: a new round resets heroic actions,
 * and a companion's turn refills its companion actions.
 */

import * as Rules from "./rules.js";
import { MODULE_ID, activeGM, getCombatState, getLibrary, isActiveGM, isMarker, mutate, postRefreshNote, postReminder, serially, turnsOf } from "./core.js";

const ICON = "icons/svg/clockwork.svg";

export const markerOf = combatant => combatant.getFlag(MODULE_ID, "marker");
export const markersIn = combat => (combat?.combatants.contents ?? []).filter(isMarker);

/** Combatants with what Rules.markerInitiative needs. */
const placement = combat => combat.combatants.contents.map(c => ({ id: c.id, initiative: c.initiative, isMarker: isMarker(c) }));

export function describeMarker(combat, marker) {
  const anchor = marker.anchorId ? combat?.combatants.get(marker.anchorId) : null;
  return Rules.describeTiming(marker, anchor?.name ?? "");
}

/** Add a marker to a combat. Runs in a GM's browser. */
export async function createMarker(combat, input) {
  const marker = Rules.normalizeMarker(input);
  const initiative = Rules.markerInitiative(marker, placement(combat));
  if (initiative === null) {
    throw new Rules.RuleError(marker.anchorId ? "That combatant has no initiative yet. Roll initiative first." : "Choose a combatant for this marker.");
  }
  const [created] = await combat.createEmbeddedDocuments("Combatant", [{
    name: marker.text,
    img: ICON,
    initiative,
    hidden: marker.hidden,
    flags: { [MODULE_ID]: { marker } }
  }]);
  return created;
}

export const removeMarker = combatant => (isMarker(combatant) ? combatant.delete() : null);

/**
 * Companions that refresh at an initiative count (like Mirgal at 15) get a
 * repeating marker that does the refresh. Keep those in step with the library.
 */
export function syncRefreshMarkers(combat) {
  if (!combat || !isActiveGM()) return Promise.resolve();
  // Queued, so two quick calls can't both create the same marker.
  return serially(() => sync(combat));
}

async function sync(combat) {
  const wanted = getLibrary().companions.filter(c => c.active && c.refresh === "count");
  const existing = markersIn(combat).filter(c => markerOf(c).refreshCompanionId);
  const stale = existing.filter(c => {
    const companion = wanted.find(w => w.id === markerOf(c).refreshCompanionId);
    return !companion || companion.refreshCount !== markerOf(c).count;
  });
  if (stale.length) await combat.deleteEmbeddedDocuments("Combatant", stale.map(c => c.id));
  for (const companion of wanted) {
    if (existing.some(c => !stale.includes(c) && markerOf(c).refreshCompanionId === companion.id)) continue;
    await createMarker(combat, {
      text: `${companion.name} regains actions`,
      timing: "count", count: companion.refreshCount, repeat: true,
      refreshCompanionId: companion.id
    });
  }
}

/* -------------------------------------------- */
/*  Turn changes                                */
/* -------------------------------------------- */

/** The tracker landed on a marker: remind if due, step past it, then tidy it up. */
async function reach(combat, combatant, direction) {
  if (combat.turns.every(isMarker)) return;
  if (direction < 0) return combat.previousTurn();

  const marker = markerOf(combatant);
  const outcome = Rules.reachMarker(marker);
  // Refresh markers are only reminders: the refill itself happens in refreshAtCount.
  if (outcome.fire && !marker.refreshCompanionId) await postReminder(marker, describeMarker(combat, marker));
  // Move on first: deleting the current combatant would shift the turn order under us.
  await combat.nextTurn();
  if (outcome.remove) await combatant.delete();
  else if (outcome.update) await combatant.setFlag(MODULE_ID, "marker", { ...marker, ...outcome.update });
}

/**
 * Refill companions that refresh at an initiative count, once a round, when
 * the turn passes their count (see Rules.countRefreshes), and tell the GM.
 */
async function refreshAtCount(combat, combatant, newRound) {
  const library = getLibrary();
  if (!library.companions.some(c => c.active && c.refresh === "count")) return;
  let refreshed = [];
  await mutate(combat, state => {
    const result = Rules.countRefreshes(library, state, { round: combat.round, initiative: combatant.initiative, newRound });
    refreshed = result.refreshed;
    return refreshed.length ? { state: result.state } : {};
  });
  for (const companion of refreshed) await postRefreshNote(companion);
}

/** A real combatant's turn started: refill linked companions and arm "end of next turn" markers. */
async function turnStarted(combat, combatant) {
  const library = getLibrary();
  if (combatant.actorId && library.companions.some(c => c.actorId === combatant.actorId)) {
    await mutate(combat, state => ({ state: Rules.startTurn(library, state, combatant.actorId).state }));
  }
  const markers = markersIn(combat);
  const armed = Rules.armMarkers(markers.map(markerOf), combatant.id);
  for (const id of armed) {
    const marker = markers.find(c => markerOf(c).id === id);
    await marker.setFlag(MODULE_ID, "marker", { ...markerOf(marker), armed: true });
  }
}

/**
 * Called from the updateCombat hook. Only the active GM acts, so the work
 * happens once however many clients are connected.
 */
const lastPosition = new Map();

export async function onUpdateCombat(combat, changed, options = {}) {
  if (!isActiveGM() || !combat.started) return;
  if (!("turn" in changed) && !("round" in changed)) return;

  // Foundry passes the direction when stepping turns; otherwise compare with where we were.
  const last = lastPosition.get(combat.id);
  lastPosition.set(combat.id, { round: combat.round, turn: combat.turn });
  const direction = options.direction
    ?? (last && (combat.round < last.round || (combat.round === last.round && combat.turn < last.turn)) ? -1 : 1);

  const library = getLibrary();
  let newRound = false;
  if (combat.round > getCombatState(combat).round) {
    const { state } = await mutate(combat, current =>
      (current.round < combat.round ? { state: Rules.startRound(library, current, combat.round) } : {}));
    newRound = !!state;
    if (state) await syncRefreshMarkers(combat);
  }

  const combatant = combat.combatant;
  if (!combatant) return;
  if (direction > 0) await refreshAtCount(combat, combatant, newRound);
  if (isMarker(combatant)) await reach(combat, combatant, direction);
  else if (direction > 0) await turnStarted(combat, combatant);
}

/** An anchor's initiative changed: keep its markers next to it. */
export async function onUpdateCombatant(combatant, changed) {
  if (!isActiveGM() || !("initiative" in changed) || isMarker(combatant)) return;
  const combat = combatant.combat ?? combatant.parent;
  for (const marker of markersIn(combat)) {
    const data = markerOf(marker);
    if (data.anchorId !== combatant.id && data.timing !== "startOfRound") continue;
    const initiative = Rules.markerInitiative(data, placement(combat), marker.id);
    if (initiative !== null && initiative !== marker.initiative) await marker.update({ initiative });
  }
}

/** An anchor left the combat: its markers still go off once, the next time they're reached. */
export async function onDeleteCombatant(combatant) {
  if (!isActiveGM() || isMarker(combatant)) return;
  const combat = combatant.combat ?? combatant.parent;
  for (const marker of markersIn(combat)) {
    const data = markerOf(marker);
    if (data.anchorId === combatant.id && data.timing === "endOfTurn" && !data.armed) {
      await marker.setFlag(MODULE_ID, "marker", { ...data, armed: true });
    }
  }
}

export { activeGM, turnsOf };
