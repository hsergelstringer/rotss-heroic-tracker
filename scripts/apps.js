/**
 * Windows: the tracker everyone uses during combat, the GM's library editor,
 * and the add-marker dialog.
 */

import * as Rules from "./rules.js";
import * as Core from "./core.js";
import * as Markers from "./markers.js";
import { request } from "./requests.js";

const { MODULE_ID } = Core;
const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const esc = text => Handlebars.escapeExpression(String(text ?? ""));

/* -------------------------------------------- */
/*  Tracker                                     */
/* -------------------------------------------- */

export class HeroicTracker extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rotss-heroic-tracker",
    classes: ["rotss-heroic"],
    window: { title: "Heroic & Companion Actions", icon: "fa-solid fa-shield-heart", resizable: true },
    position: { width: 440, height: "auto" },
    actions: {
      spend: HeroicTracker.#onSpend,
      undo: HeroicTracker.#onUndo,
      refresh: HeroicTracker.#onRefresh,
      setActive: HeroicTracker.#onSetActive,
      setAvailable: HeroicTracker.#onSetAvailable,
      addMarker: HeroicTracker.#onAddMarker,
      removeMarker: HeroicTracker.#onRemoveMarker,
      edit: () => LibraryEditor.open(),
      longRest: HeroicTracker.#onLongRest
    }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/tracker.hbs` } };

  static open() {
    const app = foundry.applications.instances.get(HeroicTracker.DEFAULT_OPTIONS.id) ?? new HeroicTracker();
    app.render({ force: true });
    return app;
  }

  static refresh() {
    const app = foundry.applications.instances.get(HeroicTracker.DEFAULT_OPTIONS.id);
    if (app?.rendered) app.render();
  }

  get combat() {
    return game.combat ?? null;
  }

  async _prepareContext() {
    const user = game.user;
    const isGM = user.isGM;
    const combat = this.combat;
    const library = Core.getLibrary();
    const state = Core.getCombatState(combat);
    const usage = Core.getUsage();
    const mayCompanion = Core.mayUse(combat, user, "companion");
    const mayHeroic = Core.mayUse(combat, user, "heroic");
    const inCombat = new Set((combat?.combatants.contents ?? []).map(c => c.actorId).filter(Boolean));

    const usesLabel = (limit, key) => {
      const left = Rules.usesLeft(limit, key, state, usage);
      return left === null ? "" : `${left}/${limit.uses} ${Rules.LIMIT_PERIODS[limit.per]}`;
    };
    const verdict = (may, request) => {
      if (!combat) return { disabled: true, reason: "Start a combat to use actions." };
      if (!may.ok) return { disabled: true, reason: may.reason };
      const check = Rules.check(library, state, usage, request);
      return check.ok ? { disabled: false, reason: "" } : { disabled: true, reason: check.reason };
    };

    const companions = library.companions.filter(c => isGM || c.active).map(c => {
      const left = Rules.pointsLeft(c, state);
      let refreshLabel = c.refresh === "count" ? `Refreshes at initiative ${c.refreshCount}` : c.refresh === "round" ? "Refreshes each round" : "Refreshes on its turn";
      let warning = "";
      if (c.refresh === "turn" && !c.actorId) warning = "Not linked to an actor, so it only refreshes by hand.";
      else if (c.refresh === "turn" && combat && !inCombat.has(c.actorId)) warning = "Its actor isn't in this combat, so it only refreshes by hand.";
      return {
        ...c,
        img: c.img || game.actors.get(c.actorId)?.img || "",
        left,
        pips: Array.from({ length: c.points }, (_, i) => ({ on: i < left })),
        refreshLabel,
        warning,
        actions: c.actions.map(a => ({
          ...a,
          usesLabel: usesLabel(a.limit, Rules.companionKey(c.id, a.id)),
          ...verdict(mayCompanion, { kind: "companion", companionId: c.id, actionId: a.id })
        }))
      };
    });

    const heroics = library.heroics.filter(h => isGM || h.available).map(h => ({
      ...h,
      used: state.usedThisRound.includes(h.id),
      usesLabel: usesLabel(h.limit, Rules.heroicKey(h.id)),
      ...verdict(mayHeroic, { kind: "heroic", heroicId: h.id })
    }));

    const markers = Markers.markersIn(combat)
      .filter(c => isGM || !c.hidden)
      .sort((a, b) => (b.initiative ?? 0) - (a.initiative ?? 0))
      .map(c => {
        const marker = Markers.markerOf(c);
        return { id: c.id, text: marker.text, details: marker.details, hidden: c.hidden, timing: Markers.describeMarker(combat, marker), refresh: !!marker.refreshCompanionId };
      });

    const current = combat?.combatant;
    return {
      isGM,
      combat: combat ? {
        round: combat.round,
        started: combat.started,
        current: current && !Core.isMarker(current) ? current.name : null
      } : null,
      hint: !combat ? null : mayCompanion.ok ? null : mayCompanion.reason,
      companions,
      heroics,
      markers,
      canAddMarker: !!combat && (isGM || game.settings.get(MODULE_ID, "playersAddMarkers")),
      log: state.log.slice(-8).reverse().map(e => ({ ...e, label: e.kind === "companion" ? `${e.source}: ${e.name} (${e.cost})` : e.name })),
      empty: !companions.length && !heroics.length
    };
  }

  static #onSpend(event, target) {
    // data-action names the handler ("spend"), so the companion action's id is in data-action-id.
    const { kind, companion, actionId, heroic } = target.dataset;
    const req = kind === "companion" ? { kind, companionId: companion, actionId } : { kind, heroicId: heroic };
    request("spend", { combatId: this.combat?.id, request: req });
  }

  static #onUndo(event, target) {
    request("undo", { combatId: this.combat?.id, entryId: target.dataset.entry });
  }

  static #onRefresh(event, target) {
    request("refresh", { combatId: this.combat?.id, companionId: target.dataset.companion });
  }

  static #onSetActive(event, target) {
    request("setActive", { companionId: target.dataset.companion, active: target.checked });
  }

  static #onSetAvailable(event, target) {
    request("setAvailable", { heroicId: target.dataset.heroic, available: target.checked });
  }

  static async #onAddMarker() {
    if (!this.combat) return;
    const input = await markerDialog(this.combat);
    if (input) request("addMarker", { combatId: this.combat.id, input });
  }

  static #onRemoveMarker(event, target) {
    request("removeMarker", { combatId: this.combat?.id, combatantId: target.dataset.marker });
  }

  static async #onLongRest() {
    const ok = await DialogV2.confirm({
      window: { title: "Long rest" },
      content: "<p>Restore every action limited to uses per long rest?</p>"
    });
    if (ok) request("longRest");
  }
}

/* -------------------------------------------- */
/*  Marker dialog                               */
/* -------------------------------------------- */

/** Ask for a marker. Resolves with its input, or null if cancelled. */
export async function markerDialog(combat, defaults = {}) {
  const combatants = combat.turns.filter(c => !Core.isMarker(c) && (game.user.isGM || !c.hidden));
  const current = combat.combatant && !Core.isMarker(combat.combatant) ? combat.combatant.id : combatants[0]?.id;
  const anchor = defaults.anchorId ?? current;
  const options = combatants.map(c =>
    `<option value="${c.id}" ${c.id === anchor ? "selected" : ""}>${esc(c.name)}${c.initiative === null ? " (no initiative)" : ""}</option>`).join("");
  const timings = Object.entries(Rules.TIMINGS).map(([key, label]) =>
    `<option value="${key}" ${key === (defaults.timing ?? "endOfTurn") ? "selected" : ""}>${label}</option>`).join("");

  const content = `
    <div class="rotss-heroic-form">
      <div class="form-group"><label>Reminder</label><div class="form-fields">
        <input type="text" name="text" value="${esc(defaults.text)}" placeholder="e.g. Feeder stunned" maxlength="120" required autofocus></div></div>
      <div class="form-group"><label>Ends or goes off</label><div class="form-fields"><select name="timing">${timings}</select></div></div>
      <div class="form-group" data-show="anchor"><label>Combatant</label><div class="form-fields"><select name="anchorId">${options}</select></div></div>
      <div class="form-group" data-show="count"><label>Initiative count</label><div class="form-fields">
        <input type="number" name="count" value="${defaults.count ?? 20}" step="1"></div></div>
      <div class="form-group"><label>Repeat</label><div class="form-fields">
        <input type="checkbox" name="repeat" ${defaults.repeat ? "checked" : ""}>
        <input type="number" name="rounds" min="1" step="1" placeholder="rounds (blank: until removed)" value="${defaults.rounds ?? ""}"></div></div>
      <div class="form-group stacked"><label>Details</label>
        <textarea name="details" rows="2" maxlength="500" placeholder="Shown in the reminder">${esc(defaults.details)}</textarea></div>
      ${game.user.isGM ? `<div class="form-group"><label>Only the GM sees it</label><div class="form-fields">
        <input type="checkbox" name="hidden" ${defaults.hidden ? "checked" : ""}></div></div>` : ""}
      <p class="hint">"End of its next turn" goes off right after that combatant's next turn. A marker the tracker reaches before then is skipped.</p>
    </div>`;

  return DialogV2.prompt({
    window: { title: "Add effect marker", icon: "fa-solid fa-hourglass-half" },
    position: { width: 460 },
    content,
    render: (event, dialog) => {
      const form = (dialog.element ?? dialog).querySelector("form") ?? (dialog.element ?? dialog);
      const sync = () => {
        const timing = form.querySelector("[name=timing]").value;
        form.querySelector("[data-show=anchor]").hidden = !["endOfTurn", "startOfTurn"].includes(timing);
        form.querySelector("[data-show=count]").hidden = timing !== "count";
      };
      form.querySelector("[name=timing]")?.addEventListener("change", sync);
      sync();
    },
    ok: {
      label: "Add",
      callback: (event, button) => {
        const f = button.form.elements;
        if (!f.text.value.trim()) return null;
        return {
          text: f.text.value, timing: f.timing.value, anchorId: f.anchorId.value, count: f.count.value,
          repeat: f.repeat.checked, rounds: f.rounds.value, details: f.details.value, hidden: f.hidden?.checked ?? false
        };
      }
    },
    rejectClose: false
  });
}

/* -------------------------------------------- */
/*  Library editor                              */
/* -------------------------------------------- */

/** Set a value in a nested object by a dotted path like "companions.0.actions.1.cost". */
function setPath(target, path, value) {
  const keys = path.split(".");
  let node = target;
  while (keys.length > 1) {
    const key = keys.shift();
    node = node[key] ??= {};
  }
  node[keys[0]] = value;
}

export class LibraryEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "rotss-heroic-editor",
    classes: ["rotss-heroic", "rotss-heroic-editor"],
    tag: "form",
    window: { title: "Companions & Heroic Actions", icon: "fa-solid fa-pen-to-square", resizable: true },
    position: { width: 640, height: 720 },
    form: { handler: LibraryEditor.#onSave, submitOnChange: false, closeOnSubmit: true },
    actions: {
      addCompanion: LibraryEditor.#onAddCompanion,
      addAction: LibraryEditor.#onAddAction,
      addHeroic: LibraryEditor.#onAddHeroic,
      remove: LibraryEditor.#onRemove,
      move: LibraryEditor.#onMove,
      exportJson: LibraryEditor.#onExport,
      importJson: LibraryEditor.#onImport,
      resetUses: LibraryEditor.#onResetUses
    }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/editor.hbs`, scrollable: [".rotss-heroic-editor-body"] } };

  static open() {
    if (!game.user.isGM) return;
    const app = foundry.applications.instances.get(LibraryEditor.DEFAULT_OPTIONS.id) ?? new LibraryEditor();
    app.render({ force: true });
    return app;
  }

  /** The library being edited; saved only when the form is submitted. */
  draft = null;

  async _prepareContext() {
    this.draft ??= Core.getLibrary();
    const actors = game.actors.contents.filter(a => a.type === "npc" || a.type === "character").sort((a, b) => a.name.localeCompare(b.name));
    const periods = Object.entries(Rules.LIMIT_PERIODS).map(([value, label]) => ({ value, label }));
    return {
      companions: this.draft.companions.map((c, i) => ({
        ...c,
        index: i,
        refreshOptions: Object.entries(Rules.REFRESH).map(([value, label]) => ({ value, label, selected: value === c.refresh })),
        actorOptions: actors.map(a => ({ value: a.id, label: a.name, selected: a.id === c.actorId })),
        isCount: c.refresh === "count",
        actions: c.actions.map((a, j) => ({ ...a, index: j, periods: periods.map(p => ({ ...p, selected: p.value === a.limit?.per })) }))
      })),
      heroics: this.draft.heroics.map((h, i) => ({ ...h, index: i, periods: periods.map(p => ({ ...p, selected: p.value === h.limit?.per })) }))
    };
  }

  #listening = false;

  _onRender(context, options) {
    super._onRender(context, options);
    // The window's element outlives re-renders, so listen once. Keep the draft
    // up to date as fields change, so adding a row doesn't lose edits.
    if (this.#listening) return;
    this.#listening = true;
    this.element.addEventListener("change", event => {
      const field = event.target;
      if (!field.name) return;
      const value = field.type === "checkbox" ? field.checked : field.value;
      setPath(this.draft, field.name, value);
      if (field.name.endsWith(".refresh")) this.render();
    });
  }

  /** Read every field into the draft (in case the last edit hasn't fired "change"). */
  #readForm() {
    for (const field of this.element.querySelectorAll("[name]")) {
      setPath(this.draft, field.name, field.type === "checkbox" ? field.checked : field.value);
    }
  }

  #limitFix() {
    // A blank uses box means unlimited.
    const fix = item => {
      if (!item.limit || !Number(item.limit.uses)) item.limit = null;
    };
    for (const c of this.draft.companions) c.actions.forEach(fix);
    this.draft.heroics.forEach(fix);
  }

  static #onAddCompanion() {
    this.#readForm();
    this.draft.companions.push(Rules.normalizeCompanion({ name: "New companion", actions: [{ name: "Attack", cost: 1 }] }));
    this.render();
  }

  static #onAddAction(event, target) {
    this.#readForm();
    this.draft.companions[Number(target.dataset.companion)].actions.push({ id: Rules.newId(), name: "New action", cost: 1, description: "", limit: null });
    this.render();
  }

  static #onAddHeroic() {
    this.#readForm();
    this.draft.heroics.push(Rules.normalizeHeroic({ name: "New heroic action" }));
    this.render();
  }

  static #onRemove(event, target) {
    this.#readForm();
    const { list, index, companion } = target.dataset;
    if (list === "actions") this.draft.companions[Number(companion)].actions.splice(Number(index), 1);
    else this.draft[list].splice(Number(index), 1);
    this.render();
  }

  static #onMove(event, target) {
    this.#readForm();
    const { list, index, companion, direction } = target.dataset;
    const items = list === "actions" ? this.draft.companions[Number(companion)].actions : this.draft[list];
    const from = Number(index);
    const to = from + Number(direction);
    if (to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to], items[from]];
    this.render();
  }

  static async #onExport() {
    this.#readForm();
    this.#limitFix();
    const json = JSON.stringify(Rules.normalizeLibrary(this.draft), null, 2);
    await DialogV2.prompt({
      window: { title: "Export library" },
      content: `<p>Copy this to keep a backup or move it to another world.</p><textarea readonly rows="16" style="width:100%;font-family:monospace">${esc(json)}</textarea>`,
      ok: { label: "Done" },
      rejectClose: false
    });
  }

  static async #onImport() {
    const text = await DialogV2.prompt({
      window: { title: "Import library" },
      content: `<p>Paste an exported library. It replaces what's in the editor; nothing is saved until you click Save.</p><textarea name="json" rows="16" style="width:100%;font-family:monospace"></textarea>`,
      ok: { label: "Import", callback: (event, button) => button.form.elements.json.value },
      rejectClose: false
    });
    if (!text) return;
    try {
      this.draft = Rules.normalizeLibrary(JSON.parse(text));
      this.render();
    }
    catch (err) {
      ui.notifications.error(`That isn't a valid library: ${err.message}`);
    }
  }

  static async #onResetUses() {
    const ok = await DialogV2.confirm({
      window: { title: "Reset limited uses" },
      content: "<p>Restore every limited use, including those that last in total (like Hallharn Fleet's two uses)? Use this when starting Ragnarök again or after a mistake.</p>"
    });
    if (ok) request("resetUses");
  }

  static async #onSave() {
    this.#readForm();
    this.#limitFix();
    await request("saveLibrary", { library: this.draft });
    this.draft = null;
  }

  async close(options) {
    this.draft = null;
    return super.close(options);
  }
}
