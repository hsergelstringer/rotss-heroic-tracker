/**
 * A small simulated Foundry, enough to run the module's combat handling in
 * Node: combats with turn order, combatants (including actor-less markers),
 * hooks fired after each change like Foundry's, world settings, users, chat
 * messages and the module socket.
 *
 * Like Foundry, hooks don't wait for their handlers, so tests call settle()
 * after an action to let the module's reactions finish.
 */

import { parseHTML } from "linkedom";

let nextId = 0;
const randomID = () => `id${(++nextId).toString().padStart(14, "0")}`;

class Collection extends Map {
  get contents() { return [...this.values()]; }
  find(fn) { return this.contents.find(fn); }
  filter(fn) { return this.contents.filter(fn); }
  some(fn) { return this.contents.some(fn); }
  map(fn) { return this.contents.map(fn); }
  [Symbol.iterator]() { return this.values(); }
}

const handlers = new Map();
export const Hooks = {
  on(name, fn) { (handlers.get(name) ?? handlers.set(name, []).get(name)).push(fn); },
  once(name, fn) { this.on(name, fn); },
  callAll(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); return true; },
  call(name, ...args) {
    for (const fn of handlers.get(name) ?? []) if (fn(...args) === false) return false;
    return true;
  }
};

const getProperty = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
function setProperty(obj, path, value) {
  const keys = path.split(".");
  let node = obj;
  while (keys.length > 1) node = node[keys.shift()] ??= {};
  node[keys[0]] = value;
}

/** Let hook handlers that were started but not awaited finish. */
export const settle = async (ms = 40) => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, ms / 4)); };

class Flagged {
  getFlag(scope, key) { return structuredClone(getProperty(this.flags?.[scope] ?? {}, key)); }
}

export class Combatant extends Flagged {
  constructor(data, combat) {
    super();
    Object.assign(this, { flags: {}, hidden: false, initiative: null, actorId: null, img: null }, structuredClone(data));
    this.id ??= randomID();
    this.parent = combat;
  }
  get combat() { return this.parent; }
  get actor() { return this.actorId ? game.actors.get(this.actorId) ?? null : null; }
  async update(changes) {
    for (const [k, v] of Object.entries(changes)) setProperty(this, k, v);
    this.parent.setupTurns();
    Hooks.callAll("updateCombatant", this, changes);
    return this;
  }
  async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: structuredClone(value) }); }
  async delete() { await this.parent.deleteEmbeddedDocuments("Combatant", [this.id]); }
}

export class Combat extends Flagged {
  constructor() {
    super();
    Object.assign(this, { id: randomID(), flags: {}, round: 0, turn: null, combatants: new Collection(), turns: [] });
  }
  get started() { return this.round > 0; }
  get combatant() { return this.turn === null ? null : this.turns[this.turn] ?? null; }

  /** Turn order by initiative, highest first; keeps the current combatant current. */
  setupTurns() {
    const currentId = this.combatant?.id;
    this.turns = this.combatants.contents.sort((a, b) => (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity));
    if (this.turn === null) return;
    const index = currentId ? this.turns.findIndex(c => c.id === currentId) : -1;
    if (index >= 0) this.turn = index;
    else this.turn = Math.min(this.turn, Math.max(0, this.turns.length - 1));
  }

  async createEmbeddedDocuments(type, list) {
    const created = list.map(data => new Combatant(data, this));
    for (const c of created) this.combatants.set(c.id, c);
    this.setupTurns();
    for (const c of created) Hooks.callAll("createCombatant", c);
    return created;
  }

  async deleteEmbeddedDocuments(type, ids) {
    const deleted = ids.map(id => this.combatants.get(id)).filter(Boolean);
    const currentId = this.combatant?.id;
    for (const c of deleted) this.combatants.delete(c.id);
    if (deleted.some(c => c.id === currentId)) {
      // Like Foundry: deleting the current combatant leaves the turn on the one after it.
      const order = this.turns.filter(c => !deleted.includes(c));
      const at = this.turns.findIndex(c => c.id === currentId);
      this.turns = order;
      this.turn = Math.min(at, Math.max(0, order.length - 1));
      this.setupTurns();
    }
    else this.setupTurns();
    for (const c of deleted) Hooks.callAll("deleteCombatant", c);
    return deleted;
  }

  async update(changes, options = {}) {
    for (const [k, v] of Object.entries(changes)) setProperty(this, k, v);
    Hooks.callAll("updateCombat", this, changes, options);
    return this;
  }

  async setFlag(scope, key, value) {
    setProperty(this.flags, `${scope}.${key}`, structuredClone(value));
    Hooks.callAll("updateCombat", this, { flags: {} }, {});
  }

  async startCombat() {
    this.setupTurns();
    Hooks.callAll("combatStart", this, { round: 1, turn: 0 });
    return this.update({ round: 1, turn: 0 }, { direction: 1 });
  }

  async nextTurn() {
    let turn = this.turn + 1;
    let round = this.round;
    if (turn >= this.turns.length) { turn = 0; round += 1; }
    return this.update({ round, turn }, { direction: 1 });
  }

  async previousTurn() {
    let turn = this.turn - 1;
    let round = this.round;
    if (turn < 0) { round -= 1; turn = this.turns.length - 1; }
    return this.update({ round, turn }, { direction: -1 });
  }
}

class User {
  constructor(id, name, isGM = false) { Object.assign(this, { id, name, isGM, active: true }); }
}

class Actor {
  constructor(id, name, owners = [], movement = null) {
    Object.assign(this, { id, name, img: `actors/${id}.webp`, owners: new Set(owners), system: { attributes: { movement } } });
  }
  testUserPermission(user) { return user.isGM || this.owners.has(user.id); }
}

/**
 * Install the globals the module expects. Returns the world: a GM, two
 * players and their heroes, companion actors, and a combat to fill.
 */
export function installFoundry() {
  const gm = new User("gm", "GM", true);
  const ursula = new User("ursula", "Ursula");
  const bjorn = new User("bjorn", "Bjorn");
  const users = new Collection([gm, ursula, bjorn].map(u => [u.id, u]));
  Object.defineProperty(users, "activeGM", { get: () => [...users.values()].find(u => u.isGM && u.active) ?? null });

  const actors = new Collection([
    new Actor("isen", "Isen", ["ursula"]),
    new Actor("astrid", "Astrid", ["bjorn"]),
    new Actor("hrolf", "Hrolf", [], { speeds: { walk: 30, swim: 30, fly: 0 }, units: "ft" }),
    new Actor("feeder", "The Feeder")
  ].map(a => [a.id, a]));

  const messages = new Collection();
  const settings = new Map();
  const settingConfig = new Map();
  const socketListeners = [];
  const sent = [];

  const ApplicationV2 = class { static DEFAULT_OPTIONS = {}; render() {} };
  // In Node, a linkedom DOM; in a browser (for visual checks), the real one is already there.
  if (!globalThis.document) {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="interface"></div></body></html>');
    Object.assign(window, { innerWidth: 1600, innerHeight: 900 });
    Object.assign(globalThis, { document, window });
  }
  Object.assign(globalThis, {
    CONFIG: { DND5E: { movementTypes: { walk: { label: "Speed" }, burrow: { label: "Burrow" }, climb: { label: "Climb" }, fly: { label: "Fly" }, swim: { label: "Swim" } } } },
    Hooks,
    Handlebars: { escapeExpression: s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") },
    ui: { notifications: { warn() {}, error() {}, info() {} }, controls: { render() {} } },
    foundry: {
      applications: { api: { ApplicationV2, HandlebarsApplicationMixin: Base => class extends Base {}, DialogV2: {} }, instances: new Map() },
      utils: { getProperty, setProperty, randomID, debounce: (fn, ms) => fn }
    },
    ChatMessage: { implementation: {
      async create(data) {
        const message = { id: randomID(), ...data,
          getFlag(scope, key) { return getProperty(this.flags?.[scope] ?? {}, key); },
          async delete() { messages.delete(this.id); } };
        messages.set(message.id, message);
        return message;
      }
    } }
  });

  const combats = new Collection();
  globalThis.game = {
    ready: false, user: gm, users, actors, messages, combats,
    i18n: { localize: key => key },
    get combat() { return combats.contents[0] ?? null; },
    modules: new Map([["rotss-heroic-tracker", {}]]),
    settings: {
      register(module, key, options) {
        settingConfig.set(key, options);
        if (!settings.has(key)) settings.set(key, structuredClone(options.default));
      },
      get: (module, key) => structuredClone(settings.get(key)),
      async set(module, key, value) {
        // The new value appears only once the "server" answers, as in Foundry.
        await new Promise(r => setTimeout(r, 2));
        settings.set(key, structuredClone(value));
        settingConfig.get(key)?.onChange?.(value);
        return value;
      }
    },
    socket: {
      on: (name, fn) => socketListeners.push(fn),
      emit: (name, message) => {
        sent.push(message);
        // Deliver to "another browser": the listener runs as the active GM, after this call returns.
        setTimeout(() => {
          const sender = game.user;
          game.user = users.activeGM ?? sender;
          try { for (const fn of socketListeners) fn(message); }
          finally { game.user = sender; }
        }, 0);
      }
    }
  };

  return {
    gm, ursula, bjorn, users, actors, messages, sent,
    /** Act as a user: changes game.user like switching browsers. */
    as(user) { game.user = user; },
    async newCombat(entries) {
      const combat = new Combat();
      combats.set(combat.id, combat);
      await combat.createEmbeddedDocuments("Combatant", entries.map(([actorId, initiative]) => ({ actorId, name: actors.get(actorId).name, initiative })));
      return combat;
    }
  };
}

export const startFoundry = () => {
  Hooks.callAll("init");
  game.ready = true;
  Hooks.callAll("ready");
};
