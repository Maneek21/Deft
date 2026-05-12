# Design System Specification: The Quiet Workspace

## 1. Overview & Creative North Star
**The Creative North Star: "The Digital Curator"**

This design system rejects the frantic, neon-soaked aesthetic of traditional "AI productivity" tools. Instead, it adopts the persona of a high-end, quiet library. It is an editorial-first workspace where density does not mean clutter, and power does not mean noise.

The system breaks the "SaaS template" look through **intentional atmospheric layering**. We do not use lines to separate ideas; we use depth. By leaning into high-density typography and monochromatic surfaces, we create an environment where the user’s work—not the UI—is the hero. The goal is a "Linear-meets-Arc" precision: a workspace that feels like a physical object made of glass, obsidian, and soft light.

---

## 2. Colors & Atmospheric Tones
The palette is rooted in deep obsidian, using Muted Violet sparingly as a "surgical" accent rather than a primary brand wash.

### Surface Hierarchy & The "No-Line" Rule
Traditional 1px borders are prohibited for sectioning. Boundaries must be defined through background shifts or tonal nesting.
- **Base Layer:** `surface` (#131315) – The foundation of the application.
- **Sectioning:** Use `surface-container-low` (#1C1B1D) to define sidebars or utility panels against the base.
- **Nesting:** Place `surface-container-highest` (#353437) cards inside a `surface-container` (#201F22) area to create a soft, natural lift.

### The Glass & Gradient Rule
To move beyond a "flat" dark mode, floating elements (modals, command palettes) must use **Glassmorphism**:
- **Fill:** `surface_variant` (#353437) at 70% opacity.
- **Effect:** `backdrop-blur: 12px`.
- **Signature Touch:** Apply a subtle linear gradient to primary CTAs (from `primary` to `primary_container`) to give buttons a tactile, jewel-like quality.

---

## 3. Typography
We utilize a high-contrast scale where "small is sophisticated." All type is set in **Inter**, utilizing variable weights to create hierarchy without increasing size.

| Level | Size | Weight | Leading | Tracking | Token |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Display** | 3.5rem | 600 | 1.1 | -0.02em | `display-lg` |
| **Headline** | 1.75rem | 600 | 1.2 | -0.01em | `headline-md` |
| **Title** | 1rem | 500 | 1.4 | 0 | `title-sm` |
| **Body** | 0.875rem | 400 | 1.5 | 0 | `body-md` |
| **Label** | 0.6875rem | 600 | 1 | +0.05em | `label-sm` (Caps) |

**Technical Data:** Use **JetBrains Mono** for AI-generated IDs, timestamps, or code snippets. It signals "Technical Precision" and should always be set at `body-sm` (0.75rem).

---

## 4. Elevation & Depth
Depth is achieved through "Tonal Layering." We do not "lift" objects with light; we "stack" them with shade.

- **The Layering Principle:** To create a card, do not draw a box. Instead, shift the background to `surface-container-lowest` (#0E0E10) against the `surface` background.
- **Ambient Shadows:** For floating elements only (popovers, menus), use a "Tinted Shadow": `0px 8px 24px rgba(0, 0, 0, 0.4)`. Avoid grey shadows; the shadow should feel like a hole in the light.
- **The Ghost Border:** If a separator is required for accessibility, use `outline-variant` (#474553) at **10% opacity**. This creates a "breath" of a line rather than a hard edge.

---

## 5. Components & Precision Primitives

### Buttons: The Tactile Strike
- **Primary:** Background `primary_container` (#9080FA). Text `on_primary_container`. No border. Transition: 150ms ease-out.
- **Secondary/Ghost:** Background `transparent`. Border: `outline-variant` @ 20%. 
- **Interaction:** On hover, primary buttons should increase in saturation slightly, not brightness.

### Inputs & AI Command Bars
- **Style:** Never use a solid white background. Use `surface_container_low`. 
- **Focus State:** 0px 0px 0px 2px `primary` at 30% opacity. No "glow" – just a sharp, precise ring.
- **AI-Agent Input:** Should use a subtle `primary_fixed_dim` gradient border (1px) to distinguish human input from AI-interactive zones.

### Cards & Lists: Editorial Separation
- **No Dividers:** Prohibit the use of `divider` lines.
- **Negative Space:** Use the Spacing Scale `4` (0.9rem) to separate list items. Use background-color toggles (`surface` vs `surface-container-low`) for hover states to indicate selection.

### Precision Chips
- **Scale:** `label-sm`.
- **Shape:** `rounded-md` (0.375rem).
- **Color:** `surface_container_highest` background with `on_surface_variant` text.

---

## 6. Interaction & Motion
Every interaction must feel "snappy" but "damped."
- **Transitions:** Global duration of **150ms**.
- **Easing:** `cubic-bezier(0.16, 1, 0.3, 1)` (The "Out-Quint" feel—starts fast, ends softly).
- **Keyboard-First:** Every interactive element must have a visible `outline` focus state using the `primary` token at 40% opacity.

---

## 7. Do's and Don'ts

### Do
- **Do** use `JetBrains Mono` for any data that is immutable (IDs, times, AI status).
- **Do** use varying weights of Inter (400 vs 600) to create hierarchy instead of just making text larger.
- **Do** lean into the "Quiet Library" vibe—if a screen feels too busy, increase the background-to-text contrast and add `spacing-8`.

### Don't
- **Don't** use pure black (#000000) or pure white (#FFFFFF). Use the provided surface and on-surface tokens.
- **Don't** use 1px solid borders for layout containers. Use color-blocking (Tonal Layering).
- **Don't** use rounded corners larger than `xl` (0.75rem) for main UI containers. Keep it architectural, not "bubbly."
- **Don't** use shadows on buttons. They should feel embedded in the glass, not floating above it.