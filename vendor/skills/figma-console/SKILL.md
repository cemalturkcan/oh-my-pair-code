---
name: figma-console
description: Design in Figma Desktop via figma-console-mcp (63+ tools). Covers connection setup, design system creation (tokens, styles, components), screen design, linting, accessibility audits, variable management, and visual validation workflows. Use when the user asks to work with Figma — creating designs, editing components, auditing files, or managing design tokens.
---

## Purpose

Use this skill for all Figma Desktop work via the `figma-console` MCP server. This server bridges AI to Figma Desktop through a WebSocket Desktop Bridge plugin, providing 63+ tools for design creation, variable management, component instantiation, screenshots, linting, and console debugging.

## Use When

- User asks to create, edit, or audit a Figma design
- User asks to set up a design system (tokens, components, styles)
- User mentions Figma, design, or UI/UX work
- Tools prefixed with `figma-console_figma_*` are relevant

## Do Not Use When

- User needs static mockups or wireframes in code (use frontend-design skill)
- User wants Figma Dev Mode API data (that was the old figma-developer-mcp, now removed)

---

## Execution Philosophy: Keep Moving, Don't Wait

**The #1 rule of Figma work: NEVER stop and wait for approval in the middle of a design task.**

When the user gives you a design task (e.g. "redesign this app", "create 10 design directions", "build the screens"):

1. **Do the FULL task end-to-end.** If they said "create 10 design directions then build screens for the best one" — create all 10 directions AND then pick the strongest one and start building screens. Don't stop after step 1 to ask "which one do you like?"
2. **Make design decisions yourself.** You are the designer. If you need to choose a color palette, font, layout — choose it. Pick the best option based on your research and move on.
3. **Only stop for true blockers:** missing credentials, ambiguous project scope, or explicitly requested checkpoints ("show me before you continue").
4. **Present results, not options.** Instead of "here are 10 directions, which do you prefer?" → create all 10, pick the best 2-3, and BUILD the actual screens for those. The user can always ask for changes.
5. **Screenshots are checkpoints, not gates.** Take a screenshot to verify YOUR work looks correct, then immediately continue to the next step. Don't present the screenshot and wait.

**BAD pattern (stops momentum):**

```
→ Create 10 design cards
→ Screenshot all 10
→ "Here are 10 directions! Which one do you like?"
→ ... wait for user ...
```

**GOOD pattern (continuous execution):**

```
→ Create 10 design cards
→ Quick screenshot to verify (1 shot, scale=0.5)
→ Analyze: directions 3, 5, 8 are strongest
→ Immediately start building full screens for direction 5
→ Build Start Screen → Home Screen → Subscription → Profile
→ Final screenshot of all completed screens
→ "Here's the full redesign. I chose direction 5 (Lavender Dream) because [reasons]. Want me to try a different direction or adjust anything?"
```

**The user hired you to DESIGN, not to present menus.**

---

## Connection Lifecycle

```
1. figma_get_status                → verify connection + identify active file
2. figma_get_file_data (depth=1)   → understand file structure
3. ... do work ...
4. figma_capture_screenshot        → verify changes visually
```

**Always check status first.** The server may run locally or via SSH to a remote Mac. Connection issues surface immediately from `figma_get_status`.

### Troubleshooting Connection

- If status shows no WebSocket connection → Desktop Bridge plugin needs to be running in Figma
- If SSH transport fails → check `figma_console.ssh_host` in harness config
- Port fallback is normal (9223 → 9224, etc.) when multiple instances exist

---

## Tool Categories & When to Use Each

### Observation (read-only, cheap)

| Tool                                  | When                                                              | Cost    |
| ------------------------------------- | ----------------------------------------------------------------- | ------- |
| `figma_get_status`                    | Start of session, verify connection                               | Low     |
| `figma_get_file_data`                 | Understand file structure, find node IDs                          | Low-Med |
| `figma_capture_screenshot`            | **Visual validation after ANY change**                            | Med     |
| `figma_observe_a11y`                  | Accessibility tree inspection                                     | Med     |
| `figma_get_design_system_summary`     | Quick overview of existing design system                          | Low     |
| `figma_get_variables`                 | Read design tokens/variables                                      | Med     |
| `figma_get_styles`                    | Read text/color/effect styles                                     | Med     |
| `figma_get_component`                 | Single component metadata                                         | Med     |
| `figma_get_component_for_development` | Component specs + image for code gen                              | High    |
| `figma_get_design_system_kit`         | **Full design system extraction** (preferred over separate calls) | High    |
| `figma_lint_design`                   | Accessibility + design quality audit                              | Med     |
| `figma_get_selection`                 | What user has selected in Figma                                   | Low     |
| `figma_get_comments`                  | File comments/feedback                                            | Low     |

### Creation & Editing

| Tool                   | When                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| `figma_execute`        | **Complex operations** — create pages, sections, custom shapes, bulk operations |
| `figma_create_child`   | Create simple child nodes (rect, ellipse, frame, text, line)                    |
| `figma_set_fills`      | Change fill colors                                                              |
| `figma_set_strokes`    | Change borders                                                                  |
| `figma_set_text`       | Change text content                                                             |
| `figma_set_image_fill` | Apply image to a node (base64 or file path)                                     |
| `figma_resize_node`    | Change dimensions                                                               |
| `figma_move_node`      | Reposition a node                                                               |
| `figma_clone_node`     | Duplicate a node                                                                |
| `figma_delete_node`    | Remove a node                                                                   |
| `figma_rename_node`    | Fix naming                                                                      |

### Design System

| Tool                                                     | When                                                                             |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `figma_setup_design_tokens`                              | **Create complete token structure in one call** (collection + modes + variables) |
| `figma_create_variable_collection`                       | Create empty collection                                                          |
| `figma_create_variable` / `figma_batch_create_variables` | Add variables to collection                                                      |
| `figma_update_variable` / `figma_batch_update_variables` | Change variable values                                                           |
| `figma_add_mode`                                         | Add modes (Light/Dark)                                                           |
| `figma_search_components`                                | Find components by name                                                          |
| `figma_instantiate_component`                            | Create component instance                                                        |
| `figma_set_instance_properties`                          | Update instance props (text, boolean, variant)                                   |
| `figma_arrange_component_set`                            | Organize variant grid                                                            |

### Console & Debugging

| Tool                     | When                           |
| ------------------------ | ------------------------------ |
| `figma_get_console_logs` | Read plugin console output     |
| `figma_watch_console`    | Stream logs during testing     |
| `figma_clear_console`    | Clear log buffer               |
| `figma_reload_plugin`    | Reload plugin for code changes |

---

## Critical Patterns

### Pattern 1: Screenshot Discipline — Validate, Don't Spam

```
1. Make a change (set_fills, create_child, execute, etc.)
2. figma_capture_screenshot (nodeId of changed area)
3. Analyze the screenshot
4. If wrong → fix and screenshot again (up to 3 iterations)
```

`figma_capture_screenshot` shows the CURRENT plugin runtime state — guaranteed to reflect recent changes. This is more reliable than REST API screenshots.

**CRITICAL: Do NOT screenshot excessively.**

- Take ONE overview screenshot per completed section, not one per element
- When building multiple similar items (e.g. 10 design cards), take 1-2 screenshots of the full grid at low scale (scale=0.5), NOT individual screenshots of each item
- Screenshots are for YOUR validation — if the design looks correct, move on immediately
- Never take more than 3 screenshots in a row without making actual progress

### Pattern 2: Use figma_execute for Complex Operations

Simple tools (`create_child`, `set_fills`) are fine for single operations. For anything involving:

- Creating pages (`figma.createPage()`)
- Multiple related nodes
- Auto-layout setup
- Gradient fills
- Font loading
- Complex positioning

Use `figma_execute` with JavaScript:

```javascript
// IMPORTANT: Use setCurrentPageAsync, not set currentPage
await figma.setCurrentPageAsync(page);

// IMPORTANT: Load fonts before setting text
await figma.loadFontAsync({ family: "Inter", style: "Regular" });

// Create with auto-layout
const frame = figma.createFrame();
frame.layoutMode = "VERTICAL";
frame.primaryAxisAlignItems = "CENTER";
frame.counterAxisAlignItems = "CENTER";
frame.paddingTop = 24;
frame.itemSpacing = 16;
```

### Pattern 3: Design System Creation Order

```
1. Create color tokens     → figma_setup_design_tokens (collection: "Colors")
2. Create spacing tokens   → figma_setup_design_tokens (collection: "Spacing")
3. Create typography tokens → figma_setup_design_tokens (collection: "Typography")
4. Create components        → figma_execute (buttons, cards, nav bars)
5. Build screens            → figma_execute (compose components into screens)
6. Validate                 → figma_lint_design + figma_capture_screenshot
```

### Pattern 4: Component Instances (Not Direct Text Editing)

When working with component instances:

```
BAD:  figma_set_text on a text node inside an instance → may fail silently
GOOD: figma_set_instance_properties with property overrides
```

Always check `instance.componentProperties` for available props first.

### Pattern 5: Placement Hygiene

- **Always create inside a Section or Frame**, never on bare canvas
- **Screenshot the target area first** to find clear space
- **Position BELOW or AWAY from existing content** — never overlap
- **Clean up partial artifacts** on failure (empty frames, orphaned layers)
- **Never create a page if one with that name already exists**

### Pattern 6: Full Design Audit

```
1. figma_lint_design (rules: ["all"], maxFindings: 200)
2. figma_get_design_system_kit (format: "full")
3. figma_capture_screenshot for key screens
4. Compile findings into categorized report
```

Lint categories: `wcag-contrast`, `wcag-text-size`, `wcag-line-height`, `hardcoded-color`, `no-text-style`, `default-name`, `no-autolayout`, `empty-container`

---

## Design Quality: Creating Beautiful, Modern Interfaces

**This is not a wireframing tool. You are expected to produce polished, production-grade designs.**

### Mindset: Research Before You Design

Before creating any screen, research what best-in-class apps look like. You have full access to the internet — USE IT.

```
1. jina_search_web / jina_search_images  → find design inspiration
2. jina_read_url                         → study specific design references
3. jina_capture_screenshot_url           → capture visual references from live apps
4. grep_app_searchGitHub                 → find real component implementations
```

#### Where to Find Inspiration

Use `jina_search_images` and `jina_search_web` with queries like:

- `"[app category] mobile app UI design 2025 dribbble"` — e.g. "fashion tryon app mobile UI design 2025 dribbble"
- `"[screen type] screen design inspiration behance"` — e.g. "subscription paywall screen design inspiration behance"
- `"[component] component modern design"` — e.g. "bottom navigation bar modern design iOS"
- `"[app name] app redesign concept"` — study redesign concepts of popular apps

**Top design reference sites:**

- **Dribbble** (dribbble.com) — UI shots, component details
- **Behance** (behance.net) — full case studies
- **Mobbin** (mobbin.com) — real app screenshots organized by pattern
- **Screenlane** (screenlane.com) — mobile UI patterns
- **Refero** (refero.design) — curated real product screenshots

#### Research Workflow for a New Screen

```
1. jina_search_images("modern [screen type] mobile app UI 2025")
   → Study 3-5 top results for layout patterns, color usage, spacing
2. jina_search_web("[app category] best app design award")
   → Find award-winning apps in the same category
3. jina_capture_screenshot_url on a reference app
   → Get pixel-level reference for spacing, typography, component density
4. NOW design — with concrete references, not from imagination
```

#### Deep Design Research with Browser Automation

When the user says "browse for inspiration", "look at designs", or similar — **actively browse real design sites** using all available tools:

**Dribbble / Behance / Mobbin browsing with web-agent-mcp:**

```
1. web-agent-mcp → session_create
2. page_navigate("https://dribbble.com/search/[category]-app-design")
3. observe_screenshot → study the search results grid visually
4. act_click on promising shots → navigate to detail page
5. observe_screenshot → capture the full design in detail
6. Repeat for 3-5 top results
7. session_close
```

**Faster approach with jina (no browser session needed):**

```
1. jina_search_images("[app category] app UI design", num=10)
   → visual thumbnails of top designs
2. jina_read_url("https://dribbble.com/shots/[id]")
   → read shot description, tags, designer notes
3. jina_capture_screenshot_url("https://dribbble.com/shots/[id]")
   → full-resolution capture
4. jina_search_web("site:mobbin.com [screen type]")
   → real app screenshots for that pattern
```

**Live app screenshots for pixel-perfect reference:**

```
1. web-agent-mcp → session_create (viewport: {width: 393, height: 852} for mobile)
2. page_navigate to a live app or competitor website
3. observe_screenshot → capture the real UI at mobile scale
4. Study spacing, colors, typography, component density
5. Apply learnings to your Figma design
```

**Tool selection guide:**
| Scenario | Tool | Why |
|----------|------|-----|
| Quick visual inspiration | `jina_search_images` | Fast, returns thumbnails |
| Read design article / case study | `jina_read_url` | Clean markdown extraction |
| Full-page screenshot of a site | `jina_capture_screenshot_url` | No browser needed |
| Interactive browsing (login walls, filtering, scrolling) | `web-agent-mcp` | Full browser control |
| Mobile viewport of a live app | `web-agent-mcp` with `viewport: {width:393, height:852}` | Realistic mobile view |
| Find design system documentation | `context7` or `jina_read_url` | Structured docs |
| Real code examples of a component | `grep_app_searchGitHub` | Production implementations |

### Icons & SVG Assets

**Never use placeholder rectangles for icons.** Find and use real SVGs.

#### Icon Libraries (Free, High Quality)

Use `jina_read_url` to fetch SVG code directly:

| Library       | URL Pattern                                                                                       | Style                     |
| ------------- | ------------------------------------------------------------------------------------------------- | ------------------------- |
| **Lucide**    | `https://lucide.dev/api/icons/[name]`                                                             | Clean, minimal line icons |
| **Phosphor**  | `https://raw.githubusercontent.com/phosphor-icons/core/main/assets/regular/[name].svg`            | Flexible, 6 weights       |
| **Heroicons** | `https://raw.githubusercontent.com/tailwindlabs/heroicons/master/optimized/24/outline/[name].svg` | Tailwind ecosystem        |
| **Tabler**    | `https://raw.githubusercontent.com/tabler/tabler-icons/main/icons/outline/[name].svg`             | 5400+ icons               |
| **Feather**   | `https://raw.githubusercontent.com/feathericons/feather/main/icons/[name].svg`                    | Simple, clean             |

#### How to Use Icons in Figma

```
1. jina_read_url("https://lucide.dev/api/icons/home")     → get SVG string
2. figma_execute with figma.createNodeFromSvg(svgString)   → insert into Figma
3. Resize, recolor as needed
```

**Finding the right icon name:**

```
jina_search_web("lucide icons [concept]")           → find icon names
jina_read_url("https://lucide.dev/icons")           → browse full icon list
jina_search_images("[concept] icon svg minimal")     → visual search
```

#### SVG Insertion Pattern in figma_execute

```javascript
// Fetch SVG from URL and create in Figma
const svgString =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>';
const icon = figma.createNodeFromSvg(svgString);
icon.name = "icon/home";
icon.resize(24, 24);
// Recolor: find all vectors inside and change fills
const vectors = icon.findAll((n) => n.type === "VECTOR");
vectors.forEach((v) => {
  v.strokes = [{ type: "SOLID", color: { r: 0.42, g: 0.24, b: 0.88 } }];
});
parent.appendChild(icon);
```

### Modern Design Principles (2024-2026)

**Follow these principles for every screen you create:**

#### Visual Hierarchy & Depth

- Use **subtle shadows** (not flat, not skeuomorphic) — `0 2px 8px rgba(0,0,0,0.06)` for cards
- Apply **background blur** on overlays and nav bars for glassmorphism
- Layer depth: background → surface → elevated surface → overlay
- **Large, generous whitespace** — let content breathe. More space = more premium

#### Typography

- **One font family maximum** (two if there's a clear display/body split)
- Prefer modern sans-serif fonts: **Inter, SF Pro, Satoshi, Plus Jakarta Sans, Outfit, Manrope, Geist**
- Create clear typographic hierarchy with **size + weight contrast**, not just size
- Display text: bold/black weight. Body: regular/medium. Never use light weight under 16px
- **Letter-spacing:** -0.02em to -0.04em on large headings (tighter = more modern)

#### Color

- **One primary brand color + neutrals.** That's it. Don't use a rainbow.
- Modern palettes use **muted, sophisticated tones** — not pure saturated colors
- Background should be warm-white (`#FAFAF8`) or cool-white (`#F8F9FC`), NOT pure `#FFFFFF`
- Dark text should be near-black (`#111111` or `#1A1A2E`), NOT pure `#000000`
- Use **subtle tints of brand color** for backgrounds, badges, selected states
- Gradient usage: subtle, 2-color, on brand elements only. Not everywhere.

#### Spacing & Layout

- Base everything on **8px grid** (or 4px for fine adjustments)
- Screen padding: **20-24px** horizontal on mobile (393px width)
- Section gaps: **32-48px** vertical
- Card padding: **16-20px** internal
- Touch targets: **minimum 44px** height
- Use **auto-layout everywhere** — no manual positioning

### Component Design Standards

Every component you create must be **production-ready** — not a rough sketch. Follow these specs precisely.

#### Button Component

```
Structure:   Frame (auto-layout HORIZONTAL, center-aligned)
Heights:     Large: 56px | Medium: 48px | Small: 40px
H-Padding:   Large: 32px | Medium: 24px | Small: 16px
Corner:      12-16px radius (or fully round for pill style)
Font:        Body/Base weight=SemiBold or Bold (never Regular)
Icon:        Optional, 20px, 8px gap from text

Variants every button MUST have:
├─ Style:    Primary (brand fill + white text)
│            Secondary (transparent + brand border + brand text)
│            Ghost (transparent + text only, no border)
│            Destructive (error fill + white text)
├─ Size:     Large, Medium, Small
├─ State:    Default, Hover, Pressed, Disabled, Loading
└─ Icon:     None, Leading, Trailing

Primary fill:     bg/brand solid or brand gradient
Pressed state:    10% darker than default (multiply overlay)
Disabled state:   40% opacity, pointer-events none
Loading state:    text replaced with spinner, same dimensions
```

#### Card Component

```
Structure:   Frame (auto-layout VERTICAL)
Padding:     16-20px all sides
Corner:      16-24px radius
Background:  bg/surface (#FFFFFF or warm-white)
Elevation:   EITHER subtle shadow (0 2px 8px rgba(0,0,0,0.06))
             OR 1px border (border/default)
             NEVER both shadow + border together
Gap:         12-16px between content sections
Width:       Fill container (never fixed unless grid item)

Card should contain:
├─ Header area (optional: image, icon, badge)
├─ Content area (title, subtitle, body text)
└─ Action area (optional: buttons, links)
```

#### Input Field Component

```
Structure:   Frame (auto-layout HORIZONTAL, center-aligned vertically)
Height:      48-56px
Padding:     0 16px horizontal
Corner:      12px radius
Border:      1px border/default
Background:  bg/surface
Font:        Body/Base Regular for value, text/tertiary for placeholder
Icon:        Optional leading/trailing, 20px, muted color

States:
├─ Default:   border/default border
├─ Focused:   brand border (2px), subtle brand tint background
├─ Error:     accent/error border, error message below (12px, error color)
├─ Disabled:  50% opacity, bg/surface-elevated background
└─ Filled:    text/primary color, no placeholder
```

#### Bottom Navigation / Tab Bar

```
Structure:   Frame (auto-layout HORIZONTAL, space-between, center-aligned)
Height:      64-80px (includes safe area on iOS)
Safe area:   34px bottom padding on iPhone (home indicator)
Items:       3-5 items max
Item:        Frame (auto-layout VERTICAL, center, 4px gap)
             Icon: 24px, above label
             Label: 10-12px Medium weight
Touch:       Each item minimum 44x44px tap target

Active state:
├─ Icon:     text/brand color (filled variant, not outline)
├─ Label:    text/brand color
├─ Optional: dot indicator below icon, or tint background pill
Inactive state:
├─ Icon:     text/tertiary color (outline variant)
├─ Label:    text/tertiary color
```

#### Subscription / Pricing Card

```
Structure:   Frame (auto-layout VERTICAL)
Padding:     20-24px
Corner:      20-24px radius
Gap:         16px between sections

Must include:
├─ Plan name (Heading/H3 weight=Bold)
├─ Price (Display or H1 size, brand color for emphasized plan)
├─ Billing cycle (Body/Small, text/secondary)
├─ Feature list (checkmark icon + text, 12px gap between items)
├─ CTA button (full-width Primary button)
└─ Optional: "Best value" / "Most popular" badge

Selected/recommended plan:
├─ Brand color border (2px) or gradient border
├─ Subtle brand tint background
├─ Badge with brand gradient
Unselected plan:
├─ Default border, no fill, muted styling
```

#### Avatar / Profile Image

```
Shape:       Ellipse (circle clip)
Sizes:       XS: 24px | S: 32px | M: 40px | L: 56px | XL: 80px | XXL: 120px
Border:      Optional 2px white border (for overlapping stacks)
Fallback:    Initials on brand-tint background when no photo
Status dot:  8-12px circle, positioned bottom-right, green/gray/red
```

#### Badge / Chip / Tag

```
Structure:   Frame (auto-layout HORIZONTAL, center-aligned)
Height:      24-32px
Padding:     4-6px vertical, 8-12px horizontal
Corner:      Fully round (999px) for pills, or 8px for tags
Font:        Caption or Label size, Medium weight
Types:       Status (success/warning/error/info tint + text)
             Category (neutral bg + text)
             Brand (brand tint + brand text)
```

#### List Item / Row

```
Structure:   Frame (auto-layout HORIZONTAL, center-aligned, space-between)
Height:      56-72px
Padding:     0 20px horizontal
Separator:   1px border/subtle at bottom, or use spacing (preferred)

Layout:      [Leading icon/avatar] [Content: title + subtitle] [Trailing: icon/value]
Leading:     Icon (24px) or Avatar (40px), 12px gap to content
Content:     Auto-layout VERTICAL, 2-4px gap
             Title: Body/Base, text/primary
             Subtitle: Body/Small, text/secondary
Trailing:    Chevron icon, switch toggle, or value text
```

#### Modal / Bottom Sheet

```
Structure:   Frame (auto-layout VERTICAL)
Width:       Full screen width (393px on mobile)
Corner:      24px top-left and top-right (bottom corners: 0)
Background:  bg/surface
Padding:     24px horizontal, 20px top, 34px bottom (safe area)

Must include:
├─ Handle bar: 36x4px, centered, bg/surface-elevated, rounded
├─ Optional header: title + close button
├─ Content area: scrollable
└─ Optional footer: sticky action buttons
```

#### Empty State

```
Structure:   Frame (auto-layout VERTICAL, center-center)
Padding:     40px horizontal

Must include:
├─ Illustration or icon (64-120px, muted or brand color)
├─ Headline (Heading/H3, text/primary)
├─ Description (Body/Base, text/secondary, centered, max 280px width)
└─ CTA button (Primary or Secondary)
```

### Figma Component Construction Rules

When building components in `figma_execute`:

1. **Always use auto-layout** — `layoutMode: "VERTICAL"` or `"HORIZONTAL"`. No exceptions.
2. **Use `layoutSizingHorizontal/Vertical`** — `"FILL"` to stretch, `"HUG"` to fit content, `"FIXED"` only for specific sizes
3. **Name every layer meaningfully** — `"btn/primary"`, `"card/pricing"`, `"nav/tab-item"`, never `"Frame 1"`
4. **Create as Component** — `const comp = figma.createComponent()` not `figma.createFrame()` for reusable elements
5. **Add component properties** for variant control:
   ```javascript
   // After creating the component:
   comp.addComponentProperty("Label", "TEXT", "Button");
   comp.addComponentProperty("Show Icon", "BOOLEAN", true);
   ```
6. **Group related variants into Component Sets** for proper Figma variant panel:
   ```javascript
   const variants = [defaultVariant, hoverVariant, pressedVariant];
   const set = figma.combineAsVariants(variants, parentFrame);
   set.name = "Button";
   ```

### Screen Composition Standards

#### Mobile Screen Frame (iPhone 14/15 — 393×852)

```
Structure:
├─ Status Bar (54px height, contains time + icons)
├─ Navigation Bar (44-56px, optional back button + title)
├─ Content Area (scrollable, fills remaining space)
│   ├─ Horizontal padding: 20-24px
│   ├─ Section gap: 32-48px
│   └─ Content sections...
├─ Bottom Action (optional: sticky button area, 20px padding + safe area)
└─ Tab Bar (64-80px including 34px safe area)
```

#### Screen Padding System

```
Screen horizontal:     20-24px (CONSISTENT across ALL screens)
Content to nav bar:    16-24px
Section to section:    32-48px
Card to card:          12-16px
Text block internal:   8-12px line gap
Bottom safe area:      34px (iPhone home indicator)
```

#### iOS Status Bar

Always include. 54px height. Contains:

- Time (left), camera dot (center), signal + wifi + battery (right)
- Use text/primary color for dark-on-light, white for light-on-dark

### States & Edge Cases

**Design ALL of these for every screen, not just the happy path:**

| State         | What to Show                                   | Design Notes                       |
| ------------- | ---------------------------------------------- | ---------------------------------- |
| **Empty**     | Illustration + title + description + CTA       | Friendly, encouraging tone         |
| **Loading**   | Skeleton screens (animated shimmer rectangles) | Match the layout of loaded state   |
| **Error**     | Error icon + message + retry button            | Red accent, clear action           |
| **Success**   | Checkmark animation + confirmation text        | Green accent, celebrate the action |
| **Partial**   | Content with "load more" or pagination         | Gradual disclosure                 |
| **Offline**   | Banner or overlay explaining connectivity      | Non-blocking if possible           |
| **First use** | Onboarding hints, tooltips, coach marks        | Subtle, dismissible                |

### Micro-interactions & Polish

These details separate amateur from professional:

- **Active/selected states** use brand color tint background + brand text, not just a color swap on the icon
- **Inactive icons**: outline style in `text/tertiary`. **Active icons**: filled style in `text/brand`
- **Pressed states**: slightly darker, 1-2px downward shift or scale to 0.97
- **Dividers**: prefer spacing over lines. If lines needed, `border/subtle` at 1px
- **Skeleton screens**: match the exact layout with rounded `bg/surface-elevated` rectangles where content will load
- **Image placeholders**: use subtle gradient or brand-tint background, never gray boxes
- **Scroll indicators**: subtle shadow or blur at top/bottom edge when content is scrollable
- **Badge counts**: red dot (no number) for simple, numbered badge for specifics
- **Progressive disclosure**: show summary first, expand for details (not everything at once)
- **Thumb zone**: most important actions in bottom 2/3 of screen (reachable one-handed)

### Font Discovery & Selection

Use web search to find the right font:

```
jina_search_web("best modern sans-serif fonts for mobile app 2025")
jina_search_web("google fonts similar to SF Pro")
jina_search_images("[font name] font specimen")
```

**Safe modern font choices for Figma:**

- **Inter** — versatile, optimized for screens, free (best default choice)
- **SF Pro** — Apple system font (available on macOS)
- **Plus Jakarta Sans** — geometric, friendly, modern SaaS feel
- **Satoshi** — clean, contemporary, slightly geometric
- **Outfit** — geometric with warmth
- **Manrope** — semi-rounded, friendly
- **DM Sans** — geometric, works great for UI

Load fonts in figma_execute:

```javascript
await figma.loadFontAsync({ family: "Inter", style: "Regular" });
await figma.loadFontAsync({ family: "Inter", style: "Medium" });
await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
await figma.loadFontAsync({ family: "Inter", style: "Bold" });
```

### Image & Asset Sourcing

For placeholder photos, illustrations, and assets:

```
jina_search_images("fashion model wearing outfit studio photo")   → find reference images
jina_capture_screenshot_url("https://unsplash.com/s/photos/...")  → capture from Unsplash
```

**Use `figma_set_image_fill` with downloaded images:**

```
1. jina_read_url or jina_capture_screenshot_url → get image
2. Save to /tmp/ if needed
3. figma_set_image_fill(nodeIds, imageData, scaleMode="FILL")
```

### Design Review Checklist

After completing a screen, verify against this checklist:

1. **[ ] Visual hierarchy clear?** — Can you instantly tell what's most important?
2. **[ ] Spacing consistent?** — Does it follow the 8px grid?
3. **[ ] Touch targets adequate?** — All interactive elements ≥ 44px?
4. **[ ] Contrast passes WCAG?** — Run `figma_lint_design`
5. **[ ] No hardcoded colors?** — All colors from token system?
6. **[ ] Auto-layout used?** — No manual positioning?
7. **[ ] Component naming clear?** — No "Frame 1" or "Vector"?
8. **[ ] States covered?** — Empty, loading, error, success?
9. **[ ] Would this look good on Dribbble?** — If not, iterate.
10. **[ ] Compared to reference?** — Screenshot and compare with inspiration

---

## figma_execute Gotchas

1. **`figma.currentPage =` is BANNED** — Use `await figma.setCurrentPageAsync(page)` instead
2. **Font loading is required before text operations** — `await figma.loadFontAsync({ family, style })`
3. **Always `return` data** — The result is what you get back
4. **Timeout default is 5s, max 30s** — Set `timeout` for heavy operations
5. **Use `node.remove()` to clean up** failed artifacts
6. **`figma.createPage()` creates on document root** — no parent needed
7. **Auto-layout properties**: `layoutMode`, `primaryAxisAlignItems`, `counterAxisAlignItems`, `paddingTop/Right/Bottom/Left`, `itemSpacing`

---

## Design System Best Practices

### Color Token Naming

```
bg/primary          → main background
bg/surface          → card/container background
bg/surface-elevated → elevated surface
bg/brand            → brand-colored backgrounds
text/primary        → main text color
text/secondary      → subdued text
text/tertiary       → placeholder/hint text
text/on-brand       → text on brand backgrounds
text/brand          → brand-colored text
border/default      → standard borders
border/subtle       → light separators
accent/success      → green for success states
accent/warning      → yellow for warnings
accent/error        → red for errors
brand/gradient-start → gradient endpoints
brand/gradient-end
```

### Spacing Scale (4px base)

```
space/2   → 2px   (micro)
space/4   → 4px   (tight)
space/8   → 8px   (small)
space/12  → 12px  (compact)
space/16  → 16px  (default)
space/20  → 20px  (comfortable)
space/24  → 24px  (spacious)
space/32  → 32px  (section gap)
space/40  → 40px  (large)
space/48  → 48px  (hero)
space/64  → 64px  (max)
```

### Typography Scale

```
Display    → 36-48px Bold   (hero text)
Heading/H1 → 28-32px Bold   (page titles)
Heading/H2 → 22-24px Semibold (section titles)
Heading/H3 → 18-20px Semibold (subsections)
Body/Large → 16-18px Regular  (primary body)
Body/Base  → 14-16px Regular  (standard body)
Body/Small → 12-14px Regular  (captions)
Label      → 12px Medium      (UI labels, tabs)
Legal      → 10-11px Regular  (legal text, minimum readable)
```

### WCAG Compliance Checklist

- Normal text: minimum **4.5:1** contrast ratio
- Large text (18px+ or 14px+ bold): minimum **3:1**
- Minimum text size: **12px** (exceptions: legal at 10px)
- Line height: **1.5x** font size minimum
- Touch targets: **44x44px** minimum

---

## Performance Tips

- Response times are typically **1-3s** per tool call over WebSocket
- `figma_get_design_system_kit` is expensive — use once, cache mentally
- `figma_capture_screenshot` at scale=1 is faster than scale=2
- Batch variable operations with `figma_batch_create_variables` / `figma_batch_update_variables` (10-50x faster than individual calls)
- Use `figma_get_file_data` with `depth=1` and `verbosity="summary"` for initial exploration

---

## Example Workflow: Redesign a File

```
1. figma_get_status                          → verify connection
2. figma_get_file_data (depth=2)             → understand existing structure
3. figma_lint_design (rules: ["all"])         → audit current state
4. figma_capture_screenshot (key screens)    → visual reference
5. figma_execute → create new page           → "Redesign" page
6. figma_setup_design_tokens × 3             → Colors, Spacing, Typography
7. figma_execute → build components          → Button, Card, TabBar, etc.
8. figma_execute → compose screens           → one screen at a time
9. figma_capture_screenshot → validate       → check each screen
10. figma_lint_design → final audit          → verify improvements
```
