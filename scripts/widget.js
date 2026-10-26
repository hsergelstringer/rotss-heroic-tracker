/**
 * A small panel on the canvas with the companions who are with the party:
 * portrait, speed, actions left, and (during combat) their action buttons.
 *
 * Each person can show or hide it, collapse it to portraits and pips, and
 * drag it by its header; all three are remembered per browser (client
 * settings).
 */

import * as Core from "./core.js";
import * as View from "./view.js";
import { request } from "./requests.js";

const { MODULE_ID } = Core;
const ID = "rotss-heroic-widget";
const DEFAULT_POSITION = { left: 120, top: 90 };
const esc = text => Handlebars.escapeExpression(String(text ?? ""));

export function registerWidgetSettings() {
  game.settings.register(MODULE_ID, "widgetShow", {
    name: "Show the companions panel on the canvas",
    hint: "A small panel with the companions who are with the party: their speed, actions left and, during combat, their actions. Drag it by its header. Each person chooses for themselves.",
    scope: "client", config: true, type: Boolean, default: true,
    onChange: () => {
      render();
      ui.controls?.render?.(); // keep the Token controls toggle in step with the × button
    }
  });
  game.settings.register(MODULE_ID, "widgetCollapsed", { scope: "client", config: false, type: Boolean, default: false, onChange: () => render() });
  game.settings.register(MODULE_ID, "widgetPosition", { scope: "client", config: false, type: Object, default: DEFAULT_POSITION });
}

export const isShown = () => game.settings.get(MODULE_ID, "widgetShow");
export const setShown = shown => game.settings.set(MODULE_ID, "widgetShow", !!shown);

/** Keep the panel on screen, e.g. after the window shrinks. */
function clamp({ left, top }, element) {
  const width = element?.offsetWidth || 220;
  const height = element?.offsetHeight || 60;
  return {
    left: Math.max(0, Math.min(Number(left) || 0, window.innerWidth - Math.min(width, window.innerWidth))),
    top: Math.max(0, Math.min(Number(top) || 0, window.innerHeight - Math.min(height, 40)))
  };
}

function place(element) {
  const { left, top } = clamp(game.settings.get(MODULE_ID, "widgetPosition") ?? DEFAULT_POSITION, element);
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function cardHtml(card, { collapsed, combat }) {
  const pips = card.pips.map(p => `<span class="rhw-pip ${p.on ? "on" : ""}"></span>`).join("");
  const actions = !collapsed && combat?.started && card.actions.length ? `
    <div class="rhw-actions">
      ${card.actions.map(a => `
        <button type="button" data-rhw="spend" data-companion="${esc(card.id)}" data-action-id="${esc(a.id)}"
          ${a.disabled ? "disabled" : ""} data-tooltip="${esc(a.reason || a.description || a.name)}">
          ${esc(a.name)}<span class="rhw-cost">${a.cost}</span>
        </button>`).join("")}
    </div>` : "";
  return `
    <div class="rhw-card" data-companion="${esc(card.id)}">
      <div class="rhw-row">
        ${card.img ? `<img src="${esc(card.img)}" alt="">` : `<span class="rhw-initial">${esc(card.name.slice(0, 1))}</span>`}
        <div class="rhw-main">
          <strong>${esc(card.name)}</strong>
          ${card.speed && !collapsed ? `<span class="rhw-speed" data-tooltip="${esc(card.speed.text)}"><i class="fa-solid fa-person-running"></i> ${esc(card.speed.text)}</span>` : ""}
        </div>
        <span class="rhw-pips" data-tooltip="${card.left} of ${card.points} actions left · ${esc(card.refreshLabel)}">${pips}</span>
      </div>
      ${actions}
    </div>`;
}

/** Draw or update the panel. Cheap enough to call after any change. */
export function render() {
  if (!game.ready) return;
  let element = document.getElementById(ID);
  const cards = isShown() ? View.companionCards(game.combat, game.user) : [];
  if (!cards.length) {
    element?.remove();
    return;
  }
  const collapsed = game.settings.get(MODULE_ID, "widgetCollapsed");
  if (!element) {
    element = document.createElement("aside");
    element.id = ID;
    element.addEventListener("click", onClick);
    element.addEventListener("pointerdown", onPointerDown);
    (document.getElementById("interface") ?? document.body).append(element);
  }
  element.className = `rotss-heroic-widget ${collapsed ? "collapsed" : ""}`;
  element.innerHTML = `
    <header class="rhw-head" data-tooltip="Drag to move">
      <i class="fa-solid fa-grip-vertical rhw-grip"></i>
      <span class="rhw-title">Companions</span>
      <button type="button" data-rhw="collapse" data-tooltip="${collapsed ? "Show details" : "Show less"}"><i class="fa-solid fa-chevron-${collapsed ? "down" : "up"}"></i></button>
      <button type="button" data-rhw="open" data-tooltip="Open the tracker"><i class="fa-solid fa-shield-heart"></i></button>
      <button type="button" data-rhw="hide" data-tooltip="Hide (turn back on in Token controls)"><i class="fa-solid fa-xmark"></i></button>
    </header>
    <div class="rhw-body">${cards.map(card => cardHtml(card, { collapsed, combat: game.combat })).join("")}</div>`;
  // A portrait that fails to load falls back to the companion's initial.
  for (const image of element.querySelectorAll(".rhw-row img")) {
    image.addEventListener("error", () => {
      const initial = document.createElement("span");
      initial.className = "rhw-initial";
      initial.textContent = image.closest(".rhw-card")?.querySelector("strong")?.textContent.slice(0, 1) ?? "?";
      image.replaceWith(initial);
    }, { once: true });
  }
  place(element);
}

function onClick(event) {
  const button = event.target.closest("button[data-rhw]");
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  switch (button.dataset.rhw) {
    case "spend":
      request("spend", {
        combatId: game.combat?.id,
        request: { kind: "companion", companionId: button.dataset.companion, actionId: button.dataset.actionId }
      });
      break;
    case "collapse":
      game.settings.set(MODULE_ID, "widgetCollapsed", !game.settings.get(MODULE_ID, "widgetCollapsed"));
      break;
    case "open":
      game.modules.get(MODULE_ID).api.open();
      break;
    case "hide":
      setShown(false);
      ui.notifications.info("Companions panel hidden. Turn it back on from the Token controls.");
      break;
  }
}

/** Drag by the header; the new position is saved when the drag ends. */
function onPointerDown(event) {
  const header = event.target.closest(".rhw-head");
  if (!header || event.target.closest("button") || event.button !== 0) return;
  const element = event.currentTarget;
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
    game.settings.set(MODULE_ID, "widgetPosition", { left: element.offsetLeft, top: element.offsetTop });
  };
  header.addEventListener("pointermove", move);
  header.addEventListener("pointerup", end);
  header.addEventListener("pointercancel", end);
}

/** Keep it on screen when the browser window is resized. */
export function watchResize() {
  window.addEventListener("resize", foundry.utils.debounce?.(() => {
    const element = document.getElementById(ID);
    if (element) place(element);
  }, 100) ?? (() => {}));
}
