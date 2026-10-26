/**
 * What the tracker window and the canvas widget show for each companion:
 * pips, refresh rule, speed, and each action with whether this user can use
 * it right now (and why not).
 */

import * as Rules from "./rules.js";
import * as Core from "./core.js";

/** Whether an action can be used now, for buttons: { disabled, reason }. */
export function verdict(combat, library, state, usage, may, request) {
  if (!combat) return { disabled: true, reason: "Start a combat to use actions." };
  if (!may.ok) return { disabled: true, reason: may.reason };
  const check = Rules.check(library, state, usage, request);
  return check.ok ? { disabled: false, reason: "" } : { disabled: true, reason: check.reason };
}

export function usesLabel(limit, key, state, usage) {
  const left = Rules.usesLeft(limit, key, state, usage);
  return left === null ? "" : `${left}/${limit.uses} ${Rules.LIMIT_PERIODS[limit.per]}`;
}

/**
 * Companions as cards.
 * @param {object} options
 * @param {boolean} [options.includeInactive]  The GM's window also lists companions away from the party
 */
export function companionCards(combat, user, { includeInactive = false } = {}) {
  const library = Core.getLibrary();
  const state = Core.getCombatState(combat);
  const usage = Core.getUsage();
  const may = Core.mayUse(combat, user, "companion");
  const inCombat = new Set((combat?.combatants.contents ?? []).map(c => c.actorId).filter(Boolean));

  return library.companions.filter(c => includeInactive || c.active).map(c => {
    const actor = c.actorId ? game.actors.get(c.actorId) : null;
    const left = Rules.pointsLeft(c, state);
    const refreshLabel = c.refresh === "count" ? `Refreshes at initiative ${c.refreshCount}` : c.refresh === "round" ? "Refreshes each round" : "Refreshes on its turn";
    let warning = "";
    if (c.refresh === "turn" && !c.actorId) warning = "Not linked to an actor, so it only refreshes by hand.";
    else if (c.refresh === "turn" && combat && !inCombat.has(c.actorId)) warning = "Its actor isn't in this combat, so it only refreshes by hand.";
    return {
      ...c,
      img: c.img || actor?.img || "",
      speed: Core.actorSpeed(actor),
      left,
      pips: Array.from({ length: c.points }, (_, i) => ({ on: i < left })),
      refreshLabel,
      warning,
      actions: c.actions.map(a => ({
        ...a,
        usesLabel: usesLabel(a.limit, Rules.companionKey(c.id, a.id), state, usage),
        ...verdict(combat, library, state, usage, may, { kind: "companion", companionId: c.id, actionId: a.id })
      }))
    };
  });
}

/** Heroic actions as cards. Players see only the available ones. */
export function heroicCards(combat, user, { includeUnavailable = false } = {}) {
  const library = Core.getLibrary();
  const state = Core.getCombatState(combat);
  const usage = Core.getUsage();
  const may = Core.mayUse(combat, user, "heroic");
  return library.heroics.filter(h => includeUnavailable || h.available).map(h => ({
    ...h,
    used: state.usedThisRound.includes(h.id),
    usesLabel: usesLabel(h.limit, Rules.heroicKey(h.id), state, usage),
    ...verdict(combat, library, state, usage, may, { kind: "heroic", heroicId: h.id })
  }));
}
