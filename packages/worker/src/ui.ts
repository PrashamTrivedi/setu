// Minimal embedded UI. v1 keeps the surface tiny — board, card creation, approve button.
// Replace with a real bundled SPA later; the API contract is what matters.
export const indexHtml = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kanban Channels</title>
<style>
  :root { color-scheme: light dark; --bg:#0e1014; --fg:#e7e7ea; --muted:#8a8a93; --card:#1a1d24; --accent:#6ea8fe; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding: 16px 20px; border-bottom: 1px solid #23262d; display:flex; align-items:center; gap:12px; }
  header h1 { font-size: 16px; margin:0; font-weight:600; }
  header .muted { color: var(--muted); font-size: 12px; }
  main { padding: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .col { background:#13161c; border-radius: 10px; padding: 12px; min-height: 240px; border: 1px solid #20242c; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 4px 0 12px; }
  .card { background: var(--card); border: 1px solid #262a32; padding: 10px; border-radius: 8px; margin-bottom: 8px; }
  .card .title { font-weight: 600; }
  .card .meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .row { display:flex; gap: 8px; margin-top: 8px; }
  button { background: var(--accent); border: none; color: #0b1220; font-weight: 600; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid #2c313a; }
  input, textarea { background: #0b0d12; color: var(--fg); border: 1px solid #2a2f38; border-radius: 6px; padding: 6px 8px; width: 100%; }
  form.create { display: grid; gap: 6px; padding: 12px; border: 1px solid #20242c; border-radius: 10px; background: #13161c; margin-bottom: 16px; }
</style>
</head>
<body>
<header>
  <h1>Kanban Channels</h1>
  <span class="muted" id="status">connecting…</span>
</header>
<main>
  <form class="create" id="create" style="grid-column: 1 / -1;">
    <input name="project_id" placeholder="project_id (e.g. demo)" required />
    <input name="title" placeholder="title" required />
    <textarea name="description" placeholder="description"></textarea>
    <input name="target_branch" placeholder="target_branch (e.g. feat/foo)" required />
    <div class="row"><button type="submit">Create card</button></div>
  </form>
  <div class="col" data-status="backlog"><h2>Backlog</h2></div>
  <div class="col" data-status="in_progress"><h2>In progress</h2></div>
  <div class="col" data-status="done-pending-review"><h2>Review</h2></div>
  <div class="col" data-status="merging"><h2>Merging</h2></div>
  <div class="col" data-status="archived"><h2>Archived</h2></div>
</main>
<script type="module">
  const $status = document.getElementById('status')
  const cols = Object.fromEntries([...document.querySelectorAll('.col')].map((c) => [c.dataset.status, c]))
  const projectId = new URLSearchParams(location.search).get('project') || 'demo'

  async function load() {
    const r = await fetch('/api/projects/' + projectId + '/cards')
    if (!r.ok) { $status.textContent = 'error: ' + r.status; return }
    const cards = await r.json()
    for (const col of Object.values(cols)) col.querySelectorAll('.card').forEach((n) => n.remove())
    for (const c of cards) {
      const target = cols[c.status] || cols['backlog']
      if (!target) continue
      const el = document.createElement('div'); el.className = 'card'
      el.innerHTML =
        '<div class="title"></div><div class="meta"></div><div class="row"></div>'
      el.querySelector('.title').textContent = c.title
      el.querySelector('.meta').textContent = c.target_branch + ' · ' + c.id.slice(0, 8)
      const row = el.querySelector('.row')
      if (c.status === 'done-pending-review') {
        const b = document.createElement('button'); b.textContent = 'Approve'
        b.onclick = () => fetch('/api/projects/' + projectId + '/cards/' + c.id + '/approve', { method: 'POST' }).then(load)
        row.appendChild(b)
      }
      target.appendChild(el)
    }
    $status.textContent = 'project: ' + projectId
  }

  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault()
    const fd = new FormData(e.target)
    const body = Object.fromEntries(fd.entries())
    const r = await fetch('/api/projects/' + body.project_id + '/cards', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.ok) { e.target.reset(); load() }
  })

  // SSE for live updates
  try {
    const es = new EventSource('/api/projects/' + projectId + '/stream')
    es.onmessage = () => load()
    es.onerror = () => { $status.textContent = 'reconnecting…' }
  } catch {}

  load()
  setInterval(load, 5000)
</script>
</body>
</html>`
