/**
 * Every change goes through here. In the active GM's browser it runs at once;
 * anywhere else it's sent to the active GM over the module socket, so all
 * writes happen in one place and in order, and players never need permission
 * to change combats or settings.
 */

import * as Rules from "./rules.js";
import * as Core from "./core.js";
import * as Markers from "./markers.js";

const { MODULE_ID, SOCKET } = Core;

const gmOnly = user => {
  if (!user.isGM) throw new Rules.RuleError("Only the GM can do that.");
};
const combatFor = id => game.combats.get(id) ?? null;

/** What each request does, given the user who asked. */
const HANDLERS = {
  spend: (user, { combatId, request }) => Core.performSpend(user, combatFor(combatId), request),

  addMarker(user, { combatId, input }) {
    if (!user.isGM && !game.settings.get(MODULE_ID, "playersAddMarkers")) throw new Rules.RuleError("The GM hasn't allowed players to add markers.");
    const combat = combatFor(combatId);
    if (!combat) throw new Rules.RuleError("There's no combat to add a marker to.");
    // Players can't make hidden markers or ones that refresh companions.
    const safe = user.isGM ? input : { ...input, hidden: false, refreshCompanionId: null };
    return Markers.createMarker(combat, safe);
  },

  removeMarker(user, { combatId, combatantId }) {
    gmOnly(user);
    return Markers.removeMarker(combatFor(combatId)?.combatants.get(combatantId));
  },

  undo(user, { combatId, entryId }) {
    gmOnly(user);
    return Core.performUndo(combatFor(combatId), entryId);
  },

  refresh(user, { combatId, companionId }) {
    gmOnly(user);
    return Core.refreshCompanion(combatFor(combatId), companionId);
  },

  resetRound(user, { combatId }) {
    gmOnly(user);
    return Core.resetRound(combatFor(combatId));
  },

  async setActive(user, { companionId, active }) {
    gmOnly(user);
    const library = Core.getLibrary();
    const companion = library.companions.find(c => c.id === companionId);
    if (companion) companion.active = !!active;
    await Core.saveLibrary(library);
  },

  async setAvailable(user, { heroicId, available }) {
    gmOnly(user);
    const library = Core.getLibrary();
    const heroic = library.heroics.find(h => h.id === heroicId);
    if (heroic) heroic.available = !!available;
    await Core.saveLibrary(library);
  },

  saveLibrary(user, { library }) {
    gmOnly(user);
    return Core.saveLibrary(library);
  },

  longRest(user) {
    gmOnly(user);
    return Core.longRest();
  },

  resetUses(user, { key = null } = {}) {
    gmOnly(user);
    return Core.resetUses(key);
  }
};

/** Carry out a request from a user. Throws Rules.RuleError with a message for them. */
export function handle(user, type, payload = {}) {
  const handler = HANDLERS[type];
  if (!handler || !Object.hasOwn(HANDLERS, type)) throw new Rules.RuleError(`Unknown request: ${type}`);
  return handler(user, payload);
}

/**
 * Ask for a change. Resolves once it's been carried out locally, or once it's
 * been sent to the GM; problems are shown as notifications either way.
 */
export async function request(type, payload = {}) {
  try {
    if (Core.isActiveGM()) return await handle(game.user, type, payload);
    if (!Core.activeGM()) throw new Rules.RuleError("A GM needs to be logged in.");
    game.socket.emit(SOCKET, { type, payload, userId: game.user.id });
  }
  catch (err) {
    if (err instanceof Rules.RuleError) ui.notifications.warn(err.message);
    else {
      console.error(`${MODULE_ID} | ${type} failed`, err);
      ui.notifications.error(`${type} failed: ${err.message}`);
    }
  }
}

/** Listen for requests (as the active GM) and for replies to our own (as anyone). */
export function listen() {
  game.socket.on(SOCKET, async message => {
    if (message?.type === "notice") {
      if (message.userId === game.user.id) ui.notifications.warn(message.message);
      return;
    }
    if (!Core.isActiveGM()) return;
    const user = game.users.get(message?.userId);
    if (!user) return;
    try {
      await handle(user, message.type, message.payload);
    }
    catch (err) {
      if (!(err instanceof Rules.RuleError)) console.error(`${MODULE_ID} | ${message.type} from ${user.name} failed`, err);
      game.socket.emit(SOCKET, { type: "notice", userId: user.id, message: err.message });
    }
  });
}
