# Changelog

## 0.0.3

**Fixed**
- Companions that refresh at an initiative count (like Mirgal at 15) didn't reliably refill. The refill depended on the tracker stopping on the "regains actions" marker. It now happens on any turn change: once a round, as soon as the turn reaches someone below the count, even if the marker was deleted or the GM jumped past it. If a whole round passes with nobody below the count, the companion refills as the next round starts. The marker is now only a reminder, and the GM still gets a whisper when the refill happens.

**Added**
- A **heroic actions panel** on the canvas: the available heroic actions, with their ally, uses left, whether each was used this round, and a Use button. It's shown, hidden, collapsed and moved separately from the companions panel, with its own Token controls toggle.
- The GM can refresh a companion's actions from its card on the companions panel, and reset this round's heroic actions from the heroic actions panel.

## 0.0.2

- A companions panel on the canvas: the companions with the party, with their portrait, speed, actions left and, during combat, their action buttons. Drag it by its header; collapse it to portraits and pips; show or hide it from the Token controls, the module settings or its × button. Position, collapsed and shown are remembered per browser.
- Companions linked to an actor show its movement (walk, fly, swim, climb, burrow, hover and special movement) in the panel and the tracker window, as dnd5e calculates it, so conditions and encumbrance are included.

## 0.0.1

First version.

- Companion actions: pools of points per companion, actions with costs and optional limited uses, refreshing at the companion's turn, at an initiative count (with an automatic marker) or each round. Players use them during or just after their own turn; the GM at any time.
- Heroic actions: once per round each, optional limited uses, availability per ally.
- Effect markers in the combat tracker: end or start of a combatant's next turn, start of the next round, or an initiative count; optional repeats. They post reminders, skip themselves, follow their combatant and remove themselves when done.
- Chat cards for each use, with undo for the GM.
- A library editor with import and export.
- Rules and combat tests, run on every push and before every release.
