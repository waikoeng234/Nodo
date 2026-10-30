---
name: Nodo
description: A quiet workbench where a team of native coding Agents gets assigned, followed and reviewed.
colors:
  signal-blue: "#4176e6"
  signal-blue-wash: "#edf3fe"
  signal-blue-tint: "#e4edfd"
  ink: "#0f1115"
  slate: "#61666b"
  pebble: "#81858c"
  paper: "#ffffff"
  mist: "#f9fafb"
  haze: "#e9ecf2"
  hairline: "#0000001a"
  hairline-strong: "#0000001f"
  hover-veil: "#2631480f"
  done-green: "#22c55e"
  caution-amber: "#f59e0b"
  caution-amber-wash: "#fef5e7"
  fault-red: "#ec1313"
  crew-sky: "#7cc8f5"
  crew-peach: "#f7a27a"
  crew-olive: "#b8bf4c"
  crew-mint: "#7fd39b"
  crew-lavender: "#b9a3f5"
  crew-butter: "#f5c84c"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 500
    lineHeight: "32px"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: "26px"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "24px"
  item:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: "20px"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
rounded:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  node: "24px"
  panel: "28px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.slate}"
    rounded: "{rounded.sm}"
    size: "28px"
  icon-button-hover:
    backgroundColor: "{colors.hover-veil}"
    textColor: "{colors.ink}"
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  list-row-active:
    backgroundColor: "{colors.hover-veil}"
  composer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "8px 8px 6px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  bubble-user:
    backgroundColor: "{colors.signal-blue-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "10px 16px"
  tag:
    backgroundColor: "{colors.hover-veil}"
    textColor: "{colors.slate}"
    typography: "{typography.label}"
    rounded: "6px"
    height: "20px"
    padding: "0 7px"
  tag-accent:
    backgroundColor: "color-mix(in srgb, #4176e6 10%, transparent)"
    textColor: "{colors.signal-blue}"
  tag-caution:
    backgroundColor: "color-mix(in srgb, #f59e0b 10%, transparent)"
    textColor: "{colors.caution-amber}"
  chip:
    backgroundColor: "{colors.hover-veil}"
    textColor: "{colors.slate}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "24px"
    padding: "0 8px 0 6px"
  workflow-node:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.node}"
    padding: "16px"
    width: "204px"
---

# Design System: Nodo

## Overview

**Creative North Star: "The Quiet Studio, Lively Crew"**

Nodo is a workbench people keep open all day while several Agents work in parallel. The room itself is quiet: cool bluish-neutral paper, hairline edges, one blue that only ever means "selected", "running" or "go". All personality is handed to the crew. Every role is a soft, colourful blob with two upright eyes, and those faces are the only saturated colour on a normal screen. They hop while their Agent is running, blink, and wave when hovered. The interface frames the team rather than performing for it.

Density follows a chat-and-sidebar tool, not a dashboard: a 312px rail with roles and project trees, a reading column capped at the host chat width (748px), and an optional right panel for files, terminal and preview. Text is mostly 12–14px with generous 24px body leading so long transcripts stay readable. Depth is flat, with layers separated by tone and 0.5px hairlines. Shadows are reserved for the few things that genuinely float: the composer, approval and question cards, menus.

Today every value resolves through the dsh host's `--dsw-*` tokens and primitives, so Nodo follows the host's light and dark themes automatically. The hex values in this file are the light-theme resolution; dark values live in `.impeccable/design.json`. The look must stay recognisable if Nodo leaves dsh, so the rules below describe the system, not the host.

Confirmed rejections: large blocks of colour or decorative gradients, and the "terminal hacker" look (black screens, green text, monospace everywhere).

**Key Characteristics:**
- Neutral, cool, low-contrast chrome; colour belongs to role avatars and status.
- One accent (Signal Blue) used for state and focus, never for decoration.
- Flat surfaces, 0.5px hairlines, tonal layering between sidebar fill and base.
- Rounded, concentric corners from 4px up to the 28px composer.
- System sans with CJK fallbacks; small sizes, generous leading.
- Motion is small and functional: about 0.1–0.16s state fades, plus the avatars' running hop. All of it is disabled under reduced motion.

## Colors

A cool bluish-grey neutral world with one blue signal, four status hues, and six pastel crew colours that live only inside avatars.

### Primary
- **Signal Blue** (#4176e6; #7aaaff in dark): selection rings, ongoing step marks, links, the composer caret, focus outlines, workflow "continue" edges and flags. It means "this one" or "running now".
- **Signal Blue Wash** (#edf3fe): the user's own message bubble. It is the only place Signal Blue tints a large surface.
- **Signal Blue Tint** (#e4edfd): active state of picker options and selected sidebar items.

### Neutral
- **Ink** (#0f1115): primary text and icons on hover.
- **Slate** (#61666b): secondary text, idle icon buttons, tag and chip text.
- **Pebble** (#81858c): tertiary text, placeholders, captions, idle step marks.
- **Paper** (#ffffff): the base reading surface, cards, composer and workflow nodes.
- **Mist** (#f9fafb): sidebar fill and code/IO block background; the left half of the tonal split.
- **Haze** (#e9ecf2): overlays and pressed ghost fills.
- **Hairline** (#0000001a) and **Hairline Strong** (#0000001f): dividers, card edges and panel borders, always 0.5px.
- **Hover Veil** (#2631480f): the single hover and active fill for rows, icon buttons, tags and chips.

### Status
- **Done Green** (#22c55e): finished steps and success marks.
- **Caution Amber** (#f59e0b) with **Caution Amber Wash** (#fef5e7): approval cards, "hard" difficulty tags, warning steps, workflow rework edges.
- **Fault Red** (#ec1313; #f25a5a in dark): errors and destructive actions.

### Crew (avatar only)
- **Sky** (#7cc8f5), **Peach** (#f7a27a), **Olive** (#b8bf4c), **Mint** (#7fd39b), **Lavender** (#b9a3f5), **Butter** (#f5c84c): avatar bodies, assigned per role from `core/shared/avatar-templates.json`. The avatar tile is the body colour mixed 20% into the base surface. Eyes are always #172021.

### Named Rules
**The Crew Carries the Colour Rule.** Saturated colour belongs to avatars and status marks. Chrome, panels and backgrounds stay neutral. If a screen has a colourful surface that is not an avatar, a status or the user's bubble, it is wrong.

**The One Signal Rule.** Signal Blue means selection, focus or activity. It is never used as decoration or to brand a section.

**The Tinted-Not-Filled Rule.** Status colour on surfaces is mixed at 8–14% into transparent (`color-mix`) or uses the host's tertiary wash. Solid status fills are limited to small dots and marks.

**The Readable Amber Rule.** Caution Amber is a fill, stroke and icon colour, never a text colour: at about 2:1 on its own wash it fails contrast. Amber text uses `WARN_INK` from `ui-shared.js`, which mixes Caution Amber 55% into the primary label colour (about 5.2:1 on the light wash, and lighter in dark theme).

## Typography

**Body Font:** System sans (-apple-system / Segoe UI) with PingFang SC, Hiragino Sans GB and Microsoft YaHei for CJK.
**Mono Font:** The host's mono and code-block fonts, used only for code, diffs, the terminal and tool output.

**Character:** Invisible on purpose. The system face keeps Latin and CJK at equal weight, and hierarchy comes from size and 500/600 weights, not a display face.

### Hierarchy
- **Headline** (500, 26px, 32px): empty-state and welcome headlines only.
- **Title** (600, 18px, 26px): page, dialog and empty-section titles.
- **Prompt** (500, 15px, 24px): the question in approval and question cards; workflow node and inspector names use it at 600.
- **Body** (400, 14px, 24px): transcripts and composer text. It follows the host content-size setting (`--dsh-content-font-size`).
- **Item** (500, 13px, 20px): list row names, step names, section headings (600 for headings).
- **Label** (400, 12px, 18px): meta lines, tags, chips, counters, timestamps. Numbers use `tabular-nums`. Nothing goes below 12px except the numeral inside a step mark.

Weights stay at 400/500/600; headlines balance their wrap, prompts wrap `pretty`.

### Named Rules
**The Small-and-Airy Rule.** Keep the scale small (12–18px for nearly everything) and let leading carry readability. Do not add large display type to working screens.

## Layout

- **Frame:** a left rail (56px dock plus a 312px body, 12px inline inset), a centre column, and an optional right panel. On macOS inside dsh the centre and right panel sit as cards inset 8px from the window chrome (`--nodo-frame-gap`), with a 16px card radius.
- **Reading column:** content and composer are capped at the host chat width (748px); the composer adds 16px either side. User bubbles take at most about 70% of that width.
- **Rhythm:** 4/6/8/12/16/20/24px steps; 8px between controls, 12px inside rows and composer tool rows, 16px card padding, 20–24px around cards and dialog heads. The one exception is the 10px top padding of title bars (`.nodo-head`, `.nodo-right-head`, the space and drawer chrome), which keeps titles level with the host's title bar.
- **Responsive:** the right panel and wide tables collapse through breakpoints at 1100, 820, 800, 720, 640, 520 and 420px. The composer's model picker compacts to an icon when space is short.
- **Workflow canvas:** a free canvas on a 1px dotted grid (hairline dots), with fixed 204px-wide nodes.

## Elevation & Depth

Flat by default. Depth comes from the tonal split between Mist (sidebar, code blocks) and Paper (reading surface), plus 0.5px hairline edges. Shadows are near-invisible ambient light (2–4% black), used only on surfaces that float over content.

### Shadow Vocabulary
- **Panel** (`0 0 0 .5px hairline, 0 3px 8px rgba(0,0,0,.03), 0 0 16px rgba(0,0,0,.02)`): the composer and question cards.
- **Soft** (`0 0 0 .5px hairline, 0 4px 16px rgba(0,0,0,.03), 0 0 24px rgba(0,0,0,.03)`): menus and popovers.
- **Lift** (`0 4px 12px rgba(0,0,0,.02), 0 2px 8px rgba(0,0,0,.04)`): approval cards.
- **Pressed tab** (`0 1px 2px hairline, 0 0 0 .5px hairline`): the pressed dock button in the rail.

### Named Rules
**The Only-What-Floats Rule.** A surface gets a shadow only if it sits above the content it relates to (composer, approval, menu, popover). Lists, rows and inline cards stay flat with a hairline.

## Shapes

Soft rounded rectangles throughout, on a 4/8/12/16/20/24/28px scale. Small controls use 8px, rows and avatars about 12px, cards 16px, bubbles and floating cards 20px, workflow nodes 24px, and the composer a 28px panel radius. Avatars are 28%-rounded tiles holding an irregular blob. Hairlines are 0.5px; dashed borders mean "add" or "rework".

### Named Rules
**The Concentric Corner Rule.** A nested surface's radius equals its parent's radius minus the inset between them (and minus the 0.5px edge), as the right panel already does with `calc(var(--nodo-card-radius) - 12px - .5px)`. Never put a larger or equal radius inside a tighter one.

## Components

### Buttons
- **Text buttons** come from the host `Button` primitive in three variants: `primary` (the one main action in a view), `outline` (most secondary actions) and `ghost` (low-emphasis actions in toolbars and menus). Do not restyle them locally.
- **Icon button:** 28px square, 8px radius, transparent, Slate icon. Hover adds the Hover Veil and Ink colour over 0.1s. Row actions stay hidden until the row is hovered or focused.
- **Rail dock:** 36px square buttons, in the order 主页, 新建会话, 搜索, 角色. The pressed item gets a Paper fill with the pressed-tab shadow.

### Chips and Tags
- **Tag** (`.nodo-tag`): the one small-label component, used for task types, difficulty, role kind, identity, recommended options, workflow exit targets, human-provided output and the read-only marker. It replaces the host `Tag`, whose amber text is unreadable and which does not survive outside dsh. It is 20px tall with a 6px radius, Hover Veil fill and 12px/400 Slate text, and long text truncates with an ellipsis. `data-tone="accent"` (Signal Blue) and `data-tone="caution"` (Caution Amber) tint the text and mix the same colour at 10% into the fill. Any other `data-tone` value applies the 10% mix to whatever `--nodo-tag-tone` the context sets, as workflow exits do. Context classes add only layout or font (for example the monospace identity cell), never their own shape or colour.
- **Chip:** 24px tall, 8px radius, leading avatar or icon. It is used for lead dispatches inside a round.

### Cards / Containers
- **Corner Style:** 16px (inline), 20px (floating).
- **Background:** Paper on Mist, or the host layer-1 surface.
- **Shadow Strategy:** flat with a 0.5px Hairline Strong edge; floating cards follow the Elevation rules.
- **Approval card:** 1px Caution Amber edge, 20px radius, Lift shadow, 15px/500 headline.
- **IO / tool card:** Mist code-block background, 16px radius, 0.5px faint hairline, small mono font.

### Inputs / Fields
- **Composer:** Paper, 28px radius, Panel shadow, borderless textarea with a Signal Blue caret and Pebble placeholder. A tool row beneath holds the role, mode and model pickers plus the circular send button.
- **Fields:** the host `Input` primitive inside 440px dialogs, 12px vertical field rhythm.
- **Focus:** a 2px Signal Blue outline with 1–2px offset on custom controls.

### Navigation
- **Rail rows:** transparent with a 12px radius. Hover adds the Hover Veil; the selected row takes the sidebar nav active grey, with no outline or shadow. Names are 13px/500 with a 12px Pebble meta line; long names truncate with an ellipsis.
- **Roster:** a single column of 36px rows with a 24px avatar and a 13px name, folded after five roles. A lead's avatar gets a 1.5px ring in its role colour. The selected row follows the rail row states.

### Role Avatar (signature)
A pastel blob with two upright pill eyes on a tile of its own colour. Idle it is still; it greets (a 0.45s wobble) on hover, hops on a 1.6s loop and blinks every 3.8s while its Agent runs. This is the brand's face. Reuse it wherever a role appears instead of initials or generic icons.

### Workflow Node (signature)
A 204×96px Paper card with a 24px radius and a 2px border tinted by node kind (Signal Blue for execution, Done Green for start/finish, Caution Amber for human checkpoints). Edges are solid Signal Blue for "continue" and 6/5-dashed amber for "rework".

### Run Steps
A vertical list whose 22px circular marks are tinted with the step's status at 14%, joined by a 1px hairline spine. Warning steps get an 8% amber wash on the whole row.

## Do's and Don'ts

### Do:
- **Do** reference colours, radii, fonts and shadows through tokens (`var(--dsw-…)` today, or the Nodo `--nodo-*` aliases), never raw hex in component CSS.
- **Do** keep chrome neutral and let role avatars and status marks carry colour.
- **Do** use 0.5px hairlines and tonal steps (Mist vs Paper) to separate regions.
- **Do** make nested corners concentric (inner radius = outer radius − inset).
- **Do** use `.nodo-tag` for every small inline label instead of the host `Tag` or a new badge or pill class.
- **Do** colour amber text with `WARN_INK`, never with the raw warn token.
- **Do** tint status surfaces at 8–14% and keep solid status colour to dots, marks and borders.
- **Do** wrap every animation in a `prefers-reduced-motion` override.
- **Do** lay out text so Chinese and English copy of different lengths both fit, using truncation with an ellipsis and `overflow-wrap:anywhere`.

### Don't:
- **Don't** use large blocks of colour or decorative gradients as backgrounds, headers or section fills.
- **Don't** drift into a terminal-hacker look: no black-and-green screens and no monospace outside code, diffs, the terminal and tool output.
- **Don't** add shadows to rows, inline cards or list items.
- **Don't** use Signal Blue decoratively or give it a second meaning.
- **Don't** replace role avatars with initials, generic person icons or engine logos when the subject is a role.
- **Don't** restyle host primitives (`Button`, `Input`, `Menu`, `Tooltip`) locally.
