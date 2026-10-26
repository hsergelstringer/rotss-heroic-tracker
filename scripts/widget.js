/**
 * Panels on the canvas:
 *  - Companions: the companions with the party, with portrait, speed,
 *    actions left and, during combat, their action buttons.
 *  - Heroic actions: the available heroic actions, with uses left, whether
 *    each was used this round, and a button to use it.
 *
 * Each person can show or hide each panel, collapse it, and drag it by its
 * header; all of that is remembered per browser (client settings). The GM
 * gets refresh buttons: a companion's pool, or this round's heroic actions.
 */

import * as Core from "./core.js";
import * as View from "./view.js";
import { request } from "./requests.js";

const { MODULE_ID } = Core;
const esc = text => Handlebars.escapeExpression(String(text ?? ""));

/* -------------------------------------------- */
/*  Panel contents                              */
/* -------------------------------------------- */

function companionHtml(card, { collapsed, combat, isGM }) {
  const pips = card.pips.map(p => `<span class="rhw-pip ${p.on ? "on" : ""}"></span>`).join("");
  const actions = !collapsed && combat?.started && card.actions.length ? `
    <div class="rhw-actions">
      ${card.actions.map(a => `
        <button type="button" data-rhw="spend" data-companion="${esc(card.id)}" data-action-id="${esc(a.id)}"
          ${a.disabled ? "disabled" : ""} data-tooltip="${esc(a.reason || a.description || a.name)}">
          ${esc(a.name)}<span class="rhw-cost">${a.cost}</span>
        </button>`).join("")}
    </div>` : "";
  const refresh = isGM && combat
    ? `<button type="button" class="rhw-refresh" data-rhw="refresh" data-companion="${esc(card.id)}" data-tooltip="Refresh ${esc(card.name)}'s actions" ${card.left === card.points ? "disabled" : ""}><i class="fa-solid fa-rotate"></i></button>`
    : "";
  return `
    <div class="rhw-card" data-companion="${esc(card.id)}">
      <div class="rhw-row">
        ${card.img ? `<img src="${esc(card.img)}" alt="">` : `<span class="rhw-initial">${esc(card.name.slice(0, 1))}</span>`}
        <div class="rhw-main">
          <strong>${esc(card.name)}</strong>
          ${card.speed && !collapsed ? `<span class="rhw-speed" data-tooltip="${esc(card.speed.text)}"><i class="fa-solid fa-person-running"></i> ${esc(card.speed.text)}</span>` : ""}
        </div>
        <span class="rhw-pips" data-tooltip="${card.left} of ${card.points} actions left · ${esc(card.refreshLabel)}">${pips}</span>
        ${refresh}
      </div>
      ${actions}
    </div>`;
}

function heroicHtml(card, { collapsed }) {
  const status = card.used ? `<span class="rhw-used"><i class="fa-solid fa-check"></i> this round</span>` : "";
  return `
    <div class="rhw-card rhw-heroic ${card.used ? "used" : ""}" data-heroic="${esc(card.id)}">
      <div class="rhw-row">
        <div class="rhw-main">
          <strong>${esc(card.name)}</strong>
          ${!collapsed && (card.ally || card.usesLabel) ? `<span class="rhw-speed">${esc([card.ally, card.usesLabel].filter(Boolean).join(" · "))}</span>` : ""}
        </div>
        ${status}
        <button type="button" class="rhw-use" data-rhw="heroic" data-heroic="${esc(card.id)}" ${card.disabled ? "disabled" : ""}
          data-tooltip="${esc(card.reason || card.description || card.name)}">Use</button>
      </div>
    </div>`;
}

/* -------------------------------------------- */
/*  The two panels                              */
/* -------------------------------------------- */

const PANELS = {
  companions: {
    id: "rotss-heroic-widget",
    title: "Companions",
    settings: { show: "widgetShow", collapsed: "widgetCollapsed", position: "widgetPosition" },
    defaultPosition: { left: 120, top: 90 },
    showName: "Show the companions panel on the canvas",
    showHint: "A small panel with the companions who are with the party: their speed, actions left and, during combat, their actions. Drag it by its header. Each person chooses for themselves.",
    cards: () => View.companionCards(game.combat, game.user),
    cardHtml: companionHtml,
    headerTools: () => ""
  },
  heroics: {
    id: "rotss-heroic-heroics-widget",
    title: "Heroic actions",
    settings: { show: "heroicWidgetShow", collapsed: "heroicWidgetCollapsed", position: "heroicWidgetPosition" },
    defaultPosition: { left: 120, top: 420 },
    showName: "Show the heroic actions panel on the canvas",
    showHint: "A small panel with the heroic actions available to the party: uses left, whether each was used this round, and a button to use it. Drag it by its header. Each person chooses for themselves.",
    cards: () => View.heroicCards(game.combat, game.user),
    cardHtml: heroicHtml,
    headerTools: () => (game.user.isGM && game.combat
      ? `<button type="button" data-rhw="resetRound" data-tooltip="Let every heroic action be used again this round"><i class="fa-solid fa-rotate"></i></button>`
      : "")
  }
};

const setting = (panel, key) => game.settings.get(MODULE_ID, PANELS[panel].settings[key]);

export function registerWidgetSettings() {
  for (const [kind, panel] of Object.entries(PANELS)) {
    game.settings.register(MODULE_ID, panel.settings.show, {
      name: panel.showName, hint: panel.showHint,
      scope: "client", config: true, type: Boolean, default: true,
      onChange: () => {
        render(kind);
        ui.controls?.render?.(); // keep the Token controls toggle in step with the × button
      }
    });
    game.settings.register(MODULE_ID, panel.settings.collapsed, { scope: "client", config: false, type: Boolean, default: false, onChange: () => render(kind) });
    game.settings.register(MODULE_ID, panel.settings.position, { scope: "client", config: false, type: Object, default: panel.defaultPosition });
  }
}

export const isShown = (kind = "companions") => setting(kind, "show");
export const setShown = (shown, kind = "companions") => game.settings.set(MODULE_ID, PANELS[kind].settings.show, !!shown);

/* -------------------------------------------- */
/*  Drawing                                     */
/* -------------------------------------------- */

/** Keep a panel on screen, e.g. after the window shrinks. */
function clamp({ left, top }, element) {
  const width = element?.offsetWidth || 220;
  const height = element?.offsetHeight || 60;
  return {
    left: Math.max(0, Math.min(Number(left) || 0, window.innerWidth - Math.min(width, window.innerWidth))),
    top: Math.max(0, Math.min(Number(top) || 0, window.innerHeight - Math.min(height, 40)))
  };
}

function place(kind, element) {
  const { left, top } = clamp(setting(kind, "position") ?? PANELS[kind].defaultPosition, element);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

/** Draw or update one panel, or both. Cheap enough to call after any change. */
export function render(kind = null) {
  if (!game.ready) return;
  if (!kind) {
    for (const k of Object.keys(PANELS)) render(k);
    return;
  }
  const panel = PANELS[kind];
  let element = document.getElementById(panel.id);
  const cards = isShown(kind) ? panel.cards() : [];
  if (!cards.length) {
    element?.remove();
    return;
  }
  const collapsed = setting(kind, "collapsed");
  if (!element) {
    element = document.createElement("aside");
    element.id = panel.id;
    element.dataset.panel = kind;
    element.addEventListener("click", onClick);
    element.addEventListener("pointerdown", onPointerDown);
    (document.getElementById("interface") ?? document.body).append(element);
  }
  element.className = `rotss-heroic-widget rhw-${kind} ${collapsed ? "collapsed" : ""}`;
  const context = { collapsed, combat: game.combat, isGM: game.user.isGM };
  element.innerHTML = `
    <header class="rhw-head" data-tooltip="Drag to move">
      <i class="fa-solid fa-grip-vertical rhw-grip"></i>
      <span class="rhw-title">${panel.title}${kind === "heroics" && game.combat?.started ? ` <span class="rhw-round">round ${game.combat.round}</span>` : ""}</span>
      ${panel.headerTools()}
      <button type="button" data-rhw="collapse" data-tooltip="${collapsed ? "Show details" : "Show less"}"><i class="fa-solid fa-chevron-${collapsed ? "down" : "up"}"></i></button>
      <button type="button" data-rhw="open" data-tooltip="Open the tracker"><i class="fa-solid fa-shield-heart"></i></button>
      <button type="button" data-rhw="hide" data-tooltip="Hide (turn back on in Token controls)"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="rhw-body">${cards.map(card => panel.cardHtml(card, context)).join("")}</div>`;
  // A portrait that fails to load falls back to the companion's initial.
  for (const image of element.querySelectorAll(".rhw-row img")) {
    image.addEventListener("error", () => {
      const initial = document.createElement("span");
      initial.className = "rhw-initial";
      initial.textContent = image.closest(".rhw-card")?.querySelector("strong")?.textContent.slice(0, 1) ?? "?";
      image.replaceWith(initial);
    }, { once: true });
  }
  place(kind, element);
}

/* -------------------------------------------- */
/*  Interaction                                 */
/* -------------------------------------------- */

function onClick(event) {
  const button = event.target.closest("button[data-rhw]");
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  const kind = event.currentTarget.dataset.panel;
  const combatId = game.combat?.id;
  switch (button.dataset.rhw) {
    case "spend":
      request("spend", { combatId, request: { kind: "companion", companionId: button.dataset.companion, actionId: button.dataset.actionId } });
      break;
    case "heroic":
      request("spend", { combatId, request: { kind: "heroic", heroicId: button.dataset.heroic } });
      break;
    case "refresh":
      request("refresh", { combatId, companionId: button.dataset.companion });
      break;
    case "resetRound":
      request("resetRound", { combatId });
      break;
    case "collapse":
      game.settings.set(MODULE_ID, PANELS[kind].settings.collapsed, !setting(kind, "collapsed"));
      break;
    case "open":
      game.modules.get(MODULE_ID).api.open();
      break;
    case "hide":
      setShown(false, kind);
      ui.notifications.info(`${PANELS[kind].title} panel hidden. Turn it back on from the Token controls.`);
      break;
  }
}

/** Drag by the header; the new position is saved when the drag ends. */
function onPointerDown(event) {
  const header = event.target.closest(".rhw-head");
  if (!header || event.target.closest("button") || event.button !== 0) return;
  const element = event.currentTarget;
  const kind = element.dataset.panel;
  event.preventDefault();
  const start = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop };
  element.classList.add("dragging");
  header.setPointerCapture?.(event.pointerId);

  const move = e => {
    const { left, top } = clamp({ left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y }, element);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  };
  const end = () => {
    header.removeEventListener("pointermove", move);
    header.removeEventListener("pointerup", end);
    header.removeEventListener("pointercancel", end);
    element.classList.remove("dragging");
    game.settings.set(MODULE_ID, PANELS[kind].settings.position, { left: element.offsetLeft, top: element.offsetTop });
  };
  header.addEventListener("pointermove", move);
  header.addEventListener("pointerup", end);
  header.addEventListener("pointercancel", end);
}

/** Keep panels on screen when the browser window is resized. */
export function watchResize() {
  window.addEventListener("resize", foundry.utils.debounce?.(() => {
    for (const [kind, panel] of Object.entries(PANELS)) {
      const element = document.getElementById(panel.id);
      if (element) place(kind, element);
    }
  }, 100) ?? (() => {}));
}
