// Minimal embedded UI. Lists known projects (from machine registry), lets you
// pick one, view its board, create cards, approve.
export const indexHtml = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kanban Channels</title>
<style>
  :root { color-scheme: light dark; --bg:#0e1014; --fg:#e7e7ea; --muted:#8a8a93; --card:#1a1d24; --accent:#6ea8fe; --warn:#f5a524; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--fg); }
  header { padding: 12px 20px; border-bottom: 1px solid #23262d; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { font-size: 16px; margin:0; font-weight:600; }
  header .muted { color: var(--muted); font-size: 12px; }
  header select { background: #0b0d12; color: var(--fg); border: 1px solid #2a2f38; border-radius: 6px; padding: 4px 8px; }
  main { padding: 20px; display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
  .col { background:#13161c; border-radius: 10px; padding: 12px; min-height: 240px; border: 1px solid #20242c; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 4px 0 12px; }
  .card { background: var(--card); border: 1px solid #262a32; padding: 10px; border-radius: 8px; margin-bottom: 8px; }
  .card .title { font-weight: 600; }
  .card .meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .row { display:flex; gap: 8px; margin-top: 8px; flex-wrap:wrap; }
  button { background: var(--accent); border: none; color: #0b1220; font-weight: 600; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
  button.ghost { background: transparent; color: var(--fg); border: 1px solid #2c313a; }
  input, textarea { background: #0b0d12; color: var(--fg); border: 1px solid #2a2f38; border-radius: 6px; padding: 6px 8px; width: 100%; }
  form.create { display: grid; gap: 6px; padding: 12px; border: 1px solid #20242c; border-radius: 10px; background: #13161c; margin-bottom: 16px; }
  .empty { color: var(--muted); padding: 20px; text-align: center; grid-column: 1 / -1; border: 1px dashed #2a2f38; border-radius: 10px; }
  .warn { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>Kanban Channels</h1>
  <select id="project-picker"></select>
  <span class="muted" id="status">loading…</span>
  <span class="muted" id="machines"></span>
</header>
<main id="root">
</main>
<script type="module">
  const $status = document.getElementById('status')
  const $machines = document.getElementById('machines')
  const $picker = document.getElementById('project-picker')
  const $root = document.getElementById('root')

  let currentProject = new URLSearchParams(location.search).get('project') || ''

  function setQueryProject(p) {
    const u = new URL(location.href)
    if (p) u.searchParams.set('project', p); else u.searchParams.delete('project')
    history.replaceState(null, '', u)
  }

  async function loadRegistry() {
    const r = await fetch('/api/projects')
    if (!r.ok) { $status.textContent = 'registry error: ' + r.status; return { projects: [], machines: [] } }
    return await r.json()
  }

  function renderEmpty(msg) {
    $root.innerHTML = ''
    const el = document.createElement('div'); el.className = 'empty'
    el.innerHTML = msg
    $root.appendChild(el)
  }

  function renderBoardSkeleton() {
    $root.innerHTML = \`
      <form class="create" id="create" style="grid-column: 1 / -1;">
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
    \`
    document.getElementById('create').addEventListener('submit', async (e) => {
      e.preventDefault()
      if (!currentProject) return
      const fd = new FormData(e.target)
      const body = { project_id: currentProject, ...Object.fromEntries(fd.entries()) }
      const r = await fetch('/api/projects/' + currentProject + '/cards', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.ok) { e.target.reset(); loadCards() }
    })
  }

  async function loadCards() {
    if (!currentProject) return
    const cols = Object.fromEntries([...document.querySelectorAll('.col')].map((c) => [c.dataset.status, c]))
    const r = await fetch('/api/projects/' + currentProject + '/cards')
    if (!r.ok) { $status.textContent = 'error: ' + r.status; return }
    const cards = await r.json()
    for (const col of Object.values(cols)) col.querySelectorAll('.card').forEach((n) => n.remove())
    for (const c of cards) {
      const target = cols[c.status] || cols['backlog']
      if (!target) continue
      const el = document.createElement('div'); el.className = 'card'
      el.innerHTML = '<div class="title"></div><div class="meta"></div><div class="row"></div>'
      el.querySelector('.title').textContent = c.title
      el.querySelector('.meta').textContent = c.target_branch + ' · ' + c.id.slice(0, 8)
      const row = el.querySelector('.row')
      if (c.status === 'backlog' || c.status === 'assigned') {
        const b = document.createElement('button'); b.textContent = 'Spawn worker'
        b.onclick = () => fetch('/api/projects/' + currentProject + '/cards/' + c.id + '/spawn', { method: 'POST' }).then(loadCards)
        row.appendChild(b)
      }
      if (c.status === 'done-pending-review') {
        const b = document.createElement('button'); b.textContent = 'Approve'
        b.onclick = () => fetch('/api/projects/' + currentProject + '/cards/' + c.id + '/approve', { method: 'POST' }).then(loadCards)
        row.appendChild(b)
      }
      target.appendChild(el)
    }
    $status.textContent = 'project: ' + currentProject + ' · ' + cards.length + ' card(s)'
  }

  async function refresh() {
    const reg = await loadRegistry()
    const projects = reg.projects || []
    const machines = reg.machines || []
    $machines.textContent = machines.length
      ? '(' + machines.length + ' machine' + (machines.length === 1 ? '' : 's') + ' connected: ' + machines.map((m) => m.machine_id).join(', ') + ')'
      : '(no supervisor connected)'

    $picker.innerHTML = ''
    if (projects.length === 0) {
      const opt = document.createElement('option'); opt.textContent = '(no projects)'; opt.disabled = true; $picker.appendChild(opt)
      renderEmpty('No projects registered yet. Run <code>setu project add &lt;id&gt; &lt;path&gt;</code> on a connected supervisor, then reload.')
      $status.textContent = ''
      return
    }
    for (const p of projects) {
      const opt = document.createElement('option'); opt.value = p; opt.textContent = p; $picker.appendChild(opt)
    }
    if (!currentProject || !projects.includes(currentProject)) {
      currentProject = projects[0]
      setQueryProject(currentProject)
    }
    $picker.value = currentProject
    renderBoardSkeleton()
    await loadCards()
  }

  $picker.addEventListener('change', () => {
    currentProject = $picker.value
    setQueryProject(currentProject)
    renderBoardSkeleton()
    loadCards()
  })

  // SSE — only valid when a project is selected. We use it only as a tick.
  let es = null
  function attachSSE() {
    if (es) try { es.close() } catch {}
    if (!currentProject) return
    try {
      es = new EventSource('/api/projects/' + currentProject + '/stream')
      es.onmessage = () => loadCards()
      es.onerror = () => { $status.textContent = 'reconnecting…' }
    } catch {}
  }

  await refresh()
  attachSSE()
  setInterval(refresh, 10000)
</script>
</body>
</html>`
