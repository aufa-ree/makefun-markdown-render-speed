# makefun-markdown-render-speed

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/aufa-ree/makefun-markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/aufa-ree/makefun-markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Hand-rolled single-pass Markdown parser written from scratch (no dependencies, no ported code) that renders byte-identical HTML to marked 18.1.3. It scans each document once with a fast path for plain paragraphs, minimal allocation, and no expensive regex on the hot path, so it renders a full case set noticeably faster than marked.

## Run it

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./practice/output node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e6ntc21f&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
