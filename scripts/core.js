/**
 * Settings, saved state, permissions and chat cards.
 *
 * Where things live:
 *  - The library (companions, their actions, heroic actions): world setting "library".
 *  - Per-combat state (points spent, heroic actions used this round, the log):
 *    a flag on the Combat, so each fight starts fresh.
 *  - Uses of "per long rest" and "in total" limited actions: world setting "usage".
 *
 * Only a GM's browser writes any of these. Players' requests are sent to the
 * active GM over the module socket, checked there, and carried out.
 */

import * as Rules from "./rules.js";

export const MODULE_ID = "rotss-heroic-tracker";
export const SOCKET = `module.${MODULE_ID}`;

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

export function registerSettings(onChange) {
  game.settings.register(MODULE_ID, "library", {
    scope: "world", config: false, type: Object, default: { companions: [], heroics: [] }, onChange
  });
  game.settings.register(MODULE_ID, "usage", { scope: "world", config: false, type: Object, default: {}, onChange });
  game.settings.register(MODULE_ID, "whoSpends", {
    name: "Who can use companion actions",
    hint: "The book has the hero whose turn just ended choose the companion action. Heroic actions can be used by any player either way, unless only the GM can use actions.",
    scope: "world", config: true, type: String, default: "turn",
    choices: {
      turn: "Players, during or just after their own turn",
      any: "Players, at any time",
      gm: "Only the GM"
    },
    onChange
  });
  game.settings.register(MODULE_ID, "playersAddMarkers", {
    name: "Players can add effect markers",
    hint: "Lets players put reminders in the initiative order, e.g. for their own spells' durations. The GM can always add and remove them.",
    scope: "world", config: true, type: Boolean, default: true, onChange
  });
  game.settings.register(MODULE_ID, "chatCards", {
    name: "Post used actions to chat",
    hint: "A chat card for each companion or heroic action used, with its description and what's left.",
    scope: "world", config: true, type: Boolean, default: true
  });
}

export const getLibrary = () => Rules.normalizeLibrary(game.settings.get(MODULE_ID, "library"));
export const getUsage = () => ({ ...(game.settings.get(MODULE_ID, "usage") ?? {}) });
export const getCombatState = combat => Rules.normalizeCombatState(combat?.getFlag(MODULE_ID, "state"));

/* -------------------------------------------- */
/*  Writing                                     */
/*  Settings and flags are saved whole and read */
/*  their old value until the server confirms,  */
/*  so every read-modify-write goes through one */
/*  queue.                                      */
/* -------------------------------------------- */

let tail = Promise.resolve();
export function serially(task) {
  const run = tail.then(task, task);
  tail = run.catch(() => {});
  return run;
}

export const activeGM = () => game.users.activeGM ?? null;
export const isActiveGM = () => game.user === activeGM();

/**
 * Change the combat state and usage together.
 * @param {Combat} combat
 * @param {(state, usage) => { state?, usage? }} change
 */
export function mutate(combat, change) {
  return serially(async () => {
    const before = getCombatState(combat);
    const usage = getUsage();
    const result = change(before, usage) ?? {};
    if (result.state && combat) await combat.setFlag(MODULE_ID, "state", result.state);
    if (result.usage) await game.settings.set(MODULE_ID, "usage", result.usage);
    return result;
  });
}

export function saveLibrary(library) {
  return serially(() => game.settings.set(MODULE_ID, "library", Rules.normalizeLibrary(library)));
}

/* -------------------------------------------- */
/*  Who may act                                 */
/* -------------------------------------------- */

export const isMarker = combatant => !!combatant?.getFlag?.(MODULE_ID, "marker");

/** Turn order as the rules see it: { id, initiative, isMarker }. */
export function turnsOf(combat) {
  return (combat?.turns ?? []).map(c => ({ id: c.id, initiative: c.initiative, isMarker: isMarker(c) }));
}

/**
 * An actor's movement as text, after dnd5e has applied conditions and
 * encumbrance. dnd5e 6 keeps speeds in movement.speeds; earlier versions put
 * them on movement itself.
 */
export function actorSpeed(actor) {
  const movement = actor?.system?.attributes?.movement;
  if (!movement) return null;
  const types = CONFIG.DND5E?.movementTypes ?? {};
  const keys = Object.keys(types).length ? Object.keys(types) : ["walk", "burrow", "climb", "fly", "swim"];
  const source = movement.speeds ?? movement;
  const speeds = Object.fromEntries(keys.map(k => [k, source[k]]));
  const labels = Object.fromEntries(keys.map(k => [k, game.i18n.localize(types[k]?.label ?? k)]));
  return Rules.formatSpeed({ speeds, units: movement.units, hover: movement.hover, special: movement.special }, labels);
}

const owns = (user, combatant) => !!combatant?.actor?.testUserPermission(user, "OWNER");

/**
 * The hero acting for a user: the combatant whose turn it is, or whose turn
 * just ended, if the user owns it.
 */
export function actingCombatant(combat, user) {
  if (!combat?.started) return null;
  const current = combat.combatant;
  if (current && !isMarker(current) && owns(user, current)) return current;
  const previous = Rules.previousCombatant(turnsOf(combat), combat.turn ?? 0, { wrap: combat.round > 1 });
  const prior = previous ? combat.combatants.get(previous.id) : null;
  return prior && owns(user, prior) ? prior : null;
}

/** Whether a user may use this kind of action right now, and why not. */
export function mayUse(combat, user, kind) {
  if (user.isGM) return { ok: true };
  const mode = game.settings.get(MODULE_ID, "whoSpends");
  if (mode === "gm") return { ok: false, reason: "Only the GM can use these actions." };
  if (!combat?.started) return { ok: false, reason: "There's no combat running." };
  if (kind === "heroic" || mode === "any") return { ok: true };
  if (actingCombatant(combat, user)) return { ok: true };
  return { ok: false, reason: "Companion actions are chosen by the hero whose turn it is, or whose turn just ended." };
}

/** How the log names whoever used an action: "Isen (Ursula)", or just the name for the GM (who owns everything). */
export function actorLabel(combat, user) {
  if (user.isGM) return user.name;
  const hero = actingCombatant(combat, user);
  return hero && hero.name !== user.name ? `${hero.name} (${user.name})` : user.name;
}

/* -------------------------------------------- */
/*  Chat                                        */
/* -------------------------------------------- */

const esc = text => foundry.utils.escapeHTML?.(String(text ?? "")) ?? Handlebars.escapeExpression(String(text ?? ""));
const paragraphs = text => String(text ?? "").split(/\n{2,}/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");

export async function postUseCard(library, state, usage, entry) {
  if (!game.settings.get(MODULE_ID, "chatCards")) return;
  let title;
  let remaining;
  let description;
  let img = "icons/svg/aura.svg";
  if (entry.kind === "companion") {
    const companion = library.companions.find(c => c.id === entry.companionId);
    const action = companion?.actions.find(a => a.id === entry.actionId);
    title = `${esc(entry.source)}: ${esc(entry.name)}`;
    const left = companion ? Rules.pointsLeft(companion, state) : 0;
    remaining = `Costs ${entry.cost} · ${left} of ${companion?.points ?? "?"} left`;
    const uses = action ? Rules.usesLeft(action.limit, Rules.companionKey(companion.id, action.id), state, usage) : null;
    if (uses !== null) remaining += ` · ${uses} use${uses === 1 ? "" : "s"} left ${Rules.LIMIT_PERIODS[action.limit.per]}`;
    description = action?.description;
    img = companion?.img || game.actors.get(companion?.actorId)?.img || img;
  }
  else {
    const heroic = library.heroics.find(h => h.id === entry.heroicId);
    title = `Heroic Action: ${esc(entry.name)}`;
    const uses = heroic ? Rules.usesLeft(heroic.limit, Rules.heroicKey(heroic.id), state, usage) : null;
    remaining = uses === null ? "Once per round" : `Once per round · ${uses} use${uses === 1 ? "" : "s"} left ${Rules.LIMIT_PERIODS[heroic.limit.per]}`;
    description = heroic?.description;
  }

  await ChatMessage.implementation.create({
    speaker: { alias: entry.source },
    content: `<div class="rotss-heroic-card">
      <header><img src="${esc(img)}" alt=""><h3>${title}</h3></header>
      <p class="rotss-heroic-meta">${esc(remaining)}</p>
      ${description ? paragraphs(description) : ""}
      <footer>Used by ${esc(entry.by)}</footer>
    </div>`,
    flags: { [MODULE_ID]: { entryId: entry.id } }
  });
}

export async function postReminder(marker, timing) {
  const gmOnly = marker.hidden || !!marker.refreshCompanionId;
  await ChatMessage.implementation.create({
    speaker: { alias: "Reminder" },
    whisper: gmOnly ? game.users.filter(u => u.isGM).map(u => u.id) : [],
    content: `<div class="rotss-heroic-reminder">
      <h3><i class="fa-solid fa-hourglass-end"></i> ${esc(marker.text)}</h3>
      ${marker.details ? paragraphs(marker.details) : ""}
      <footer>${esc(timing)}</footer>
    </div>`
  });
}

/* -------------------------------------------- */
/*  Requests                                    */
/*  Run in the active GM's browser.             */
/* -------------------------------------------- */

/**
 * Spend an action for a user. Throws Rules.RuleError with a message for the
 * user if they can't.
 */
export async function performSpend(user, combat, request) {
  const allowed = mayUse(combat, user, request.kind);
  if (!allowed.ok) throw new Rules.RuleError(allowed.reason);
  const library = getLibrary();
  const by = actorLabel(combat, user);
  const result = await mutate(combat, (state, usage) =>
    Rules.spend(library, state, usage, request, { by, round: combat?.round ?? 0 }));
  await postUseCard(library, result.state, result.usage, result.entry);
  return result.entry;
}

export async function performUndo(combat, entryId) {
  const library = getLibrary();
  await mutate(combat, (state, usage) => Rules.undo(library, state, usage, entryId));
  const message = game.messages.find(m => m.getFlag(MODULE_ID, "entryId") === entryId);
  await message?.delete();
}

export function refreshCompanion(combat, companionId) {
  return mutate(combat, state => ({ state: Rules.refreshCompanion(state, companionId) }));
}

export function longRest() {
  return mutate(null, (state, usage) => ({ usage: Rules.longRest(getLibrary(), usage) }));
}

/** Clear the remembered uses (per long rest and in total) of one action, or of every action. */
export function resetUses(key = null) {
  return mutate(null, (state, usage) => {
    const next = { ...usage };
    for (const k of Object.keys(next)) if (!key || k === key) delete next[k];
    return { usage: next };
  });
}
