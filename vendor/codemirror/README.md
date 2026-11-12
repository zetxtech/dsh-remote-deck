# Vendored editor assets

- `lib/codemirror.min.js`, `lib/codemirror.css` — CodeMirror 5.65.16 (MIT), https://github.com/codemirror/codemirror5
- `mode/*/` — the language modes: javascript, xml, css, htmlmixed, markdown, python, shell, yaml, clike, rust, go
- `addon/edit/closebrackets.min.js`, `addon/edit/matchbrackets.min.js`, `addon/search/search.min.js`, `addon/search/searchcursor.min.js`, `addon/selection/active-line.min.js`
- `LICENSE` — the upstream license, unmodified

Every file was fetched from jsDelivr's npm mirror of `codemirror@5.65.16` and is the minified
build it generates from it, for example:

- https://cdn.jsdelivr.net/npm/codemirror@5.65.16/lib/codemirror.min.js
- https://cdn.jsdelivr.net/npm/codemirror@5.65.16/mode/javascript/javascript.min.js
- https://cdn.jsdelivr.net/npm/codemirror@5.65.16/addon/search/search.min.js

No theme stylesheet is vendored: the editor is themed with DSH's own design tokens, so only
`codemirror.css` (the structural styles) ships. These files are served by the plugin's loopback
host under `/assets/*` with an exact-name allow-list — nothing else in this directory is
reachable — and loaded on demand when the file editor opens.
