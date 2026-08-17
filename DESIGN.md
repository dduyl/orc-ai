# ORC GUI — Design System: Industrial Command Deck

> The contract for the Electron GUI (`src/delivery/gui/)`. `index.html` and the
> renderer implement this document. Aesthetics per the `frontend-design` skill:
> cohesive, intentional, unapologetically a developer instrument.

## 1. Purpose & tone

ORC runs and supervises AI coding agents. The operator watches an agent think,
run tools, and request permission to act. The GUI must read like an **instrument
panel for a machine that writes code** — precise, calm, industrial. Nothing
playful, nothing decorative for its own sake.

- **Direction:** industrial command deck / brutally functional dark instrument.
- **Memory hook:** a thin **amber data-rail** along the top of every active
  surface and an amber "live" pip on the titlebar — the machine is running.
- **Voice:** terse labels, uppercase section micro-headings, mono where data.

## 2. Color tokens

Layered charcoal surfaces + one sharp accent (amber). Status colors are
functional, low-saturation so the accent stays the only loud voice.

```css
--bg-base:      #0b0e11;   /* app background, deepest charcoal */
--bg-surface:   #12161b;   /* panels: titlebar, right inspector, input wells */
--bg-raised:    #1a2027;   /* hover, cards, dialogs */
--bg-inset:     #0e1216;   /* terminal well, code, typed content */
--border-subtle:#232b34;   /* default hairlines */
--border-strong:#31404e;   /* focus, emphasis lines */
--text-primary: #e6edf3;   /* headings, primary copy */
--text-secondary:#9aa7b4;  /* labels, secondary copy */
--text-faint:   #5d6b7a;   /* metadata, placeholders, section titles */

--accent:       #ffb454;   /* amber — the single loud voice */
--accent-dim:   rgba(255,184,84,.14);
--accent-edge:  rgba(255,184,84,.45);

--ok:           #58d68d;   /* success / connected / allow */
--err:          #ff6b6b;   /* failure / disconnected / exit */
--warn:         #ffb454;   /* pending / running (falls into accent) */
--info:         #6bc9ff;   /* informational / tool activity */
```

Rules: `--err` and `--ok` never bleed into the general palette; the accent is
reserved for "power is on". Terminal ANSI maps onto these in §7.

## 3. Typography

```css
--font-ui:    "Chivo", "Helvetica Neue", Arial, sans-serif; /* grotesque, mechanical */
--font-mono:  "JetBrains Mono", "Cascadia Code", Consolas, monospace; /* data, terminal */
```

- UI chrome (tabs, buttons, titles, labels) — `--font-ui`, tight tracking.
- Data (status, steps, events, terminal, chat tokens) — `--font-mono`.
- Section micro-headings: 10px, uppercase, `letter-spacing: 1.6px`,
  `--text-faint`.
- Body 13px, mono data 12px.

## 4. Spacing, radius, motion, shadow

```css
--space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
--space-5:20px; --space-6:24px;

--radius-sm:3px; --radius-md:6px; --radius-lg:10px;

--dur-fast:120ms; --dur-med:220ms;
--ease-out: cubic-bezier(.22,1,.36,1);

--shadow-pop: 0 8px 24px rgba(0,0,0,.5);
--shadow-dialog: 0 24px 64px rgba(0,0,0,.65), 0 2px 8px rgba(0,0,0,.5);

--title-h:40px; --status-h:28px; --inspector-w:300px;
```

Motion is restrained: quick opacity/translate reveals on panels, 140ms button
press scale, a subtle slide-up on the permission dialog. No bounce, no scatter.

## 5. Layout wireframe

```
┌──────────────────────────────────────────────────────────────────┐
│ ORC ● opencode            [Chat][Terminal]          ● Attached   │
├──────────────────────────────────┬───────────────────────────────┤
│ (chat-view | terminal-view)      │  SESSION                      │
│                                  │  adapter / pid / size / mode  │
│  ┌────────────────────────────┐  ├───────────────────────────────┤
│  │ chat list / xterm          │  │  RUNS  (step tree)            │
│  │                            │  │  ● step ✓  ● step ▶  ○ …      │
│  └────────────────────────────┘  ├───────────────────────────────┤
│  ┌────────────────────────────┐  │  EVENTS (activity feed)       │
│  │ [prompt…            ] [▶]  │  │  › step_start  spec           │
│  └────────────────────────────┘  └───────────────────────────────┘
├──────────────────────────────────┴───────────────────────────────┤
│ ● acp  • 120×34  • Exited: —  • View: chat            ORC v0.1   │
└──────────────────────────────────────────────────────────────────┘
```

- **Titlebar:** brand, view tabs (global navigation), live status (dot + text).
- **Main split:** content pane (one view at a time) | vertical splitter |
  inspector (fixed 300px, min 180px).
- **Statusbar:** mode, term size, exit code, active view; quiet metadata.

## 6. Navigation model

- **Two global views:** `chat` and `terminal` (top tabs, Ctrl+1 / Ctrl+2).
  Only one is visible; both stay mounted so state (chat history, xterm
  scrollback) survives switching.
- **Chat view** is the default when the agent runs over ACP; terminal view is
  the raw pane the step/PTY frames feed.
- **Inspector** is scrollable and always open; its sections collapse.
- **Permission dialog** is a modal above everything; Escape cancels the request
  (reject), Enter confirms the focused option.

## 7. Component spec

- **View tab** — text button; active = 2px amber underline + `--text-primary`;
  inactive = `--text-secondary`, hover `--text-primary`.
- **Chat message, user** — right-aligned raised chip, mono, primary text.
- **Chat message, assistant** — full-width text block streaming in place as
  `agent_message_chunk` arrives.
- **Tool-call chip** — raised card with a dot + `name`, dim mechanical styling;
  `tool_update` collapsess into the same chip.
- **Usage footer** — faint mono line after each turn: `tokens in/out · cost`.
- **Turn marker** — hairline divider with `stopReason` caption.
- **Permission dialog** — centered `--bg-raised` card, `--shadow-dialog`,
  amber left rail; options rendered as buttons from `PermissionOption[]`
  using their `name`; grouped allow vs reject by `kind`.
- **Step row** — mono, leading status glyph (`✓ ○ ▶ ✗`), active row get
  `--accent-dim` fill + accent pip.
- **Event entry** — faint mono line, `› ` prefix.
- **Status dot** — 8px circle; `--ok` connected / `--err` exited / faint idle.
- **Empty states** — centered faint mono line ("No active run", "Waiting for
  a message…").

## 8. Accessibility

- Keyboard: tabs focusable, Enter/Space activate; Enter sends chat; Escape
  clears/hides dialog; Ctrl+1/2 switch views.
- `aria-modal`, `role=dialog`, labelled actions; focus moves into the dialog on
  open and returns to the chat input on close.
- Color is never the only signal (dot+text, glyph+color).

## 9. Terminal theming

xterm `.theme` maps to the same surfaces:
background `--bg-inset`, foreground `--text-primary`, cursor `--accent`,
selection `--bg-raised`, and ANSI 16 derived from the palette so step
scrollback reads like the rest of the deck (green/red = `--ok`/`--err`,
cyan/blue from `--info`, yellow/amber from `--accent`).