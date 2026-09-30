@AGENTS.md

# Design rules (client UI)

These are hard constraints for any UI in this app. The goal is a restrained,
human-crafted product interface — not a template, not a generated landing page.
When in doubt, do less.

## Palette

- **Canvas: pure black `#000000` (AMOLED).** Never `#0a0a0a`, `#111`, or any
  near-black for the page background. True black only.
- **Surfaces** (cards, inputs, elevated panels): `#0e0e0e`, separated from the
  canvas with a hairline `border-white/10` — not with a lighter fill or a shadow.
- **Accent: a single burgundy, `#8C1C2B`**. Used sparingly — one
  primary action per view, danger/critical states, and the rare word that must
  carry weight. Red is a scalpel, not a highlighter. No second accent color.
- **Text:** white for headings, `zinc-400` for body, `zinc-500/600` for
  captions and mono labels. No pure-white body copy.

## Typography

- Geist Sans for everything on-screen; Geist Mono for code, IDs, targets,
  metrics, timestamps. No other typefaces. No decorative or "techy" display
  fonts.
- Headings: 600 semibold, tight tracking. Body: 400, ~1.6 line height.
- Never put gradients on text. Never use all-caps except small mono labels
  (`text-xs uppercase tracking-widest`).

## Copy / writing

- **Never use em dashes (`—`) anywhere.** Not in UI copy, headings, sub-headings,
  code comments, metadata, or docs. Rewrite the sentence instead: split it into
  two sentences, or use a comma, colon, or parentheses. This is a hard rule with
  no exceptions.
- Keep copy short and plain. Prefer one short sentence over a long clause-stacked
  one.

## Do NOT add "AI-generated"-looking decoration

These scream template / auto-generated. Do not add them unless I explicitly ask:

- **No glowing/pulsing status "LED" dots** before or beside text — no
  `animate-ping`, no colored dot as a badge marker, no blinking indicators.
  State goes in a plain word ("Live", "Failed") or a small mono label, colored
  if needed.
- **No logo, no logomark, no wordmark-in-a-box.** Do not invent an initial-in-a-
  rounded-square, monogram, or any brand glyph. Use the plain text name until I
  supply a real logo.
- No gradient backgrounds, no glassmorphism/`backdrop-blur` panels, no glow or
  neon shadows, no colored drop-shadows.
- No emoji as UI iconography, no rocket/sparkle/lightning motifs.
- No pill "badges" with a leading dot, no floating "✨ AI-powered" tags.
- No purple→blue or any multi-stop gradient hero. Flat black, hairline borders.
- **No type-spec / "design-token" annotation captions.** Never label a sample
  with its own settings — no `display / headings · 600 semibold · tight
  tracking`, no `body · 400 · zinc-400`, no `Geist Mono · code, IDs, metrics`,
  and nothing of that shape (`<role> · <weight> · <tracking>` or a font name
  followed by a usage list). It reads as a generated style-guide, not a product.
  Show the type by using it; do not narrate its CSS.
- No oversized centered marketing hero unless the page is genuinely a landing
  page and I ask for one.

## Structure

- Separate sections with a hairline top border (`border-white/10`), not with
  large empty cards or background-color blocks.
- Radii: 6px (`rounded-md`). Consistent everywhere. No fully-rounded pills for
  buttons; no sharp 0px corners either.
- Keep motion minimal: color/opacity transitions and a subtle `active:scale`
  on press. No entrance animations, parallax, or auto-playing motion.

If a proposed element would look at home on a generic AI-generated SaaS landing
page, cut it.
