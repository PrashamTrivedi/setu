// Embedded chat-pane UI. Two-column layout on desktop (chat list + chat pane),
// view-switching on mobile. Cards become threads. New-chat / pair-machine /
// add-repo flows live in modals reachable from the FAB and the settings menu.
// Connects to /ws/ui with a UI bearer in localStorage; renders FeedItems
// filtered to the focused card; user redirects render optimistically as
// right-aligned bubbles. Single self-contained file shipped with the Worker.

// Markdown renderer source (browser-side). Pulled out of the indexHtml
// template via String.raw so regex backslashes survive intact instead of
// being eaten by template-literal cooking. Safe-by-construction: every
// character that ends up as HTML has gone through escape() or is a fixed tag.
// Supports: # headings, **bold**, *italic*, `code`, ```fenced```,
// - / 1. lists, > blockquotes, [text](url) links (http/https/mailto/relative),
// horizontal rules, paragraphs.
const BT = '`'
const markdownRendererSrc = String.raw`
  function renderMarkdown(src) {
    if (!src) return ''
    const SENTINEL = ''
    let text = String(src).replace(/\r\n?/g, '\n')

    const blocks = []
    text = text.replace(/` + BT + BT + BT + String.raw`([a-zA-Z0-9_+-]*)\n?([\s\S]*?)` + BT + BT + BT + String.raw`/g, (_, lang, code) => {
      const i = blocks.push({ lang, code }) - 1
      return SENTINEL + 'B' + i + SENTINEL
    })

    text = escape(text)

    const inlines = []
    text = text.replace(/` + BT + String.raw`([^` + BT + String.raw`\n]+)` + BT + String.raw`/g, (_, code) => {
      const i = inlines.push(code) - 1
      return SENTINEL + 'I' + i + SENTINEL
    })

    const lines = text.split('\n')
    const out = []
    let i = 0
    const sentBlock = new RegExp('^' + SENTINEL + 'B(\\d+)' + SENTINEL + '$')
    while (i < lines.length) {
      const line = lines[i]

      const blockM = line.match(sentBlock)
      if (blockM) {
        const b = blocks[Number(blockM[1])]
        out.push('<pre><code>' + escape(b.code.replace(/\n$/, '')) + '</code></pre>')
        i++; continue
      }

      const h = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
      if (h) {
        const lv = h[1].length
        out.push('<h' + lv + '>' + inline(h[2]) + '</h' + lv + '>')
        i++; continue
      }

      if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
        out.push('<hr/>'); i++; continue
      }

      if (/^&gt;\s?/.test(line)) {
        const buf = []
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^&gt;\s?/, '')); i++
        }
        out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>')
        continue
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++
        }
        out.push('<ul>' + items.join('') + '</ul>')
        continue
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        const items = []
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push('<li>' + inline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++
        }
        out.push('<ol>' + items.join('') + '</ol>')
        continue
      }

      if (line.trim() === '') { i++; continue }

      const buf = [line]; i++
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,6}\s|&gt;\s?|\s*[-*+]\s+|\s*\d+\.\s+)/.test(lines[i]) &&
        !sentBlock.test(lines[i])
      ) { buf.push(lines[i]); i++ }
      out.push('<p>' + inline(buf.join('\n').replace(/\n/g, '<br/>')) + '</p>')
    }

    let html = out.join('')
    html = html.replace(new RegExp(SENTINEL + 'I(\\d+)' + SENTINEL, 'g'), (_, n) =>
      '<code>' + escape(inlines[Number(n)]) + '</code>')
    return html

    function inline(s) {
      s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
        const ok = /^(https?:\/\/|mailto:|\/|#)/i.test(href)
        const safe = ok ? href : '#'
        return '<a href="' + safe + '" rel="noopener noreferrer" target="_blank">' + label + '</a>'
      })
      s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      s = s.replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      s = s.replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
      return s
    }
  }
`

export const indexHtml = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>setu · chats</title>
<style>
  :root {
    --ink: #16140f;
    --paper: #f4ecdc;
    --paper-2: #ece2cc;
    --paper-3: #e1d6bb;
    --rule: #2a2419;
    --rule-2: #c5bba2;
    --rule-3: #d8cfb8;
    --muted: #6b6353;
    --muted-2: #8a8273;
    --hl: #f7efde;
    --shell-bg: #0c0a07;
    --accent: #c8401d;
    --accent-soft: #e9b394;
    --accent-bg: #fbe8e0;
    --on-accent: #f4ecdc;
    --ok: #4d6b3a;
    --warn: #c8901d;
    --shadow: 0 1px 0 rgba(0,0,0,.06), 0 12px 40px rgba(0,0,0,.45);
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    --serif: "Iowan Old Style", "Source Serif Pro", Charter, Georgia, serif;
    color-scheme: light;
  }
  :root[data-theme="dark"], :root[data-theme="dark"] :root {
    --ink: #efe4ce;
    --paper: #1c1814;
    --paper-2: #14110d;
    --paper-3: #25201a;
    --rule: #d6c9ad;
    --rule-2: #4a4032;
    --rule-3: #2f2820;
    --muted: #9a8d75;
    --muted-2: #5b5142;
    --hl: #2a241c;
    --shell-bg: #050403;
    --accent: #e85a3a;
    --accent-soft: #6b3826;
    --accent-bg: #2a1612;
    --on-accent: #1c1814;
    --ok: #8aa66a;
    --warn: #d9a948;
    --shadow: 0 1px 0 rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.7);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #efe4ce;
      --paper: #1c1814;
      --paper-2: #14110d;
      --paper-3: #25201a;
      --rule: #d6c9ad;
      --rule-2: #4a4032;
      --rule-3: #2f2820;
      --muted: #9a8d75;
      --muted-2: #5b5142;
      --hl: #2a241c;
      --shell-bg: #050403;
      --accent: #e85a3a;
      --accent-soft: #6b3826;
      --accent-bg: #2a1612;
      --on-accent: #1c1814;
      --ok: #8aa66a;
      --warn: #d9a948;
      --shadow: 0 1px 0 rgba(0,0,0,.5), 0 12px 40px rgba(0,0,0,.7);
      color-scheme: dark;
    }
  }

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; min-height: 100%; }
  body {
    background: var(--shell-bg);
    color: var(--ink);
    font-family: var(--mono);
    /* fallback chain: vh → svh (smallest with chrome) → JS-measured visual
       viewport (--app-h, set on every visualViewport resize). The JS value
       shrinks when the soft keyboard appears so the composer stays reachable. */
    height: 100vh;
    height: 100svh;
    height: var(--app-h, 100svh);
    display: flex; flex-direction: column;
    overscroll-behavior-y: none;
    overflow: hidden;
  }

  /* ─── shell ──────────────────────────────────────────────── */
  .app {
    flex: 1 1 0;
    min-height: 0;
    width: 100%;
    background: var(--paper);
    color: var(--ink);
    display: grid;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr;
    grid-template-areas: "list";
    transition: background-color .2s ease, color .2s ease;
  }
  .app.has-pane { grid-template-areas: "pane"; }
  .app aside.list {
    grid-area: list;
    display: flex; flex-direction: column;
    min-height: 0; min-width: 0; overflow: hidden;
  }
  .app main.pane {
    grid-area: pane;
    display: none; flex-direction: column;
    min-height: 0; min-width: 0; overflow: hidden;
  }
  .app.has-pane aside.list { display: none; }
  .app.has-pane main.pane { display: flex; }

  @media (min-width: 800px) {
    body { padding: 28px 16px; background: var(--shell-bg); }
    .app, .app.has-pane {
      max-width: 1180px;
      margin: 0 auto;
      border-radius: 14px;
      box-shadow: var(--shadow);
      grid-template-columns: 380px minmax(0, 1fr);
      grid-template-areas: "list pane";
    }
    .app aside.list,
    .app.has-pane aside.list { display: flex !important; border-right: 1px solid var(--rule-3); }
    .app main.pane,
    .app.has-pane main.pane { display: flex !important; }
  }
  @media (min-width: 1100px) {
    .app { max-width: 1320px; grid-template-columns: 420px minmax(0, 1fr); }
  }

  /* ─── chat list ──────────────────────────────────────────── */
  aside.list {
    background: var(--paper);
    position: relative;
  }
  header.masthead {
    flex: 0 0 auto;
    padding: 16px 20px 12px;
    background: var(--paper);
    position: sticky; top: 0; z-index: 10;
    box-shadow: 0 1px 0 var(--rule-3);
  }
  .masthead .row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .masthead h1 {
    font-family: var(--serif); font-weight: 600; font-size: 26px;
    letter-spacing: -0.5px; margin: 0; line-height: 1.1;
  }
  .masthead h1 em { font-style: italic; font-weight: 400; color: var(--accent); }
  .masthead .iconbar {
    display: flex; gap: 4px; align-items: center;
  }
  .iconbtn {
    width: 32px; height: 32px;
    background: transparent; border: 1px solid transparent;
    color: var(--muted); cursor: pointer; padding: 0;
    border-radius: 8px; font-family: inherit; font-size: 14px;
    display: grid; place-items: center;
    transition: background .15s, color .15s, border-color .15s;
  }
  .iconbtn:hover { background: var(--paper-3); color: var(--ink); }
  .iconbtn .dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--muted-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 14%, transparent);
  }
  .iconbtn .dot.ok { background: var(--ok); }
  .iconbtn .dot.bad { background: var(--accent); }
  .meta {
    font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
    color: var(--muted); margin-top: 6px;
  }
  .filterbar {
    margin-top: 10px;
    display: flex; gap: 6px; flex-wrap: wrap;
  }
  .pill {
    font-family: var(--mono); font-size: 10.5px;
    color: var(--muted); border: 1px solid var(--rule-2);
    background: transparent; padding: 4px 10px; border-radius: 999px;
    cursor: pointer; letter-spacing: .04em;
    transition: all .15s ease;
  }
  .pill:hover { border-color: var(--ink); color: var(--ink); }
  .pill.on { color: var(--paper); background: var(--ink); border-color: var(--ink); }
  .pill .count { opacity: .7; margin-left: 4px; }

  .chats {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 6px 0 100px;
    scrollbar-width: thin;
  }
  .chats .empty {
    margin: 80px 24px 0; text-align: center; color: var(--muted);
    font-family: var(--serif); font-style: italic; font-size: 16px;
    line-height: 1.6;
  }
  .chats .empty button {
    display: inline-block;
    margin-top: 14px;
    background: var(--ink); color: var(--paper); border: none;
    font-family: var(--mono); font-size: 12px; letter-spacing: .06em;
    padding: 10px 18px; border-radius: 999px; cursor: pointer;
  }

  .section-h {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .22em;
    text-transform: uppercase; color: var(--muted);
    padding: 14px 18px 4px; display: flex; justify-content: space-between;
    align-items: baseline;
  }
  .section-h.flag { color: var(--accent); }
  .section-h .add-link {
    background: transparent; border: none; padding: 0;
    font-family: var(--mono); font-size: 10.5px; color: var(--accent);
    cursor: pointer; text-transform: none; letter-spacing: .04em;
  }
  .section-h .add-link:hover { text-decoration: underline; }

  .chat-row {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr) auto;
    gap: 10px;
    align-items: start;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule-3);
    cursor: pointer;
    transition: background .15s;
    position: relative;
  }
  .chat-row:hover { background: var(--hl); }
  .chat-row.focused { background: var(--hl); box-shadow: inset 3px 0 0 var(--accent); }
  .chat-row.flag { background: color-mix(in srgb, var(--accent-bg) 50%, transparent); }
  .chat-row .sigil {
    width: 32px; height: 32px;
    border: 1px solid var(--ink);
    display: grid; place-items: center;
    font-family: var(--serif); font-style: italic; font-weight: 600;
    font-size: 14px; color: var(--ink); background: var(--paper);
    margin-top: 2px;
  }
  .chat-row .sigil.work { border-radius: 50%; }
  .chat-row .sigil.ops { border-radius: 0; }
  .chat-row .head {
    display: flex; align-items: baseline; gap: 6px;
    font-size: 11.5px; color: var(--ink);
    flex-wrap: wrap;
  }
  .chat-row .head b { font-weight: 700; letter-spacing: .04em; }
  .chat-row .head .branch { color: var(--muted); font-size: 11px; }
  .chat-row .preview {
    font-family: var(--serif); font-size: 13.5px; line-height: 1.4;
    color: var(--ink); margin-top: 3px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .chat-row .preview em { color: var(--muted); }
  .chat-row .preview .dispatch-from { font-family: var(--mono); font-size: 10.5px; color: var(--muted); letter-spacing: .04em; margin-right: 4px; text-transform: uppercase; }
  .chat-row .meta-r {
    text-align: right; color: var(--muted);
    font-size: 10px; line-height: 1.5;
    font-variant-numeric: tabular-nums; flex-shrink: 0;
  }
  .chat-row .meta-r .badge {
    display: inline-block; min-width: 16px; padding: 1px 6px;
    background: var(--accent); color: var(--on-accent);
    border-radius: 999px; font-family: var(--mono); font-size: 10px;
    font-weight: 700; margin-top: 4px;
  }
  .chat-row .meta-r .dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    margin-left: 4px; vertical-align: 1px;
  }
  .chat-row .meta-r .dot.warn { background: var(--accent); }
  .chat-row .meta-r .dot.ok { background: var(--ok); }
  .chat-row .meta-r .dot.idle { background: var(--muted-2); }
  .chat-row .meta-r .flag {
    display: inline-block; color: var(--accent); font-weight: 700; font-size: 11px;
  }

  /* ─── machine roster strip ───────────────────────────────── */
  .fleet-strip {
    display: flex; gap: 8px;
    padding: 10px 16px 10px;
    overflow-x: auto;
    border-bottom: 1px solid var(--rule-3);
    background: var(--paper-2);
    scrollbar-width: thin;
  }
  .fleet-card {
    flex: 0 0 auto;
    border: 1px solid var(--rule-2);
    background: var(--paper);
    border-radius: 8px;
    padding: 6px 10px;
    min-width: 130px;
    cursor: pointer;
    transition: border-color .15s, transform .12s;
  }
  .fleet-card:hover { border-color: var(--ink); transform: translateY(-1px); }
  .fleet-card .machine {
    font-family: var(--mono); font-size: 11px;
    color: var(--ink); font-weight: 700; letter-spacing: .04em;
  }
  .fleet-card .sub {
    font-size: 10px; color: var(--muted); margin-top: 2px;
  }
  .fleet-card .sub .dot {
    display: inline-block; width: 5px; height: 5px;
    border-radius: 50%; margin-right: 4px; vertical-align: 1px;
    background: var(--ok);
  }
  .fleet-card.add {
    border-style: dashed; color: var(--accent);
    display: flex; align-items: center; justify-content: center;
    font-family: var(--serif); font-style: italic; font-size: 13px;
    border-color: var(--accent);
  }

  /* ─── FAB (new chat) ─────────────────────────────────────── */
  .fab {
    position: fixed;
    bottom: 24px; left: 24px;
    width: 56px; height: 56px;
    border-radius: 28px;
    background: var(--ink);
    color: var(--paper);
    display: grid; place-items: center;
    font-family: var(--serif); font-size: 28px; line-height: 1;
    box-shadow: 0 8px 24px -6px rgba(0,0,0,.5);
    cursor: pointer;
    border: none;
    z-index: 4;
    transition: transform .15s, box-shadow .15s;
  }
  .fab:hover { transform: translateY(-1px); box-shadow: 0 12px 30px -6px rgba(0,0,0,.55); }
  .fab span { margin-top: -3px; }
  @media (min-width: 800px) {
    .fab {
      position: absolute; left: auto; right: 18px; bottom: 18px;
      width: 48px; height: 48px; font-size: 24px;
    }
  }

  /* ─── chat pane ──────────────────────────────────────────── */
  main.pane {
    background: var(--paper);
  }
  .pane-head {
    flex: 0 0 auto;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule-3);
    background: var(--paper);
    display: flex; align-items: center; gap: 10px;
    position: sticky; top: 0; z-index: 8;
  }
  .pane-head .back {
    width: 32px; height: 32px;
    background: transparent; border: none; cursor: pointer;
    color: var(--ink); font-size: 22px;
    display: grid; place-items: center; padding: 0;
    border-radius: 8px;
  }
  .pane-head .back:hover { background: var(--paper-3); }
  @media (min-width: 800px) {
    .pane-head .back { display: none; }
  }
  .pane-head .title {
    flex: 1 1 auto; min-width: 0;
    font-family: var(--serif); font-size: 16px; font-weight: 600;
    line-height: 1.15;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-head .title small {
    display: block;
    font-family: var(--mono); font-size: 10px; letter-spacing: .12em;
    color: var(--muted); text-transform: uppercase; margin-top: 1px;
    font-weight: 400;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pane-head .more {
    background: transparent; border: none; cursor: pointer;
    color: var(--ink); font-size: 18px;
    width: 32px; height: 32px; padding: 0;
    border-radius: 8px;
    display: grid; place-items: center;
  }
  .pane-head .more:hover { background: var(--paper-3); }

  .pane-empty {
    flex: 1 1 auto;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 40px 32px;
    color: var(--muted);
    font-family: var(--serif); font-style: italic; font-size: 16px;
    text-align: center; line-height: 1.6;
  }
  .pane-empty .glyph {
    font-family: var(--serif); font-size: 56px; color: var(--rule-2);
    margin-bottom: 12px; line-height: 1;
  }

  .thread {
    flex: 1 1 0;
    min-height: 0;
    overflow-y: auto;
    padding: 14px 16px 20px;
    scrollbar-width: thin;
    background: var(--paper);
  }
  .day {
    text-align: center; color: var(--muted); font-size: 9.5px;
    letter-spacing: .32em; margin: 16px 0 10px; opacity: 0.7;
  }

  /* bubbles */
  .bubble {
    max-width: 82%;
    margin: 0 auto 12px 0;
    background: var(--paper-2);
    border: 1px solid var(--rule-2);
    border-radius: 4px 14px 14px 14px;
    padding: 10px 12px 8px;
    box-shadow: 0 1px 0 rgba(0,0,0,.03);
    position: relative;
  }
  .bubble .byline {
    display: flex; align-items: center; gap: 6px;
    font-family: var(--mono); font-size: 10px;
    color: var(--muted); letter-spacing: .08em; text-transform: uppercase;
    margin-bottom: 5px; flex-wrap: wrap;
  }
  .bubble .byline b { color: var(--ink); font-weight: 700; }
  .bubble .byline .ts { margin-left: auto; font-variant-numeric: tabular-nums; }
  .bubble .byline .sigil {
    width: 16px; height: 16px;
    border: 1px solid var(--ink);
    display: inline-grid; place-items: center;
    font-family: var(--serif); font-style: italic; font-weight: 600;
    font-size: 10px; color: var(--ink); background: var(--paper);
  }
  .bubble .byline .sigil.work { border-radius: 50%; }
  .bubble .byline .kind {
    font-size: 9px; letter-spacing: .14em; text-transform: uppercase;
    border: 1px solid var(--muted); padding: 1px 6px; border-radius: 999px;
  }
  .bubble .byline .kind.asking { color: var(--accent); border-color: var(--accent); }
  .bubble .byline .kind.committing { color: var(--warn); border-color: var(--warn); }
  .bubble .body {
    font-family: var(--serif); font-size: 14.5px; line-height: 1.45;
    color: var(--ink); margin: 0; word-break: break-word;
  }
  .bubble .body.plain { white-space: pre-wrap; }
  .bubble .body em { color: var(--muted); }
  .bubble .body p { margin: 0 0 8px; }
  .bubble .body p:last-child { margin-bottom: 0; }
  .bubble .body h1, .bubble .body h2, .bubble .body h3,
  .bubble .body h4, .bubble .body h5, .bubble .body h6 {
    font-family: var(--serif); font-weight: 700; color: var(--ink);
    margin: 12px 0 4px; line-height: 1.2;
  }
  .bubble .body h1 { font-size: 18px; }
  .bubble .body h2 { font-size: 16px; }
  .bubble .body h3 { font-size: 15px; }
  .bubble .body h4, .bubble .body h5, .bubble .body h6 { font-size: 14px; }
  .bubble .body :first-child { margin-top: 0; }
  .bubble .body :last-child { margin-bottom: 0; }
  .bubble .body ul, .bubble .body ol {
    margin: 4px 0 8px; padding-left: 22px;
  }
  .bubble .body li { margin: 2px 0; }
  .bubble .body li > p { margin: 0; }
  .bubble .body blockquote {
    margin: 6px 0; padding: 2px 0 2px 10px;
    border-left: 2px solid var(--rule-2); color: var(--muted);
  }
  .bubble .body code {
    font-family: var(--mono); font-size: 12.5px;
    background: color-mix(in srgb, var(--ink) 7%, transparent);
    border: 1px solid var(--rule-3); border-radius: 4px;
    padding: 0 4px;
  }
  .bubble .body pre {
    font-family: var(--mono); font-size: 12.5px; line-height: 1.45;
    background: color-mix(in srgb, var(--ink) 6%, var(--paper));
    border: 1px solid var(--rule-3); border-radius: 6px;
    padding: 8px 10px; margin: 6px 0;
    overflow-x: auto; white-space: pre;
  }
  .bubble .body pre code {
    background: transparent; border: 0; padding: 0; border-radius: 0;
  }
  .bubble .body a {
    color: var(--accent); text-decoration: underline;
    text-decoration-thickness: 1px; text-underline-offset: 2px;
  }
  .bubble .body a:hover { text-decoration-thickness: 2px; }
  .bubble .body strong { color: var(--ink); }
  .bubble .body hr { border: 0; border-top: 1px dashed var(--rule-2); margin: 10px 0; }
  .bubble.committing {
    border-left: 3px solid var(--accent);
    background: color-mix(in srgb, var(--accent-bg) 22%, var(--paper-2));
  }
  .bubble.peer {
    background: color-mix(in srgb, var(--warn) 8%, var(--paper-2));
    border-color: color-mix(in srgb, var(--warn) 35%, var(--rule-2));
  }
  .bubble .footers {
    margin-top: 6px;
    display: flex; gap: 6px; flex-wrap: wrap;
    font-family: var(--mono); font-size: 9.5px; color: var(--muted);
  }
  .bubble .footers .pill {
    border: 1px solid var(--rule-2); padding: 1px 7px; border-radius: 999px;
    letter-spacing: .04em; font-size: 9.5px;
  }
  .bubble .footers .pill.cross { color: var(--accent); border-color: var(--accent); }
  .bubble .footers .pill.deadline { color: var(--warn); border-color: var(--warn); }
  .bubble .footers .pill.resolved { color: var(--ok); border-color: var(--ok); }

  /* user (right-aligned) */
  .me {
    max-width: 78%;
    margin: 0 0 12px auto;
    background: var(--ink);
    color: var(--paper);
    border-radius: 14px 4px 14px 14px;
    padding: 9px 12px;
    font-family: var(--serif); font-size: 14.5px; line-height: 1.4;
    white-space: pre-wrap; word-break: break-word;
  }
  .me.pending { opacity: 0.7; }
  .me.failed { opacity: 0.85; outline: 1px solid var(--warn); }
  .me .ts {
    display: block;
    font-family: var(--mono); font-size: 9.5px;
    color: color-mix(in srgb, var(--paper) 65%, transparent);
    letter-spacing: .1em; margin-top: 4px; text-align: right;
  }
  .me .progress {
    display: block;
    height: 2px;
    margin-top: 6px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--paper) 18%, transparent);
    overflow: hidden;
    position: relative;
  }
  .me .progress::after {
    content: '';
    position: absolute;
    top: 0; left: -40%;
    width: 40%; height: 100%;
    background: color-mix(in srgb, var(--paper) 75%, transparent);
    border-radius: 2px;
    animation: meprog 1.1s ease-in-out infinite;
  }
  @keyframes meprog {
    0%   { left: -40%; }
    100% { left: 100%; }
  }

  /* state line + tool call */
  .state-line {
    padding: 6px 4px; font-size: 10.5px; color: var(--muted);
    border-top: 1px dotted var(--rule-3);
    border-bottom: 1px dotted var(--rule-3);
    margin: 8px 0;
    display: flex; gap: 8px; align-items: center; justify-content: center;
    font-family: var(--mono); letter-spacing: .04em;
  }
  .state-line .arrow { color: var(--ink); }

  /* inline decision strip */
  .decision {
    margin: 8px 0 14px;
    background: var(--paper);
    border: 1px solid var(--rule-2);
    border-left: 3px solid var(--accent);
    padding: 12px 12px 10px; border-radius: 8px;
    box-shadow: 0 2px 12px -6px rgba(0,0,0,.18);
  }
  .decision .label {
    font-size: 9px; letter-spacing: .2em; text-transform: uppercase;
    color: var(--accent); font-weight: 700; margin-bottom: 6px;
  }
  .decision .what {
    font-family: var(--serif); font-size: 14.5px; line-height: 1.4;
    margin: 0 0 4px;
  }
  .decision .ctx {
    font-size: 11px; color: var(--muted); margin: 0 0 10px;
    line-height: 1.55; word-break: break-word;
  }
  .decision .actions {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  }
  .btn {
    border: none; cursor: pointer;
    font-family: var(--mono); font-size: 11.5px; letter-spacing: .04em;
    padding: 7px 12px; border-radius: 6px; color: var(--paper);
    transition: transform .12s, box-shadow .15s;
  }
  .btn:hover { transform: translateY(-1px); }
  .btn.allow { background: var(--ink); }
  .btn.deny  { background: transparent; color: var(--ink); border: 1px solid var(--ink); }
  .btn.ghost { background: transparent; color: var(--muted); border: 1px dashed var(--muted-2); }
  .btn.ghost:hover { color: var(--ink); border-color: var(--ink); border-style: solid; }
  .btn:disabled { opacity: 0.5; cursor: default; transform: none; }

  /* composer */
  .composer {
    flex: 0 0 auto;
    border-top: 1px solid var(--rule-3);
    background: var(--paper-2);
    padding: 10px 14px 16px;
  }
  .composer .pending-banner {
    background: var(--accent); color: var(--on-accent);
    padding: 9px 12px; border-radius: 8px; margin-bottom: 8px;
    font-family: var(--serif); font-size: 13px; line-height: 1.4;
    box-shadow: 0 4px 14px -8px var(--accent);
  }
  .composer .pending-banner .label {
    font-family: var(--mono); font-size: 9px; letter-spacing: .18em;
    text-transform: uppercase; opacity: 0.85; margin-bottom: 2px;
  }
  .composer .tmux-notice {
    position: relative;
    background: color-mix(in srgb, var(--paper) 60%, transparent);
    border: 1px dashed var(--muted-2); border-radius: 8px;
    padding: 8px 28px 8px 11px; margin-bottom: 8px;
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
    line-height: 1.55;
  }
  .composer .tmux-notice .dismiss {
    position: absolute; top: 4px; right: 6px;
    background: transparent; border: none; color: var(--muted);
    font: inherit; font-size: 14px; line-height: 1; cursor: pointer;
    padding: 2px 6px; border-radius: 4px;
  }
  .composer .tmux-notice .dismiss:hover { color: var(--ink); background: var(--paper-3); }
  .composer .tmux-notice b { color: var(--ink); font-weight: 700; }
  .composer .tmux-notice kbd {
    background: var(--paper-3); border: 1px solid var(--ink); padding: 1px 5px;
    border-radius: 4px; font-family: var(--mono); font-size: 10px; color: var(--ink);
    box-shadow: 0 1px 0 var(--ink);
  }
  .composer .input-row {
    display: flex; gap: 10px; align-items: flex-end;
  }
  .composer textarea {
    flex: 1 1 auto;
    resize: none;
    font-family: var(--serif); font-size: 14.5px; line-height: 1.45;
    color: var(--ink); background: var(--paper);
    border: 1px solid var(--rule-2); border-radius: 18px;
    padding: 10px 14px;
    min-height: 40px; max-height: 160px;
    transition: border-color .15s, box-shadow .15s;
  }
  .composer textarea:focus {
    outline: none; border-color: var(--ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent);
  }
  .composer textarea:disabled { background: var(--paper-2); color: var(--muted); }
  .composer .send {
    width: 40px; height: 40px;
    background: var(--ink); color: var(--paper);
    border: none; border-radius: 50%; cursor: pointer;
    font-family: var(--serif); font-size: 18px;
    box-shadow: 0 4px 12px -6px rgba(0,0,0,.4);
    transition: transform .12s, background .15s, box-shadow .15s;
    flex: 0 0 auto;
  }
  .composer .send:hover:not(:disabled) { transform: translateY(-1px); }
  .composer .send:disabled { background: var(--muted-2); cursor: default; box-shadow: none; }
  .composer .hint {
    font-family: var(--mono); font-size: 9.5px; color: var(--muted);
    letter-spacing: .04em; text-align: right; margin-top: 4px;
    padding-right: 50px;
  }

  /* ─── modals ─────────────────────────────────────────────── */
  .modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(8,6,4,.55);
    backdrop-filter: blur(6px);
    display: grid; place-items: end center;
    z-index: 80;
    animation: fadeIn .15s ease;
  }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  .modal {
    width: 100%; max-width: 560px;
    min-width: 0;
    background: var(--paper);
    color: var(--ink);
    border-radius: 18px 18px 0 0;
    box-shadow: 0 -16px 60px rgba(0,0,0,.5);
    max-height: 88vh;
    display: flex; flex-direction: column;
    border: 1px solid var(--rule-2);
    border-bottom: none;
    animation: slideUp .2s ease;
  }
  @keyframes slideUp { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @media (min-width: 800px) {
    .modal-backdrop { place-items: center; }
    .modal { border-radius: 18px; border-bottom: 1px solid var(--rule-2); max-height: 80vh; }
  }
  .modal .grip {
    width: 44px; height: 4px; background: var(--rule-2);
    border-radius: 2px; margin: 8px auto 4px;
  }
  @media (min-width: 800px) { .modal .grip { display: none; } }
  .modal-head {
    padding: 12px 22px 10px;
    display: flex; justify-content: space-between; align-items: baseline; gap: 8px;
    border-bottom: 1px solid var(--rule-3);
  }
  .modal-head h3 {
    font-family: var(--serif); font-weight: 600; font-size: 22px;
    margin: 0; letter-spacing: -.2px;
  }
  .modal-head h3 em { color: var(--accent); font-style: italic; font-weight: 400; }
  .modal-head .x {
    background: transparent; border: none; cursor: pointer;
    color: var(--muted); font-size: 22px; line-height: 1;
    width: 32px; height: 32px; padding: 0; border-radius: 8px;
    display: grid; place-items: center;
  }
  .modal-head .x:hover { background: var(--paper-3); color: var(--ink); }
  .modal-body {
    padding: 16px 22px 24px;
    overflow-y: auto;
    flex: 1 1 auto;
  }
  .modal-body p.lede {
    color: var(--muted); font-size: 12.5px; line-height: 1.55;
    margin: 0 0 14px;
  }

  .field-label {
    font-family: var(--mono); font-size: 9.5px; color: var(--muted);
    letter-spacing: .18em; text-transform: uppercase;
    margin: 14px 0 6px;
  }
  .field-label .hint {
    text-transform: none; letter-spacing: .04em;
    color: var(--muted-2); font-size: 10px; margin-left: 6px;
  }
  .modal-body input,
  .modal-body textarea,
  .modal-body select {
    width: 100%;
    font-family: var(--mono); font-size: 12.5px; color: var(--ink);
    background: var(--paper); border: 1px solid var(--rule-2);
    border-radius: 8px; padding: 9px 12px;
    transition: border-color .15s, box-shadow .15s;
  }
  .modal-body textarea {
    font-family: var(--serif); font-size: 14px; line-height: 1.45;
    min-height: 80px; resize: vertical;
  }
  .modal-body input:focus,
  .modal-body textarea:focus,
  .modal-body select:focus {
    outline: none; border-color: var(--ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent);
  }
  .modal-body select {
    -webkit-appearance: none; -moz-appearance: none; appearance: none;
    padding-right: 28px;
    background-image: linear-gradient(45deg, transparent 50%, currentColor 50%),
                      linear-gradient(135deg, currentColor 50%, transparent 50%);
    background-position: calc(100% - 14px) 14px, calc(100% - 9px) 14px;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
    cursor: pointer;
  }
  .picker {
    display: flex; gap: 8px; overflow-x: auto;
    padding-bottom: 4px;
    scrollbar-width: thin;
  }
  .picker .opt {
    flex: 0 0 auto;
    border: 1px solid var(--rule-2);
    background: var(--paper);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer; min-width: 130px;
    font-family: var(--mono); font-size: 11.5px; color: var(--ink);
    transition: border-color .15s, background .15s, transform .12s;
    text-align: left;
  }
  .picker .opt:hover { border-color: var(--ink); transform: translateY(-1px); }
  .picker .opt b { display: block; font-weight: 700; letter-spacing: .04em; }
  .picker .opt small {
    display: block; font-family: var(--mono); font-size: 10px;
    color: var(--muted); margin-top: 2px; font-weight: 400;
  }
  .picker .opt.active {
    border-color: var(--ink); background: var(--paper-3);
    box-shadow: inset 3px 0 0 var(--accent);
  }
  .picker .opt.add {
    border-style: dashed; color: var(--accent); border-color: var(--accent);
    font-family: var(--serif); font-style: italic; font-size: 13px;
    display: flex; align-items: center; justify-content: center;
  }

  .start-row {
    margin-top: 18px;
    display: flex; gap: 10px; align-items: center;
  }
  .start-row .btn-big {
    flex: 1 1 auto;
    background: var(--ink); color: var(--paper);
    border: none; border-radius: 8px;
    padding: 12px;
    font-family: var(--mono); font-size: 13px; letter-spacing: .06em;
    cursor: pointer;
    transition: transform .12s, box-shadow .15s;
  }
  .start-row .btn-big:hover { transform: translateY(-1px); box-shadow: 0 4px 14px -6px rgba(0,0,0,.4); }
  .start-row .btn-big:disabled { opacity: 0.5; cursor: default; }

  .step {
    border-top: 1px dashed var(--rule-2);
    padding: 14px 0 4px;
    display: grid; grid-template-columns: 26px minmax(0, 1fr);
    gap: 12px;
  }
  .step > *:nth-child(2) { min-width: 0; }
  .step:first-child { border-top: none; padding-top: 4px; }
  .step .n {
    width: 22px; height: 22px;
    border-radius: 50%;
    background: var(--ink); color: var(--paper);
    font-family: var(--mono); font-size: 12px;
    display: grid; place-items: center;
    margin-top: 1px;
  }
  .step .what {
    font-family: var(--serif); font-size: 14px; line-height: 1.45;
    color: var(--ink); margin: 0 0 6px;
  }
  .step .what em { color: var(--muted); }
  .step .what code, .modal-body code {
    font-family: var(--mono); font-size: 11.5px;
    background: var(--paper-3); border: 1px solid var(--rule-2);
    padding: 0 5px; border-radius: 3px; color: var(--ink);
  }

  .codeblock {
    background: #1a160e;
    color: #f4ecdc;
    border-radius: 8px;
    padding: 10px 12px;
    font-family: var(--mono); font-size: 11.5px; line-height: 1.55;
    overflow-x: auto;
    position: relative;
    margin: 6px 0 4px;
  }
  :root[data-theme="dark"] .codeblock { background: #050403; border: 1px solid var(--rule-3); }
  .codeblock .copy-btn {
    position: absolute; top: 6px; right: 6px;
    font-family: var(--mono); font-size: 9px; letter-spacing: .12em;
    background: transparent; border: 1px solid #5a4f38; color: #d6c89f;
    padding: 2px 6px; border-radius: 3px; cursor: pointer;
    text-transform: uppercase;
  }
  .codeblock .copy-btn:hover { background: #2a2218; color: #f4ecdc; }
  .codeblock .c1 { color: #d6c89f; }
  .codeblock .c2 { color: #e9b394; }
  .codeblock .c3 { color: #8a8273; }

  .listing {
    border: 1px solid var(--rule-2);
    border-radius: 8px; overflow: hidden;
    margin-top: 8px;
  }
  .listing .row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px;
    border-top: 1px solid var(--rule-3);
    background: var(--paper);
  }
  .listing .row:first-child { border-top: none; }
  .listing .row.ok { background: color-mix(in srgb, var(--ok) 8%, var(--paper)); }
  .listing .row .glyph {
    width: 22px; height: 22px;
    border-radius: 4px; border: 1px solid var(--ink);
    display: grid; place-items: center;
    font-family: var(--serif); font-size: 12px;
  }
  .listing .row .glyph.ok { background: var(--ok); color: #f4ecdc; border-color: var(--ok); }
  .listing .row .col { flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .listing .row .name {
    font-family: var(--mono); font-size: 11.5px;
    font-weight: 700; color: var(--ink); letter-spacing: .04em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .listing .row .path {
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    margin-top: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .listing .row .meta-r {
    font-size: 10px; color: var(--muted); text-align: right;
    letter-spacing: .04em; flex-shrink: 0;
  }
  .listing .row .meta-r.ok { color: var(--ok); }
  .listing .row .meta-r.warn { color: var(--accent); }

  .pair-card {
    border: 1px solid var(--rule-2);
    background: color-mix(in srgb, var(--warn) 12%, var(--paper));
    border-radius: 8px;
    padding: 12px 14px 10px;
    margin-top: 10px; text-align: center;
  }
  .pair-card .pin-hint {
    font-size: 10px; color: var(--muted); letter-spacing: .12em;
    text-transform: uppercase;
  }
  .pair-card .pin {
    font-family: var(--mono); font-size: 26px; letter-spacing: .25em;
    color: var(--ink); font-weight: 700; padding: 4px 0;
  }

  .footnote {
    font-family: var(--serif); font-size: 12px; color: var(--muted);
    line-height: 1.55; margin-top: 14px;
    padding-top: 10px; border-top: 1px dashed var(--rule-2);
  }
  .footnote b { color: var(--ink); font-weight: 600; }

  /* settings menu */
  .menu {
    position: fixed; z-index: 70;
    background: var(--paper);
    border: 1px solid var(--rule-2);
    border-radius: 10px;
    box-shadow: 0 12px 40px -8px rgba(0,0,0,.45);
    min-width: 220px;
    padding: 6px;
    animation: slideUp .12s ease;
  }
  .menu button {
    display: flex; align-items: center; gap: 8px;
    width: 100%; text-align: left;
    padding: 8px 12px;
    background: transparent; border: none; cursor: pointer;
    font-family: var(--mono); font-size: 12px; color: var(--ink);
    border-radius: 6px;
  }
  .menu button:hover { background: var(--paper-3); }
  .menu .sep { height: 1px; background: var(--rule-3); margin: 4px 0; }
  .menu .gly {
    width: 18px; text-align: center;
    font-family: var(--serif); color: var(--muted);
  }

  /* ─── auth gate ──────────────────────────────────────────── */
  .gate {
    position: fixed; inset: 0;
    background: rgba(8, 6, 4, 0.55);
    backdrop-filter: blur(6px);
    display: grid; place-items: center; z-index: 100;
  }
  .gate .box {
    background: var(--paper); color: var(--ink);
    padding: 26px 28px; border-radius: 14px;
    max-width: 360px; width: 90%;
    border: 1px solid var(--rule-2);
    box-shadow: 0 24px 60px -20px rgba(0,0,0,.55);
  }
  .gate h2 {
    font-family: var(--serif); font-size: 24px; margin: 0 0 8px;
    letter-spacing: -0.3px;
  }
  .gate p {
    font-size: 12.5px; color: var(--muted); margin: 0 0 16px;
    line-height: 1.55;
  }
  .gate input {
    width: 100%; font-family: var(--mono); font-size: 13px;
    padding: 10px 12px; border: 1px solid var(--rule-2); border-radius: 8px;
    background: var(--paper-3); color: var(--ink);
    transition: border-color .15s, box-shadow .15s;
  }
  .gate input:focus {
    outline: none; border-color: var(--ink);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink) 12%, transparent);
  }
  .gate .row { display: flex; gap: 8px; margin-top: 12px; }
  .gate button {
    background: var(--ink); color: var(--paper); border: none;
    font-family: var(--mono); font-size: 12px;
    padding: 10px 16px; border-radius: 8px; cursor: pointer;
    letter-spacing: .06em;
  }
  .gate button.ghost { background: transparent; color: var(--muted); border: 1px dashed var(--muted-2); }
  .gate button.ghost:hover { color: var(--ink); border-color: var(--ink); border-style: solid; }

  /* toast */
  .toast {
    position: fixed; bottom: 24px; left: 50%;
    transform: translate(-50%, 4px);
    background: var(--ink); color: var(--paper);
    padding: 10px 18px; border-radius: 999px;
    font-family: var(--mono); font-size: 12px; letter-spacing: .04em;
    z-index: 200;
    box-shadow: 0 12px 32px -8px rgba(0,0,0,.55);
    opacity: 0; pointer-events: none;
    transition: opacity .2s, transform .2s;
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }

  /* scrollbar polish */
  .chats::-webkit-scrollbar,
  .thread::-webkit-scrollbar,
  .modal-body::-webkit-scrollbar { width: 6px; }
  .chats::-webkit-scrollbar-thumb,
  .thread::-webkit-scrollbar-thumb,
  .modal-body::-webkit-scrollbar-thumb { background: var(--rule-2); border-radius: 3px; }
  .fleet-strip::-webkit-scrollbar,
  .picker::-webkit-scrollbar,
  .codeblock::-webkit-scrollbar { height: 4px; }
  .fleet-strip::-webkit-scrollbar-thumb,
  .picker::-webkit-scrollbar-thumb { background: var(--rule-2); border-radius: 2px; }

  @media (max-width: 380px) {
    header.masthead { padding: 12px 14px 8px; }
    .masthead h1 { font-size: 22px; }
    .chat-row { padding: 10px 12px; }
    .pane-head { padding: 10px 12px; }
    .composer { padding: 8px 12px 12px; }
  }
</style>
</head>
<body>
<div class="app" id="app">
  <aside class="list" id="list-pane">
    <header class="masthead">
      <div class="row">
        <h1>setu <em>·</em> chats</h1>
        <div class="iconbar">
          <button class="iconbtn" id="conn-btn" title="connection">
            <span class="dot" id="conn-dot"></span>
          </button>
          <button class="iconbtn" id="theme-toggle" title="toggle theme">☼</button>
          <button class="iconbtn" id="settings" title="settings">⋯</button>
        </div>
      </div>
      <div class="meta" id="meta">connecting…</div>
      <div class="filterbar" id="filterbar">
        <button class="pill on" data-filter="all">all <span class="count" id="c-all">0</span></button>
        <button class="pill" data-filter="flag">flagged <span class="count" id="c-flag">0</span></button>
        <button class="pill" data-filter="live">live <span class="count" id="c-live">0</span></button>
        <button class="pill" data-filter="idle">idle <span class="count" id="c-idle">0</span></button>
      </div>
    </header>
    <div class="fleet-strip" id="fleet-strip"></div>
    <div class="chats" id="chats">
      <div class="empty" id="chats-empty">
        No chats yet. Pair a machine and start your first session.
        <br/>
        <button id="empty-new">＋ new chat</button>
      </div>
    </div>
    <button class="fab" id="fab" title="new chat" aria-label="new chat"><span>+</span></button>
  </aside>

  <main class="pane" id="pane">
    <div class="pane-head">
      <button class="back" id="pane-back" aria-label="back to chats">‹</button>
      <div class="title" id="pane-title">no chat selected<small id="pane-sub">tap a chat from the list</small></div>
      <button class="more" id="pane-more" title="thread actions">⋯</button>
    </div>
    <div class="thread" id="thread">
      <div class="pane-empty" id="pane-empty">
        <div class="glyph">✎</div>
        <div>Pick a chat from the list to read its thread, or start a new one.</div>
      </div>
    </div>
    <div class="composer" id="composer" style="display:none;">
      <div class="input-row">
        <textarea id="composer-input" placeholder="reply to this chat…" rows="1"></textarea>
        <button class="send" id="send" title="send" disabled>↑</button>
      </div>
      <div class="hint">⏎ to send · shift+⏎ for newline</div>
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>

<div class="gate" id="gate" style="display:none;">
  <div class="box">
    <h2>connect</h2>
    <p>paste your <code>UI_BEARER</code>. it's stored in this browser only and used to authenticate the websocket.</p>
    <input id="bearer-input" type="password" placeholder="UI_BEARER" autocomplete="off" />
    <div class="row">
      <button id="bearer-save">connect</button>
      <button class="ghost" id="bearer-help">where is this?</button>
    </div>
  </div>
</div>

<script type="module">
  // ─── Constants ─────────────────────────────────────────────────────────
  const LS_BEARER = 'setu.ui_bearer'
  const LS_CLIENT = 'setu.client_id'
  const LS_SUBS = 'setu.subscriptions'
  const LS_THEME = 'setu.theme'
  const LS_FILTER = 'setu.filter'
  const LS_TMUX_DISMISSED = 'setu.tmux_notice_dismissed'

  // ─── DOM ───────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id)
  const dom = {
    app: $('app'),
    list: $('list-pane'),
    pane: $('pane'),
    chats: $('chats'),
    chatsEmpty: $('chats-empty'),
    emptyNew: $('empty-new'),
    fleet: $('fleet-strip'),
    meta: $('meta'),
    filterbar: $('filterbar'),
    cAll: $('c-all'),
    cFlag: $('c-flag'),
    cLive: $('c-live'),
    cIdle: $('c-idle'),
    paneTitle: $('pane-title'),
    paneSub: $('pane-sub'),
    paneBack: $('pane-back'),
    paneMore: $('pane-more'),
    paneEmpty: $('pane-empty'),
    thread: $('thread'),
    composer: $('composer'),
    composerInput: $('composer-input'),
    send: $('send'),
    toast: $('toast'),
    fab: $('fab'),
    connBtn: $('conn-btn'),
    connDot: $('conn-dot'),
    settings: $('settings'),
    themeToggle: $('theme-toggle'),
    gate: $('gate'),
    bearerInput: $('bearer-input'),
    bearerSave: $('bearer-save'),
    bearerHelp: $('bearer-help'),
  }

  // ─── Theme ─────────────────────────────────────────────────────────────
  const themeOrder = ['auto', 'light', 'dark']
  const themeIcon = { auto: '◐', light: '☼', dark: '☾' }
  function currentTheme() {
    const t = localStorage.getItem(LS_THEME)
    return themeOrder.includes(t) ? t : 'auto'
  }
  function applyTheme(t) {
    const root = document.documentElement
    if (t === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', t)
    dom.themeToggle.textContent = themeIcon[t]
    dom.themeToggle.setAttribute('title', 'theme: ' + t + ' (click to cycle)')
  }
  function cycleTheme() {
    const next = themeOrder[(themeOrder.indexOf(currentTheme()) + 1) % themeOrder.length]
    localStorage.setItem(LS_THEME, next)
    applyTheme(next)
    toast('theme: ' + next)
  }
  applyTheme(currentTheme())
  dom.themeToggle.addEventListener('click', cycleTheme)

  // ─── Viewport height ───────────────────────────────────────────────────
  // visualViewport.height tracks the visible area, including soft-keyboard
  // shrinkage on iOS / Android. Sync it to --app-h so the composer never
  // ends up below the keyboard or browser chrome.
  function syncAppHeight() {
    const h = window.visualViewport?.height ?? window.innerHeight
    document.documentElement.style.setProperty('--app-h', h + 'px')
  }
  syncAppHeight()
  window.addEventListener('resize', syncAppHeight)
  window.addEventListener('orientationchange', syncAppHeight)
  window.visualViewport?.addEventListener('resize', syncAppHeight)
  window.visualViewport?.addEventListener('scroll', syncAppHeight)

  // ─── State ─────────────────────────────────────────────────────────────
  const state = {
    bearer: localStorage.getItem(LS_BEARER) || '',
    clientId: localStorage.getItem(LS_CLIENT) || crypto.randomUUID(),
    ws: null,
    machines: [],
    knownProjects: [],
    subscribed: new Set(JSON.parse(localStorage.getItem(LS_SUBS) || '[]')),
    feed: [],            // chronological FeedItem list
    pendingPerms: [],    // unresolved perm_ask
    cards: new Map(),    // \`\${project_id}:\${card_id}\` → Card REST shape
    focusKey: null,      // \`\${project_id}:\${card_id}\`
    userMessages: new Map(), // card_key → [{ ts, body, pending, id }]
    pendingSends: new Map(), // id → msg (awaiting redirect_ack)
    filter: localStorage.getItem(LS_FILTER) || 'all',
    reconnectMs: 1000,
  }
  localStorage.setItem(LS_CLIENT, state.clientId)

  // ─── Toast ─────────────────────────────────────────────────────────────
  let toastTimer = null
  function toast(msg) {
    dom.toast.textContent = msg
    dom.toast.classList.add('show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2200)
  }

  // ─── Auth gate ─────────────────────────────────────────────────────────
  function showGate() {
    dom.gate.style.display = 'grid'
    setTimeout(() => dom.bearerInput.focus(), 50)
  }
  function hideGate() { dom.gate.style.display = 'none' }
  dom.bearerSave.addEventListener('click', () => {
    const v = dom.bearerInput.value.trim()
    if (!v) return
    state.bearer = v
    localStorage.setItem(LS_BEARER, v)
    hideGate()
    connect()
  })
  dom.bearerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dom.bearerSave.click()
  })
  dom.bearerHelp.addEventListener('click', () => {
    toast('packages/worker/.dev.vars → UI_BEARER')
  })

  // ─── Connection ────────────────────────────────────────────────────────
  function setConn(status, text) {
    dom.connDot.className = 'dot ' + status
    dom.connBtn.title = text
  }

  function connect() {
    if (!state.bearer) { showGate(); return }
    if (state.ws && state.ws.readyState === 1) return
    setConn('', 'connecting…')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = proto + '://' + location.host
      + '/ws/ui?client_id=' + encodeURIComponent(state.clientId)
      + '&access_token=' + encodeURIComponent(state.bearer)
    let ws
    try { ws = new WebSocket(url) }
    catch (err) { setConn('bad', 'error'); scheduleReconnect(); return }
    state.ws = ws

    ws.addEventListener('open', () => {
      setConn('ok', 'live')
      state.reconnectMs = 1000
      send({ type: 'hello', client_id: state.clientId, bearer: state.bearer })
      if (state.subscribed.size > 0) {
        send({ type: 'subscribe', project_ids: [...state.subscribed] })
        for (const p of state.subscribed) send({ type: 'replay', project_id: p, since: 0 })
      }
    })
    ws.addEventListener('message', (ev) => {
      try { onMessage(JSON.parse(ev.data)) } catch (err) { console.error(err) }
    })
    ws.addEventListener('close', (ev) => {
      state.ws = null
      setConn('bad', ev.code === 1006 || ev.code === 1008 ? 'unauthorized?' : 'offline')
      scheduleReconnect()
    })
    ws.addEventListener('error', () => setConn('bad', 'error'))
  }

  function scheduleReconnect() {
    setTimeout(connect, state.reconnectMs)
    state.reconnectMs = Math.min(state.reconnectMs * 2, 15000)
  }

  function send(msg) {
    if (!state.ws || state.ws.readyState !== 1) return false
    try { state.ws.send(JSON.stringify(msg)); return true } catch { return false }
  }

  // ─── Inbound ───────────────────────────────────────────────────────────
  function onMessage(msg) {
    switch (msg.type) {
      case 'welcome': {
        state.machines = msg.me?.machines || []
        const allKnown = new Set(state.knownProjects)
        for (const p of (msg.me?.projects || [])) allKnown.add(p.project_id)
        state.knownProjects = [...allKnown]
        if (state.subscribed.size === 0) {
          for (const p of state.knownProjects) state.subscribed.add(p)
          persistSubs()
          if (state.subscribed.size > 0) {
            send({ type: 'subscribe', project_ids: [...state.subscribed] })
            for (const p of state.subscribed) send({ type: 'replay', project_id: p })
          }
        }
        renderFleet()
        renderMeta()
        loadAllCards()
        break
      }
      case 'feed_item':
        upsertFeed(msg.item)
        // user redirect echoed back? mark our optimistic message resolved.
        if (msg.item.kind === 'dispatch' && msg.item.from_role && msg.item.body) {
          // no-op: backend doesn't echo redirects, optimistic stays as-is
        }
        renderAll()
        if (msg.item.kind === 'card_state' && msg.item.project_id) {
          loadCardsFor(msg.item.project_id).then(renderAll)
        }
        break
      case 'feed_replay':
        for (const item of msg.items) upsertFeed(item)
        renderAll()
        break
      case 'digest':
        for (const item of msg.items) upsertFeed(item)
        renderAll()
        toast('digest: ' + msg.items.length + ' items')
        break
      case 'fleet':
        if (msg.machines) {
          state.machines = msg.machines
          renderFleet()
        }
        break
      case 'project_state':
      case 'ping':
        break
      case 'redirect_ack': {
        const m = state.pendingSends.get(msg.id)
        if (!m) break
        state.pendingSends.delete(msg.id)
        if (m.timeoutHandle) clearTimeout(m.timeoutHandle)
        m.pending = false
        if (!msg.ok) {
          m.failed = true
          toast('send failed' + (msg.reason ? ': ' + msg.reason : ''))
        }
        renderAll()
        break
      }
      case 'error':
        toast('error: ' + (msg.reason || 'unknown'))
        break
    }
  }

  function upsertFeed(item) {
    const idx = state.feed.findIndex((i) => i.id === item.id)
    if (idx >= 0) state.feed[idx] = item
    else state.feed.push(item)
    state.feed.sort((a, b) => a.seq - b.seq)
    if (item.kind === 'perm_ask') {
      const pendingIdx = state.pendingPerms.findIndex((i) => i.request_id === item.request_id)
      if (item.resolved) {
        if (pendingIdx >= 0) state.pendingPerms.splice(pendingIdx, 1)
      } else if (pendingIdx < 0) {
        state.pendingPerms.push(item)
      }
    }
  }

  // ─── REST: cards ───────────────────────────────────────────────────────
  async function loadCardsFor(project_id) {
    try {
      const r = await fetch('/api/projects/' + encodeURIComponent(project_id) + '/cards')
      if (!r.ok) return
      const cards = await r.json()
      for (const k of [...state.cards.keys()]) {
        if (k.startsWith(project_id + ':')) state.cards.delete(k)
      }
      for (const c of cards) state.cards.set(project_id + ':' + c.id, c)
    } catch {}
  }

  async function loadAllCards() {
    await Promise.all([...state.subscribed].map(loadCardsFor))
    renderAll()
  }

  function persistSubs() {
    localStorage.setItem(LS_SUBS, JSON.stringify([...state.subscribed]))
  }

  // ─── Render: meta + fleet + filter counts ──────────────────────────────
  function renderMeta() {
    const parts = []
    parts.push(new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    if (state.machines.length > 0)
      parts.push(state.machines.length + ' machine' + (state.machines.length === 1 ? '' : 's'))
    parts.push([...state.cards.values()].length + ' chat' + ([...state.cards.values()].length === 1 ? '' : 's'))
    if (state.pendingPerms.length > 0)
      parts.push(state.pendingPerms.length + ' need' + (state.pendingPerms.length === 1 ? 's' : '') + ' you')
    dom.meta.textContent = parts.join(' · ')
  }

  function renderFleet() {
    dom.fleet.innerHTML = ''
    for (const m of state.machines) {
      const card = document.createElement('button')
      card.className = 'fleet-card'
      const name = document.createElement('div')
      name.className = 'machine'
      name.textContent = '⌂ ' + m.machine_id
      card.appendChild(name)
      const sub = document.createElement('div')
      sub.className = 'sub'
      const projs = (m.projects || []).length
      sub.innerHTML = '<span class="dot"></span>' + projs + ' repo' + (projs === 1 ? '' : 's')
      card.appendChild(sub)
      card.addEventListener('click', () => openPairMachine())
      dom.fleet.appendChild(card)
    }
    const add = document.createElement('button')
    add.className = 'fleet-card add'
    add.textContent = '+ pair machine'
    add.addEventListener('click', openPairMachine)
    dom.fleet.appendChild(add)
  }

  // ─── Render: chats list ────────────────────────────────────────────────
  function chatPreview(card) {
    const key = card.project_id + ':' + card.id
    const items = state.feed.filter(
      (i) => i.project_id === card.project_id && i.card_id === card.id,
    )
    // newest first
    for (let j = items.length - 1; j >= 0; j--) {
      const it = items[j]
      if (it.kind === 'dispatch' && it.body) {
        return { text: it.body, from: it.from_role, ts: it.ts }
      }
      if (it.kind === 'peer_in' && it.body) {
        return { text: it.body, from: it.from_role + ' →', ts: it.ts }
      }
      if (it.kind === 'perm_ask' && !it.resolved) {
        return { text: '▲ wants permission for ' + it.tool_name, from: 'system', ts: it.ts }
      }
    }
    return { text: card.description || '', from: '', ts: card.updated_at }
  }

  function classifyCard(card) {
    if (card.pending_input) return 'flag'
    const hasPerm = state.pendingPerms.some(
      (p) => p.project_id === card.project_id && p.card_id === card.id,
    )
    if (hasPerm) return 'flag'
    if (card.status === 'in_progress' || card.status === 'review') return 'live'
    if (card.status === 'todo' || card.status === 'blocked') return 'live'
    return 'idle'
  }

  function passesFilter(bucket) {
    if (state.filter === 'all') return true
    if (state.filter === 'flag') return bucket === 'flag'
    if (state.filter === 'live') return bucket === 'live' || bucket === 'flag'
    if (state.filter === 'idle') return bucket === 'idle'
    return true
  }

  function renderChats() {
    const all = [...state.cards.values()]
      .filter((c) => state.subscribed.has(c.project_id))
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))

    const counts = { all: all.length, flag: 0, live: 0, idle: 0 }
    const bucketed = { flag: [], live: [], idle: [] }
    for (const c of all) {
      const b = classifyCard(c)
      counts[b]++
      bucketed[b].push(c)
    }
    dom.cAll.textContent = counts.all
    dom.cFlag.textContent = counts.flag
    dom.cLive.textContent = counts.live
    dom.cIdle.textContent = counts.idle

    // wipe non-empty
    dom.chats.querySelectorAll('.section-h, .chat-row').forEach((n) => n.remove())

    const visible = []
    if (passesFilter('flag') && bucketed.flag.length > 0) {
      visible.push({ heading: 'needs you', cls: 'flag', cards: bucketed.flag })
    }
    if (passesFilter('live') && bucketed.live.length > 0) {
      visible.push({ heading: 'live', cls: '', cards: bucketed.live })
    }
    if (passesFilter('idle') && bucketed.idle.length > 0) {
      visible.push({ heading: 'idle', cls: '', cards: bucketed.idle })
    }

    if (visible.length === 0) {
      dom.chatsEmpty.style.display = ''
      return
    }
    dom.chatsEmpty.style.display = 'none'

    for (const sec of visible) {
      const h = document.createElement('div')
      h.className = 'section-h ' + sec.cls
      const left = document.createElement('span')
      left.textContent = sec.heading
      h.appendChild(left)
      if (sec.heading === 'idle' || sec.heading === 'live') {
        const link = document.createElement('button')
        link.className = 'add-link'
        link.textContent = '+ new chat'
        link.addEventListener('click', (e) => { e.stopPropagation(); openNewChat() })
        h.appendChild(link)
      }
      dom.chats.appendChild(h)
      for (const c of sec.cards) dom.chats.appendChild(renderChatRow(c, sec.cls))
    }
  }

  function renderChatRow(card, sectionCls) {
    const row = document.createElement('div')
    row.className = 'chat-row ' + (sectionCls === 'flag' ? 'flag' : '')
    const key = card.project_id + ':' + card.id
    if (state.focusKey === key) row.classList.add('focused')

    const sigil = document.createElement('div')
    sigil.className = 'sigil work'
    sigil.textContent = card.project_id.slice(0, 1) || 'w'
    row.appendChild(sigil)

    const main = document.createElement('div')
    main.style.minWidth = '0'
    const head = document.createElement('div')
    head.className = 'head'
    const title = document.createElement('b')
    title.textContent = card.title || '(untitled)'
    head.appendChild(title)
    const branch = document.createElement('span')
    branch.className = 'branch'
    branch.textContent = '· ' + (card.target_branch || card.project_id)
    head.appendChild(branch)
    main.appendChild(head)

    const prev = chatPreview(card)
    const preview = document.createElement('div')
    preview.className = 'preview'
    if (prev.from) {
      const f = document.createElement('span')
      f.className = 'dispatch-from'
      f.textContent = prev.from + ':'
      preview.appendChild(f)
    }
    preview.appendChild(document.createTextNode(prev.text || ''))
    if (!prev.text) {
      const em = document.createElement('em')
      em.textContent = '(no activity yet)'
      preview.innerHTML = ''
      preview.appendChild(em)
    }
    main.appendChild(preview)
    row.appendChild(main)

    const meta = document.createElement('div')
    meta.className = 'meta-r'
    meta.appendChild(document.createTextNode(relTime(prev.ts)))
    meta.appendChild(document.createElement('br'))
    if (sectionCls === 'flag') {
      const f = document.createElement('span')
      f.className = 'flag'; f.textContent = '▲'
      meta.appendChild(f)
    }
    const dot = document.createElement('span')
    dot.className = 'dot ' + (sectionCls === 'flag' ? 'warn' : (classifyCard(card) === 'live' ? 'ok' : 'idle'))
    meta.appendChild(dot)
    row.appendChild(meta)

    row.addEventListener('click', () => focusCardById(card.project_id, card.id))
    return row
  }

  // ─── Filter chips ──────────────────────────────────────────────────────
  for (const btn of dom.filterbar.querySelectorAll('.pill')) {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset.filter
      localStorage.setItem(LS_FILTER, state.filter)
      for (const b of dom.filterbar.querySelectorAll('.pill')) {
        b.classList.toggle('on', b.dataset.filter === state.filter)
      }
      renderChats()
    })
  }
  // restore filter
  for (const b of dom.filterbar.querySelectorAll('.pill')) {
    b.classList.toggle('on', b.dataset.filter === state.filter)
  }

  // ─── Focus / chat pane ─────────────────────────────────────────────────
  function focusCardById(project_id, card_id) {
    state.focusKey = project_id + ':' + card_id
    dom.app.classList.add('has-pane')
    renderChats()
    renderPane()
    setTimeout(() => dom.composerInput.focus(), 50)
  }

  function clearFocus() {
    state.focusKey = null
    dom.app.classList.remove('has-pane')
    renderPane()
  }

  dom.paneBack.addEventListener('click', clearFocus)

  function renderPane() {
    if (!state.focusKey) {
      dom.paneTitle.firstChild && (dom.paneTitle.firstChild.textContent = 'no chat selected')
      dom.paneSub.textContent = 'tap a chat from the list'
      dom.thread.querySelectorAll(':scope > *:not(#pane-empty)').forEach((n) => n.remove())
      dom.paneEmpty.style.display = ''
      dom.composer.style.display = 'none'
      return
    }
    const card = state.cards.get(state.focusKey)
    const [pid, cid] = state.focusKey.split(':')
    const heading = (card?.title || '(untitled)')
    dom.paneTitle.firstChild.textContent = heading
    const subParts = [pid]
    if (card?.target_branch) subParts.push(card.target_branch)
    if (card?.status) subParts.push(card.status)
    dom.paneSub.textContent = subParts.join(' · ')

    dom.paneEmpty.style.display = 'none'
    dom.composer.style.display = ''

    // build the thread: feed items for this card, interleaved with optimistic user msgs
    const items = state.feed
      .filter((i) => i.project_id === pid && i.card_id === cid)
      .map((i) => ({ kind: 'feed', ts: i.ts, item: i }))
    const ums = (state.userMessages.get(state.focusKey) || []).map((m) => ({ kind: 'me', ts: m.ts, msg: m }))
    // Pending unresolved perm_asks for this card render at the bottom (most recent)
    const orderedAll = items.concat(ums).sort((a, b) => a.ts - b.ts)

    // wipe and rebuild
    dom.thread.querySelectorAll(':scope > *:not(#pane-empty)').forEach((n) => n.remove())

    // composer surrounds — pending banner / tmux notice
    renderComposerSurrounds(card)

    let lastDay = ''
    for (const e of orderedAll) {
      const day = dayLabel(e.ts)
      if (day !== lastDay) {
        const sep = document.createElement('div')
        sep.className = 'day'; sep.textContent = day
        dom.thread.appendChild(sep)
        lastDay = day
      }
      if (e.kind === 'me') {
        dom.thread.appendChild(renderMeBubble(e.msg))
      } else {
        const node = renderFeedItem(e.item)
        if (node) dom.thread.appendChild(node)
      }
    }
    // Inline unresolved perm_asks for this card pinned to the bottom
    const localPending = state.pendingPerms.filter((p) => p.project_id === pid && p.card_id === cid)
    for (const p of localPending) dom.thread.appendChild(renderDecision(p))

    if (orderedAll.length === 0 && localPending.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'pane-empty'
      empty.style.padding = '40px 16px'
      empty.innerHTML = '<div class="glyph">…</div><div>No dispatches yet — when the agent reports progress, it lands here. Type below to send the first redirect.</div>'
      dom.thread.appendChild(empty)
    }

    requestAnimationFrame(() => { dom.thread.scrollTop = dom.thread.scrollHeight })
  }

  function renderComposerSurrounds(card) {
    for (const sel of ['.pending-banner', '.tmux-notice']) {
      const n = dom.composer.querySelector(sel)
      if (n) n.remove()
    }
    const inputRow = dom.composer.querySelector('.input-row')

    if (card?.pending_input?.prompt) {
      const banner = document.createElement('div')
      banner.className = 'pending-banner'
      const label = document.createElement('div')
      label.className = 'label'; label.textContent = 'agent is asking'
      const txt = document.createElement('div')
      txt.textContent = card.pending_input.prompt
      banner.appendChild(label); banner.appendChild(txt)
      dom.composer.insertBefore(banner, inputRow)
      dom.composerInput.placeholder = 'answer the prompt above…'
    } else {
      dom.composerInput.placeholder = 'reply to this chat…'
    }

    if (localStorage.getItem(LS_TMUX_DISMISSED) !== '1') {
      const notice = document.createElement('div')
      notice.className = 'tmux-notice'
      notice.innerHTML =
        '<button class="dismiss" title="dismiss">×</button>' +
        'sending may spawn a tmux window <b>work:' +
        escape(card?.project_id ?? '') + '/' + escape(card?.target_branch ?? '?') +
        '</b>. if it sits on the dev-channels prompt, switch to it and press <kbd>1</kbd> then <kbd>↵</kbd> to start Claude.'
      notice.querySelector('.dismiss').addEventListener('click', (e) => {
        e.stopPropagation()
        localStorage.setItem(LS_TMUX_DISMISSED, '1')
        notice.remove()
      })
      dom.composer.insertBefore(notice, inputRow)
    }
  }

  function renderMeBubble(m) {
    const el = document.createElement('div')
    el.className = 'me' + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '')
    el.appendChild(document.createTextNode(m.body))
    if (m.pending) {
      const bar = document.createElement('span')
      bar.className = 'progress'
      el.appendChild(bar)
    }
    const ts = document.createElement('span')
    ts.className = 'ts'
    ts.textContent = m.pending ? 'sending…' : m.failed ? 'failed — tap to retry' : relTime(m.ts)
    el.appendChild(ts)
    return el
  }

  function renderFeedItem(item) {
    if (item.kind === 'card_state') return renderCardState(item)
    if (item.kind === 'perm_ask' && item.resolved) return renderResolvedPerm(item)
    if (item.kind === 'perm_ask') return null // pinned at bottom
    return renderDispatch(item)
  }

  function renderCardState(item) {
    const el = document.createElement('div')
    el.className = 'state-line'
    el.innerHTML = '<span>card</span><span>' + escape(item.from) +
      '</span><span class="arrow">→</span><span>' + escape(item.to) + '</span>'
    return el
  }
  function renderResolvedPerm(item) {
    const el = document.createElement('div')
    el.className = 'state-line'
    const r = item.resolved || {}
    el.innerHTML = '<span>permission</span><span>' + escape(item.tool_name) +
      '</span><span class="arrow">→</span><span>' + escape(r.behavior || '?') +
      ' · ' + escape(r.scope || '?') + '</span>'
    return el
  }

  function renderDispatch(item) {
    const article = document.createElement('article')
    article.className = 'bubble'
    if (item.kind === 'peer_in' || item.to_role) article.classList.add('peer')
    if (item.dispatch_kind === 'committing') article.classList.add('committing')

    const byline = document.createElement('div')
    byline.className = 'byline'
    const role = item.from_role || 'kanban-work'
    const sigil = document.createElement('span')
    sigil.className = 'sigil ' + (role === 'kanban-ops' ? 'ops' : 'work')
    sigil.textContent = role === 'kanban-ops' ? 'o' : 'w'
    byline.appendChild(sigil)
    const name = document.createElement('b')
    name.textContent = role
    byline.appendChild(name)
    if (item.kind === 'dispatch' && item.dispatch_kind) {
      const k = document.createElement('span')
      k.className = 'kind ' + item.dispatch_kind
      k.textContent = item.dispatch_kind
      byline.appendChild(k)
    } else if (item.kind === 'peer_in') {
      const k = document.createElement('span')
      k.className = 'kind'
      k.textContent = 'peer'
      byline.appendChild(k)
    }
    const ts = document.createElement('span')
    ts.className = 'ts'
    ts.textContent = relTime(item.ts)
    byline.appendChild(ts)
    article.appendChild(byline)

    const body = document.createElement('div')
    body.className = 'body'
    body.innerHTML = renderMarkdown(item.body || '')
    article.appendChild(body)

    const footers = document.createElement('div')
    footers.className = 'footers'
    if (item.to_role) {
      const cross = document.createElement('span')
      cross.className = 'pill cross'
      cross.textContent = '→ ' + item.to_role
      footers.appendChild(cross)
    }
    if (item.committing) {
      const dl = document.createElement('span')
      dl.className = 'pill ' + (item.committing.resolved ? 'resolved' : 'deadline')
      dl.textContent = item.committing.resolved
        ? 'committed'
        : 'deciding in ' + Math.max(0, Math.round((item.committing.deadline - Date.now()) / 1000)) + 's'
      footers.appendChild(dl)
    }
    if (footers.childNodes.length > 0) article.appendChild(footers)
    return article
  }

  function renderDecision(item) {
    const wrap = document.createElement('section')
    wrap.className = 'decision'
    wrap.dataset.requestId = item.request_id

    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = '▲ Decide · ' + item.tool_name
    wrap.appendChild(label)

    const what = document.createElement('p')
    what.className = 'what'
    what.innerHTML = '<strong>' + escape(item.tool_name) + '</strong> — ' + escape(item.description || 'requests permission')
    wrap.appendChild(what)

    if (item.input_preview) {
      const ctx = document.createElement('p')
      ctx.className = 'ctx'
      ctx.textContent = item.input_preview
      wrap.appendChild(ctx)
    }

    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.appendChild(decisionBtn('allow once', 'allow', 'allow', 'once'))
    actions.appendChild(decisionBtn('this branch', 'allow', 'ghost', 'branch'))
    actions.appendChild(decisionBtn('always', 'allow', 'ghost', 'forever'))
    actions.appendChild(decisionBtn('deny', 'deny', 'deny', 'once'))
    wrap.appendChild(actions)
    return wrap
  }

  function decisionBtn(text, behavior, klass, scope) {
    const b = document.createElement('button')
    b.className = 'btn ' + klass
    b.textContent = text
    b.addEventListener('click', (ev) => {
      const wrap = ev.target.closest('.decision')
      const request_id = wrap?.dataset.requestId
      if (!request_id) return
      wrap.querySelectorAll('button').forEach((x) => { x.disabled = true })
      send({ type: 'permission_verdict', request_id, behavior, scope })
    })
    return b
  }

  // ─── Composer ──────────────────────────────────────────────────────────
  dom.composerInput.addEventListener('input', () => {
    autoResize(dom.composerInput)
    dom.send.disabled = !dom.composerInput.value.trim() || !state.focusKey
  })
  dom.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendReply()
    }
  })
  dom.send.addEventListener('click', sendReply)

  function autoResize(el) {
    el.style.height = 'auto'
    el.style.height = Math.min(160, el.scrollHeight) + 'px'
  }

  function sendReply() {
    const body = dom.composerInput.value.trim()
    if (!body || !state.focusKey) return
    const [pid, cid] = state.focusKey.split(':')
    const id = crypto.randomUUID()
    const msg = { id, ts: Date.now(), body, pending: true }
    if (!state.userMessages.has(state.focusKey)) state.userMessages.set(state.focusKey, [])
    state.userMessages.get(state.focusKey).push(msg)
    const ok = send({ type: 'redirect', id, project_id: pid, card_id: cid, body })
    if (!ok) {
      msg.pending = false
      msg.failed = true
      toast('not connected')
    } else {
      // Stay pending until the worker acks. Fail safe via timeout if the
      // ack never arrives (network blip, DO eviction, etc.) so the bubble
      // doesn't lie about "sending…" forever.
      msg.timeoutHandle = setTimeout(() => {
        if (!msg.pending) return
        msg.pending = false
        msg.failed = true
        toast('send timed out')
        renderPane()
      }, 15000)
      state.pendingSends.set(id, msg)
    }
    dom.composerInput.value = ''
    autoResize(dom.composerInput)
    dom.send.disabled = true
    renderPane()
  }

  // ─── New-chat modal ────────────────────────────────────────────────────
  function openNewChat() {
    if (state.knownProjects.length === 0) {
      openAddRepo()
      return
    }
    const sel = { project_id: state.knownProjects[0], target_branch: '', title: '', description: '' }
    const m = openModal('new chat', /* html */ \`
      <p class="lede">Pick a project and seed the first card. Once created, the supervisor on the matching machine will spawn a worktree and start Claude.</p>

      <div class="field-label">Project <span class="hint">on \${escape(state.machines.map((x) => x.machine_id).join(', ') || 'paired machines')}</span></div>
      <div class="picker" id="np-projects"></div>

      <div class="field-label">Branch <span class="hint">e.g. fix/refund-rounding</span></div>
      <input id="np-branch" placeholder="target branch" />

      <div class="field-label">Title</div>
      <input id="np-title" placeholder="short title" />

      <div class="field-label">Initial prompt / description</div>
      <textarea id="np-desc" placeholder="What should the agent work on?"></textarea>

      <div class="start-row">
        <button class="btn-big" id="np-start">start session →</button>
      </div>
      <div class="footnote">
        Need another project on disk? <button class="add-link" id="np-addrepo" style="background:transparent;border:none;color:var(--accent);cursor:pointer;font-family:var(--mono);font-size:11px;text-decoration:underline;">Add a repository</button>.
      </div>
    \`)

    const projWrap = m.querySelector('#np-projects')
    function refreshProjects() {
      projWrap.innerHTML = ''
      for (const p of state.knownProjects) {
        const opt = document.createElement('div')
        opt.className = 'opt' + (sel.project_id === p ? ' active' : '')
        opt.innerHTML = '<b>' + escape(p) + '</b><small>subscribed</small>'
        opt.addEventListener('click', () => { sel.project_id = p; refreshProjects() })
        projWrap.appendChild(opt)
      }
      const add = document.createElement('div')
      add.className = 'opt add'
      add.textContent = '+ add repo'
      add.addEventListener('click', () => { closeModal(); openAddRepo() })
      projWrap.appendChild(add)
    }
    refreshProjects()

    m.querySelector('#np-addrepo').addEventListener('click', () => { closeModal(); openAddRepo() })

    const startBtn = m.querySelector('#np-start')
    startBtn.addEventListener('click', async () => {
      const project_id = sel.project_id
      const target_branch = m.querySelector('#np-branch').value.trim()
      const title = m.querySelector('#np-title').value.trim()
      const description = m.querySelector('#np-desc').value.trim()
      if (!target_branch || !title) { toast('branch + title required'); return }
      startBtn.disabled = true
      startBtn.textContent = 'starting…'
      try {
        const r = await fetch('/api/projects/' + encodeURIComponent(project_id) + '/cards', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ project_id, title, description, target_branch }),
        })
        if (!r.ok) { toast('create failed: ' + r.status); startBtn.disabled = false; startBtn.textContent = 'start session →'; return }
        const card = await r.json()
        await fetch('/api/projects/' + encodeURIComponent(project_id) + '/cards/' + card.id + '/spawn', { method: 'POST' })
        await loadCardsFor(project_id)
        renderAll()
        focusCardById(project_id, card.id)
        closeModal()
        toast('chat started')
      } catch (err) {
        toast('error: ' + err.message)
        startBtn.disabled = false
        startBtn.textContent = 'start session →'
      }
    })
  }

  // ─── Pair-machine modal ────────────────────────────────────────────────
  function openPairMachine() {
    const machineRows = state.machines.map((m) => /* html */ \`
      <div class="row ok">
        <div class="glyph ok">✓</div>
        <div class="col">
          <div class="name">⌂ \${escape(m.machine_id)}</div>
          <div class="path">\${(m.projects || []).length} repo\${(m.projects || []).length === 1 ? '' : 's'} · paired \${escape(relTime(m.connected_at))}</div>
        </div>
        <div class="meta-r ok">live</div>
      </div>
    \`).join('') || \`
      <div class="row">
        <div class="glyph">⌂</div>
        <div class="col">
          <div class="name" style="color:var(--muted);">no machines paired yet</div>
          <div class="path">run setu on any laptop or server to pair it</div>
        </div>
      </div>
    \`

    openModal('pair machine', /* html */ \`
      <p class="lede">Each paired machine runs the setu supervisor and can host any number of repos and chat sessions.</p>

      <div class="field-label">Currently paired</div>
      <div class="listing">\${machineRows}</div>

      <div class="step" style="margin-top:18px;">
        <div class="n">1</div>
        <div>
          <p class="what">Install the CLI on the new machine.</p>
          <div class="codeblock">
            <button class="copy-btn" data-copy="curl -fsSL https://setu.prashamhtrivedi.app/install | sh">copy</button>
            <span class="c1">curl</span> <span class="c2">-fsSL https://setu.prashamhtrivedi.app/install</span> <span class="c1">| sh</span>
            <br/><span class="c3"># or via Bun:</span>
            <br/><span class="c1">bun</span> <span class="c2">add -g @setu/cli</span>
          </div>
        </div>
      </div>

      <div class="step">
        <div class="n">2</div>
        <div>
          <p class="what">Point it at this Worker — paste your <code>UI_BEARER</code> when prompted.</p>
          <div class="codeblock">
            <button class="copy-btn" data-copy="setu --worker \${location.origin}">copy</button>
            <span class="c1">setu</span> <span class="c2">--worker \${escape(location.origin)}</span>
          </div>
          <div class="footnote" style="margin-top:8px;border:none;padding-top:0;">
            The supervisor binds outbound only — no inbound port, no tunnel. It heartbeats here and shows up in the list above the moment it connects.
          </div>
        </div>
      </div>

      <div class="step">
        <div class="n">3</div>
        <div>
          <p class="what">Once it appears, hit <em>+ new chat</em> and pick that machine's repo to kick off a session.</p>
        </div>
      </div>
    \`)
    bindCopyButtons()
  }

  // ─── Add-repo modal ────────────────────────────────────────────────────
  function openAddRepo() {
    const projectRows = state.knownProjects.map((p) => /* html */ \`
      <div class="row ok">
        <div class="glyph ok">✓</div>
        <div class="col">
          <div class="name">▤ \${escape(p)}</div>
          <div class="path">registered</div>
        </div>
        <div class="meta-r ok">ready</div>
      </div>
    \`).join('') || \`
      <div class="row">
        <div class="glyph">▤</div>
        <div class="col">
          <div class="name" style="color:var(--muted);">no repositories registered</div>
          <div class="path">register one with setu project add</div>
        </div>
      </div>
    \`

    openModal('add repository', /* html */ \`
      <p class="lede">setu doesn't clone for you — point the supervisor at a path it can already see on a paired machine.</p>

      <div class="field-label">Already registered</div>
      <div class="listing">\${projectRows}</div>

      <div class="field-label" style="margin-top:18px;">Register a new repo</div>
      <p class="lede" style="margin-bottom:8px;">Run on the same machine that hosts the repo. The supervisor picks it up live — no restart.</p>
      <div class="codeblock">
        <button class="copy-btn" data-copy="setu project add my-repo /abs/path/to/repo">copy</button>
        <span class="c1">setu project add</span> <span class="c2">my-repo /abs/path/to/repo</span>
        <br/><span class="c3"># custom id:</span>
        <br/><span class="c1">setu project add</span> <span class="c2">my-repo /abs/path/to/repo --id custom-id</span>
      </div>

      <div class="field-label" style="margin-top:18px;">Don't have it cloned yet?</div>
      <div class="codeblock">
        <button class="copy-btn" data-copy="git clone git@github.com:org/new-repo.git ~/code/new-repo
setu project add new-repo ~/code/new-repo">copy</button>
        <span class="c3"># 1. clone it on the machine</span>
        <br/><span class="c1">git clone</span> <span class="c2">git@github.com:org/new-repo.git ~/code/new-repo</span>
        <br/><span class="c3"># 2. register</span>
        <br/><span class="c1">setu project add</span> <span class="c2">new-repo ~/code/new-repo</span>
      </div>

      <div class="footnote">
        <b>Per-repo channels</b> — drop a <code>.setu/channels.json</code> in the repo root to wire MCP servers (kanban-work, parakh, custom). The supervisor mounts them per-session.
      </div>
    \`)
    bindCopyButtons()
  }

  function bindCopyButtons() {
    for (const btn of document.querySelectorAll('.codeblock .copy-btn')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const text = btn.dataset.copy || ''
        navigator.clipboard?.writeText(text).then(
          () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy' }, 1400) },
          () => toast('copy failed'),
        )
      })
    }
  }

  // ─── Generic modal infra ───────────────────────────────────────────────
  let modalEl = null
  function openModal(title, bodyHtml) {
    closeModal()
    const back = document.createElement('div')
    back.className = 'modal-backdrop'
    back.addEventListener('click', (e) => { if (e.target === back) closeModal() })
    const m = document.createElement('div')
    m.className = 'modal'
    m.innerHTML = /* html */ \`
      <div class="grip"></div>
      <div class="modal-head">
        <h3>\${escape(title)}</h3>
        <button class="x" aria-label="close">×</button>
      </div>
      <div class="modal-body">\${bodyHtml}</div>
    \`
    m.querySelector('.x').addEventListener('click', closeModal)
    back.appendChild(m)
    document.body.appendChild(back)
    modalEl = back
    return m
  }
  function closeModal() {
    if (modalEl) { modalEl.remove(); modalEl = null }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal() })

  // ─── Settings menu ─────────────────────────────────────────────────────
  let menuEl = null
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null } }
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target) && e.target !== dom.settings) closeMenu()
  })
  dom.settings.addEventListener('click', (e) => {
    e.stopPropagation()
    if (menuEl) { closeMenu(); return }
    const r = dom.settings.getBoundingClientRect()
    const m = document.createElement('div')
    m.className = 'menu'
    m.style.top = (r.bottom + 6) + 'px'
    m.style.right = (window.innerWidth - r.right) + 'px'
    m.innerHTML = /* html */ \`
      <button data-act="new"><span class="gly">+</span>new chat</button>
      <div class="sep"></div>
      <button data-act="pair"><span class="gly">⌂</span>pair machine</button>
      <button data-act="repo"><span class="gly">▤</span>add repository</button>
      <div class="sep"></div>
      <button data-act="bearer"><span class="gly">⚿</span>change UI bearer</button>
    \`
    m.addEventListener('click', (ev) => {
      const a = ev.target.closest('button')?.dataset.act
      if (!a) return
      closeMenu()
      if (a === 'new') openNewChat()
      else if (a === 'pair') openPairMachine()
      else if (a === 'repo') openAddRepo()
      else if (a === 'bearer') { dom.bearerInput.value = state.bearer; showGate() }
    })
    document.body.appendChild(m)
    menuEl = m
  })

  // ─── FAB / empty CTA ───────────────────────────────────────────────────
  dom.fab.addEventListener('click', openNewChat)
  dom.emptyNew.addEventListener('click', openNewChat)
  dom.connBtn.addEventListener('click', () => {
    if (!state.bearer) showGate()
    else if (!state.ws || state.ws.readyState !== 1) connect()
    else toast('connected · ' + state.knownProjects.length + ' project(s)')
  })

  // ─── Helpers ───────────────────────────────────────────────────────────
  function dayLabel(ts) {
    const d = new Date(ts)
    const today = new Date()
    if (sameYMD(d, today)) return 'TODAY'
    const yesterday = new Date(today.getTime() - 86400000)
    if (sameYMD(d, yesterday)) return 'YESTERDAY'
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
  }
  function sameYMD(a, b) {
    return a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  }
  function relTime(ts) {
    if (!ts) return ''
    const diff = Math.max(0, Date.now() - ts)
    const m = Math.floor(diff / 60000)
    if (m < 1) return 'just now'
    if (m < 60) return m + 'm'
    const h = Math.floor(m / 60)
    if (h < 24) return h + 'h'
    return Math.floor(h / 24) + 'd'
  }
  function escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
  }

  ${markdownRendererSrc}

  function renderAll() {
    renderMeta()
    renderChats()
    if (state.focusKey) renderPane()
  }

  // ─── Boot ──────────────────────────────────────────────────────────────
  function boot() {
    if (!state.bearer) showGate()
    else { hideGate(); connect() }
    setInterval(() => { renderAll() }, 30000)
    setInterval(() => { if (state.subscribed.size) loadAllCards() }, 4000)
  }
  boot()
</script>
</body>
</html>
`
