# CourtEdge — client

React 19 + Vite 7 + Tailwind CSS 4.

```bash
npm install
npm run dev      # dev server with HMR
npm run build    # production bundle -> dist/
npm run preview  # serve the built bundle
```

This used to be a single hand-written `index.html`. It is now a component tree;
`index.html` remains only as Vite's entry shell (fonts + `<div id="root">`).

## Layout

```
src/
  main.jsx              mount point
  App.jsx               view router (landing | login | dash) + shared desk state
  index.css             @theme design tokens, keyframes, component layer
  lib/
    data.js             market seed data, fair-value model, trade generator
    charts.js           canvas renderers (line/area, buckets, donut, EV bars)
  hooks/useUi.js        useCountUp, useReveal, useScrolled, useCanvas, useInterval
  components/
    common.jsx          Logo, LiveDot, CourtLines, Panel, Tag, StatusTag, ChipBtn
    Icons.jsx           inline SVG set
    Toasts.jsx          toast context + host
    Login.jsx
    landing/            Landing.jsx (header/sections/footer), Hero.jsx
    dashboard/          Dashboard.jsx (shell + live simulation), Sidebar, Topbar,
                        ConfirmModal, PageHead, pages/*
```

## Styling

Design tokens live in the `@theme` block in `src/index.css`, so they are reachable
as ordinary Tailwind utilities — `bg-panel`, `text-ace`, `font-display`,
`rounded-card`, `shadow-xl`, `animate-blink`.

The `@layer components` block holds only what utilities cannot express: masked
gradient borders, `::-webkit-slider-thumb`, scrollbar styling, and the long
table selector chains.

## Motion

Entrance-only. Nothing loops or drifts. The single exception is the ticker tape
and the hero price chart, both of which represent live data rather than
decoration.
