# Interaction matrix

| Control | Start state | Action | Result | Keyboard | Evidence |
| --- | --- | --- | --- | --- | --- |
| Desktop navigation group | Closed | Click Product, Capabilities, or Resources | Bordered dark submenu appears below the trigger | Enter/Space opens; Escape closes | Source DOM/style inspection; local implementation QA |
| Mobile menu | Closed | Tap menu icon | Full-height black navigation sheet with stacked links and bottom actions | Enter/Space opens; Escape closes and restores focus | `../states/mobile-menu.png` |
| Hero primary action | Top of page | Click Explore the workstation | Scrolls to agent-primitives product surface | Native link behavior | `../source/desktop-top.png` |
| Product preview tabs | Browser selected | Select Checkpoints or Review loop | Preview content and accent color change in place | Native tab buttons | Local implementation QA |
| Command strip | Idle | Click `$ npm run dev` | Copies command when clipboard is available; status changes to Copied briefly | Native button behavior | Local implementation QA |
| Footer/CTA links | Any section | Click | Scrolls to referenced in-page section | Native link behavior | Local implementation QA |

