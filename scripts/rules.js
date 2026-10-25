/**
 * The rules, with no Foundry dependencies so they can be tested on their own.
 *
 * Two kinds of action, both from Raiders of the Serpent Sea:
 *
 *  - Companion actions (Companion Rules, Chapter 1; each companion in
 *    Appendix D). A companion gives up its turn for a pool of points, usually
 *    3. At the end of a hero's turn, that hero may spend points on one of the
 *    companion's options, some of which cost 2 or 3. The pool refills at the
 *    start of the companion's turn (or, for Mirgal, at initiative count 15).
 *  - Heroic Actions (Chapter 12, Ragnarök). Each ally adds one. Each may be
 *    used once per round, after any creature's turn, and some have a limited
 *    number of uses ("2x").
 *
 * And effect markers: reminders placed in the initiative order, such as
 * "stunned until the end of its next turn".
 */

export class RuleError extends Error {}

/* -------------------------------------------- */
/*  Library                                     */
/* -------------------------------------------- */

export const REFRESH = {
  turn: "At the start of its turn",
  count: "At an initiative count",
  round: "At the start of each round"
};

export const LIMIT_PERIODS = {
  combat: "per combat",
  rest: "per long rest",
  total: "in total"
};

const str = (value, max) => String(value ?? "").trim().slice(0, max);
const int = (value, fallback, min, max) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
let idCounter = 0;
export const newId = () => `${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normalizeLimit(limit) {
  if (!limit || !Number(limit.uses)) return null;
  return { uses: int(limit.uses, 1, 1, 99), per: limit.per in LIMIT_PERIODS ? limit.per : "combat" };
}

function normalizeAction(input, maxCost) {
  return {
    id: str(input.id, 40) || newId(),
    name: str(input.name, 80) || "Action",
    cost: int(input.cost, 1, 1, maxCost),
    description: str(input.description, 2000),
    limit: normalizeLimit(input.limit)
  };
}

export function normalizeCompanion(input) {
  const points = int(input.points, 3, 1, 10);
  return {
    id: str(input.id, 40) || newId(),
    name: str(input.name, 80) || "Companion",
    img: str(input.img, 500),
    actorId: str(input.actorId, 40) || null,
    // Whether the companion is with the party right now; inactive ones are hidden and never refresh.
    active: input.active !== false,
    points,
    refresh: input.refresh in REFRESH ? input.refresh : "turn",
    refreshCount: int(input.refreshCount, 15, -10, 50),
    actions: (Array.isArray(input.actions) ? input.actions : []).slice(0, 20).map(a => normalizeAction(a, points))
  };
}

export function normalizeHeroic(input) {
  return {
    id: str(input.id, 40) || newId(),
    name: str(input.name, 80) || "Heroic Action",
    ally: str(input.ally, 80),
    description: str(input.description, 2000),
    available: input.available !== false,
    limit: normalizeLimit(input.limit)
  };
}

export function normalizeLibrary(input = {}) {
  return {
    companions: (Array.isArray(input.companions) ? input.companions : []).slice(0, 20).map(normalizeCompanion),
    heroics: (Array.isArray(input.heroics) ? input.heroics : []).slice(0, 50).map(normalizeHeroic)
  };
}

/* -------------------------------------------- */
/*  State                                       */
/* -------------------------------------------- */

/**
 * State for one combat, stored on the Combat:
 *  - spent: points spent per companion since it last refreshed
 *  - usedThisRound: heroic action ids used this round
 *  - uses: uses of "per combat" limited actions
 *  - log: what was used, newest last
 * Uses of "per rest" and "in total" actions outlive the combat and are kept
 * separately (`usage`).
 */
export const emptyCombatState = () => ({ round: 0, spent: {}, usedThisRound: [], uses: {}, log: [] });

export function normalizeCombatState(state) {
  return { ...emptyCombatState(), ...(state ?? {}) };
}

export const companionKey = (companionId, actionId) => `c:${companionId}:${actionId}`;
export const heroicKey = heroicId => `h:${heroicId}`;

function usesOf(limit, key, state, usage) {
  if (!limit) return 0;
  return limit.per === "combat" ? (state.uses[key] ?? 0) : (usage[key] ?? 0);
}

/** Points a companion has left. */
export function pointsLeft(companion, state) {
  return Math.max(0, companion.points - (state.spent[companion.id] ?? 0));
}

/** Uses left of a limited action, or null if it's unlimited. */
export function usesLeft(limit, key, state, usage) {
  return limit ? Math.max(0, limit.uses - usesOf(limit, key, state, usage)) : null;
}

/**
 * Whether an action can be used now, and why not if it can't.
 * @returns {{ ok: boolean, reason?: string }}
 */
export function check(library, state, usage, request) {
  if (request.kind === "companion") {
    const companion = library.companions.find(c => c.id === request.companionId);
    const action = companion?.actions.find(a => a.id === request.actionId);
    if (!action) return { ok: false, reason: "That companion action no longer exists." };
    if (!companion.active) return { ok: false, reason: `${companion.name} isn't with the party.` };
    if (pointsLeft(companion, state) < action.cost) {
      return { ok: false, reason: `${companion.name} has ${pointsLeft(companion, state)} of ${companion.points} actions left; ${action.name} costs ${action.cost}.` };
    }
    if (usesLeft(action.limit, companionKey(companion.id, action.id), state, usage) === 0) {
      return { ok: false, reason: `${action.name} has no uses left ${LIMIT_PERIODS[action.limit.per]}.` };
    }
    return { ok: true };
  }
  if (request.kind === "heroic") {
    const heroic = library.heroics.find(h => h.id === request.heroicId);
    if (!heroic) return { ok: false, reason: "That heroic action no longer exists." };
    if (!heroic.available) return { ok: false, reason: `${heroic.name} isn't available.` };
    if (state.usedThisRound.includes(heroic.id)) return { ok: false, reason: `${heroic.name} has already been used this round.` };
    if (usesLeft(heroic.limit, heroicKey(heroic.id), state, usage) === 0) {
      return { ok: false, reason: `${heroic.name} has no uses left ${LIMIT_PERIODS[heroic.limit.per]}.` };
    }
    return { ok: true };
  }
  return { ok: false, reason: "Unknown action." };
}

/**
 * Spend an action. Returns new state and usage, and a log entry; throws
 * RuleError if it can't be used.
 * @param {object} request  { kind: "companion", companionId, actionId } or { kind: "heroic", heroicId }
 * @param {object} context  { by, round, turn } for the log
 */
export function spend(library, state, usage, request, context = {}) {
  const verdict = check(library, state, usage, request);
  if (!verdict.ok) throw new RuleError(verdict.reason);
  const next = structuredClone(state);
  const nextUsage = { ...usage };
  let entry;

  const count = (limit, key) => {
    if (!limit) return;
    if (limit.per === "combat") next.uses[key] = (next.uses[key] ?? 0) + 1;
    else nextUsage[key] = (nextUsage[key] ?? 0) + 1;
  };

  if (request.kind === "companion") {
    const companion = library.companions.find(c => c.id === request.companionId);
    const action = companion.actions.find(a => a.id === request.actionId);
    next.spent[companion.id] = (next.spent[companion.id] ?? 0) + action.cost;
    count(action.limit, companionKey(companion.id, action.id));
    entry = { kind: "companion", companionId: companion.id, actionId: action.id, source: companion.name, name: action.name, cost: action.cost };
  }
  else {
    const heroic = library.heroics.find(h => h.id === request.heroicId);
    next.usedThisRound.push(heroic.id);
    count(heroic.limit, heroicKey(heroic.id));
    entry = { kind: "heroic", heroicId: heroic.id, source: heroic.ally || "Heroic Action", name: heroic.name };
  }

  entry = { id: newId(), ...entry, by: context.by ?? "", round: context.round ?? state.round, at: context.at ?? Date.now() };
  next.log = [...next.log, entry].slice(-50);
  return { state: next, usage: nextUsage, entry };
}

/** Undo a logged use: give back its points, its round use and its limited use. */
export function undo(library, state, usage, entryId) {
  const entry = state.log.find(e => e.id === entryId);
  if (!entry) throw new RuleError("That use is no longer in the log.");
  const next = structuredClone(state);
  const nextUsage = { ...usage };
  const uncount = (limit, key) => {
    if (!limit) return;
    const target = limit.per === "combat" ? next.uses : nextUsage;
    target[key] = Math.max(0, (target[key] ?? 0) - 1);
  };

  if (entry.kind === "companion") {
    next.spent[entry.companionId] = Math.max(0, (next.spent[entry.companionId] ?? 0) - entry.cost);
    const action = library.companions.find(c => c.id === entry.companionId)?.actions.find(a => a.id === entry.actionId);
    uncount(action?.limit, companionKey(entry.companionId, entry.actionId));
  }
  else {
    if (entry.round === state.round) next.usedThisRound = next.usedThisRound.filter(id => id !== entry.heroicId);
    const heroic = library.heroics.find(h => h.id === entry.heroicId);
    uncount(heroic?.limit, heroicKey(entry.heroicId));
  }
  next.log = next.log.filter(e => e.id !== entryId);
  return { state: next, usage: nextUsage };
}

export function refreshCompanion(state, companionId) {
  const next = structuredClone(state);
  delete next.spent[companionId];
  return next;
}

/** A new round: heroic actions can be used again, and "each round" companions refill. */
export function startRound(library, state, round) {
  const next = structuredClone(state);
  next.round = round;
  next.usedThisRound = [];
  for (const companion of library.companions) {
    if (companion.refresh === "round") delete next.spent[companion.id];
  }
  return next;
}

/** A combatant's turn started: companions linked to its actor refill. Returns the companions refreshed too. */
export function startTurn(library, state, actorId) {
  const refreshed = library.companions.filter(c => c.active && c.refresh === "turn" && c.actorId && c.actorId === actorId);
  const next = structuredClone(state);
  for (const companion of refreshed) delete next.spent[companion.id];
  return { state: next, refreshed };
}

/** Clear "per long rest" uses. */
export function longRest(library, usage) {
  const next = { ...usage };
  for (const companion of library.companions) {
    for (const action of companion.actions) if (action.limit?.per === "rest") delete next[companionKey(companion.id, action.id)];
  }
  for (const heroic of library.heroics) if (heroic.limit?.per === "rest") delete next[heroicKey(heroic.id)];
  return next;
}

/* -------------------------------------------- */
/*  Turn order                                  */
/* -------------------------------------------- */

/**
 * The combatant whose turn just ended, skipping markers: the "hero whose turn
 * it was" for companion actions spent between turns.
 * @param {object[]} turns  Combatants in turn order, each { id, isMarker }
 * @param {number} turn     Index of the current turn
 * @param {object} [options]
 * @param {boolean} [options.wrap]  Whether the previous round's last turn counts; not in round 1, which had none
 */
export function previousCombatant(turns, turn, { wrap = true } = {}) {
  if (!turns.length) return null;
  for (let step = 1; step <= turns.length; step++) {
    const index = turn - step;
    if (index < 0 && !wrap) return null;
    const candidate = turns[(index + turns.length * 2) % turns.length];
    if (!candidate.isMarker) return candidate;
  }
  return null;
}

/* -------------------------------------------- */
/*  Markers                                     */
/* -------------------------------------------- */

export const TIMINGS = {
  endOfTurn: "End of a combatant's next turn",
  startOfTurn: "Start of a combatant's next turn",
  startOfRound: "Start of the next round",
  count: "At an initiative count"
};

/** How far a marker sits from its anchor: small enough to stay next to it, never tying with it. */
const STEP = 0.001;

/**
 * Where a marker goes in the initiative order.
 * @param {object} marker      { timing, anchorId, count }
 * @param {object[]} combatants Each { id, initiative, isMarker }
 * @param {string} [selfId]     The marker's own id, when repositioning it
 */
export function markerInitiative(marker, combatants, selfId = null) {
  const others = combatants.filter(c => c.id !== selfId && c.initiative !== null && c.initiative !== undefined);
  const real = others.filter(c => !c.isMarker);
  const taken = new Set(others.map(c => Math.round(c.initiative / STEP)));
  // Step further away until the slot is free, so markers sharing an anchor stay in creation order.
  const free = (start, direction) => {
    let value = start;
    while (taken.has(Math.round(value / STEP))) value += direction * STEP;
    return Math.round(value / STEP) * STEP;
  };

  if (marker.timing === "count") return free(Number(marker.count) - STEP, -1);
  if (marker.timing === "startOfRound") {
    const top = real.length ? Math.max(...real.map(c => c.initiative)) : 20;
    return free(Math.floor(top) + 1, 1);
  }
  const anchor = combatants.find(c => c.id === marker.anchorId);
  if (!anchor || anchor.initiative === null || anchor.initiative === undefined) return null;
  return marker.timing === "endOfTurn" ? free(anchor.initiative - STEP, -1) : free(anchor.initiative + STEP, 1);
}

/** Describe a marker's timing in a few words, for the tracker and reminders. */
export function describeTiming(marker, anchorName = "") {
  const who = anchorName || "its anchor";
  const base = {
    endOfTurn: `end of ${who}'s next turn`,
    startOfTurn: `start of ${who}'s next turn`,
    startOfRound: "start of the next round",
    count: `initiative ${marker.count}`
  }[marker.timing] ?? "";
  if (!marker.repeat) return base;
  const every = {
    endOfTurn: `end of each of ${who}'s turns`,
    startOfTurn: `start of each of ${who}'s turns`,
    startOfRound: "start of each round",
    count: `initiative ${marker.count} each round`
  }[marker.timing];
  return marker.rounds ? `${every}, ${marker.rounds} more` : every;
}

/**
 * The anchor's turn started: markers waiting for the end of that turn are now
 * armed, and will go off when the tracker reaches them.
 */
export function armMarkers(markers, anchorId) {
  return markers.filter(m => m.timing === "endOfTurn" && m.anchorId === anchorId && !m.armed).map(m => m.id);
}

/**
 * The tracker reached a marker. Decide whether it goes off and what becomes of it.
 * @returns {{ fire: boolean, remove: boolean, update?: object }}
 */
export function reachMarker(marker) {
  // "End of its next turn" only counts once the anchor has started a turn since the marker was made.
  if (marker.timing === "endOfTurn" && !marker.armed) return { fire: false, remove: false };
  if (!marker.repeat) return { fire: true, remove: true };
  if (marker.rounds !== null && marker.rounds !== undefined) {
    const left = marker.rounds - 1;
    if (left <= 0) return { fire: true, remove: true };
    return { fire: true, remove: false, update: { rounds: left, armed: false } };
  }
  return { fire: true, remove: false, update: { armed: false } };
}

export function normalizeMarker(input) {
  const timing = input.timing in TIMINGS ? input.timing : "endOfTurn";
  const repeat = !!input.repeat;
  const rounds = repeat && Number(input.rounds) > 0 ? int(input.rounds, 1, 1, 100) : null;
  return {
    id: str(input.id, 40) || newId(),
    text: str(input.text, 120) || "Reminder",
    details: str(input.details, 500),
    timing,
    anchorId: timing === "endOfTurn" || timing === "startOfTurn" ? str(input.anchorId, 40) || null : null,
    count: int(input.count, 10, -10, 50),
    repeat,
    rounds,
    armed: false,
    hidden: !!input.hidden,
    refreshCompanionId: str(input.refreshCompanionId, 40) || null
  };
}
