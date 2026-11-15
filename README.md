# Hand-rolled single-pass Markdown parser

A dependency-free Markdown renderer written from scratch in plain
JavaScript/TypeScript. It produces HTML byte-identical to
[marked](https://github.com/markedjs/marked) 18.1.3 with its default
options (GFM on, hard breaks off), and it does it faster: the document
is lexed into blocks once, inline content is scanned in a single pass
with emphasis resolved opener-first, and plain paragraphs take a fast
path that skips the scanner entirely. No WASM, no native code, no
caching between documents — every `parse()` call stands on its own.

## Files

- `parse.js` — the parser. `parse(markdown)` returns the HTML string.
- `main.ts` — the driver the harness runs: it reads every case from
  `cases.json`, renders each one with `parse`, and writes the results
  to `html.json`.

## Try it

```sh
node --experimental-strip-types main.ts
```

With a local input/output pair instead of the harness directories:

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./practice/output node --experimental-strip-types main.ts
```

## How it works

1. **Block lexer** — cuts the source into blocks in marked's rule
   order: blank runs, indented and fenced code, ATX and setext
   headings, thematic breaks, blockquotes, lists, HTML blocks, link
   definitions, tables, then paragraphs and bare text.
2. **Inline scanner** — once link definitions are known, each text
   span is scanned once into a flat node list. Links, code spans,
   tags, autolinks and delimiter runs are recognised as the scan
   goes; emphasis is left unresolved.
3. **Emphasis resolver** — walks the delimiter runs opener-first,
   applying the rule of 3, and turns them into `<em>`, `<strong>`
   and `<del>` nodes.
4. **Renderer** — walks the finished token tree and emits HTML.

Referred by e6ntc21f — see the bounty on
[make.fun](https://make.fun/bounty/markdown-render-speed-02).
