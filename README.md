# Raiders of the Serpent Sea: Heroic & Companion Actions

A Foundry VTT (v13–v14) module for running *Raiders of the Serpent Sea*'s helper actions at the table:

- **Companion actions** (Companion Rules, Chapter 1; each companion in Appendix D). A companion gives up its turn for a pool of companion actions, usually 3. At the end of a hero's turn, that hero spends points on one of the companion's options, some of which cost 2 or 3. The pool refills at the start of the companion's turn, or for Mirgal at initiative count 15.
- **Heroic actions** (Chapter 12, Ragnarök). Each ally adds one. Each can be used once per round, after any creature's turn, and some have a limited number of uses (Hallharn Fleet, 2x).
- **Effect markers**: reminders in the initiative order, such as "the Feeder is stunned until the end of its next turn". When the tracker reaches one, it posts the reminder and moves on.

The module comes empty: you enter the companions and heroic actions you use, with your own wording.

## Using it

Open **Heroic & Companion Actions** from the shield button in the **Token controls**, or the same button in the combat tracker's header.

**During combat**
- **Companion actions** show each companion's remaining actions as pips. Click an action to use it.
  - A player can use one during their own turn or straight after it ends (the hero "whose turn just ended").
  - The GM can use any action at any time.
  - The setting **Who can use companion actions** can allow players at any time, or only the GM.
- **Heroic actions** can be used by any player, once per round each. One used this round is struck through until the next round.
- Each use posts a **chat card** with the action's description and what's left. The **Used this combat** list lets the GM undo a use, which also removes its card.
- Pools refill by themselves:
  - **At the start of its turn:** link the companion to its actor, and add that actor to the combat.
  - **At an initiative count:** the module adds a repeating marker at that count. When it's reached, the pool refills and the GM gets a whisper.
  - **Each round:** at the start of every round.

  The ↻ button refills a pool by hand.
- **With the party** (the checkbox next to a companion) hides companions that aren't present. **Available** (next to a heroic action) is for allies that haven't joined the battle yet.

**Effect markers**

Add a marker from the tracker window (**Effect markers → Add**). Choose when it goes off:

| Timing | Where it sits | Goes off |
| --- | --- | --- |
| End of a combatant's next turn | Just after that combatant | Right after that combatant's next turn. If that turn hasn't started yet when the tracker reaches the marker, it's skipped. |
| Start of a combatant's next turn | Just before that combatant | The next time it's reached |
| Start of the next round | At the top of the order | When the round turns |
| At an initiative count | At that count, after any combatant on the same number | Each time it's reached |

- **Repeat** keeps a marker going each round, for a number of rounds or until removed. This suits ongoing damage, or a spell that lasts a minute.
- Markers are real entries in the combat tracker, so everyone sees them, and hovering over one explains it.
- When the tracker reaches a marker, it posts the reminder (whispered to the GM if the marker is hidden) and moves on to the next combatant. A marker that's done removes itself.
- Markers follow their combatant if its initiative changes. If the combatant leaves the fight, the marker still goes off the next time it's reached.
- Players can add markers too, unless the GM turns that off. Only the GM can add hidden markers or remove markers.

**Between fights**
- 🛏 **Long rest** restores actions limited to uses per long rest.
- Uses limited "in total" (like Hallharn Fleet's two) last until you reset them in the editor.

## Setting up companions and heroic actions

Use ✎ in the tracker window (GM only) to open the editor.

- **Companion:** name, actor (for its portrait and turn-based refresh), actions per refresh, and how it refreshes. Then its actions, each with:
  - a cost
  - a description, shown on hover and in chat
  - optional limited uses per combat, per long rest or in total
- **Heroic action:** name, the ally it comes from, a description, optional limited uses, and whether it's available yet.
- **Export** and **Import** copy the whole library as text, for backups or moving to another world.
- **Reset uses** restores every limited use.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Who can use companion actions | Players, during or just after their own turn | Or players at any time, or only the GM. Heroic actions are open to any player unless only the GM can use actions. |
| Players can add effect markers | On | Lets players add reminders |
| Post used actions to chat | On | A chat card for each use |

## For macros

```js
const api = game.modules.get("rotss-heroic-tracker").api;
api.open();                     // the tracker window
api.edit();                     // the editor (GM)
api.markerDialog(combatantId);  // the add-marker dialog, anchored to a combatant
await api.addMarker({ text: "Feeder stunned", timing: "endOfTurn", anchorId: combatantId });
// timing: "endOfTurn", "startOfTurn", "startOfRound" or "count" (with count: 15); repeat: true, rounds: 10
```

## How it works

- **Changes go through the GM:** every change is carried out by the active GM's browser. Players' clicks are sent there over the module socket, checked against the rules and settings, and then applied. A GM must be logged in.
- **Where data is stored:**
  - Per-combat state (points spent, heroic actions used this round, the log) is kept on the Combat, so each fight starts fresh.
  - The library, and uses that outlast a fight (per long rest and in total), are world settings.
- **Markers in dnd5e:** markers are combatants without an actor. dnd5e's per-round recovery assumes every combatant has one, so the module tells dnd5e to skip markers.

## Development

The rules live in `scripts/rules.js` with no Foundry dependencies. `npm test` (Node 22+) runs:

- **Rules tests:** pools, costs, refreshes, round limits, limited uses, undo, turn order and marker timing.
- **Combat tests:** load the real module into a simulated Foundry and play through combats. They cover:
  - players spending on and after their turn
  - refreshes, including Mirgal's count marker
  - markers placing, skipping, arming, firing, repeating and following their anchor
  - hidden markers, settings, and dnd5e's recovery skip

To develop, symlink this folder into Foundry's `Data/modules/rotss-heroic-tracker`. To release, publish a GitHub release tagged `vX.Y.Z`; the workflow runs the tests and attaches `module.zip` and `module.json`.
