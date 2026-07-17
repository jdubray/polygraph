// polyrun read-only UI (M2, FR-7.4) — one self-contained page served at GET /.
// Instance search, state view, journal timeline with reject classifications,
// DLQ and timer queues. Reads only the facade's own JSON endpoints; no
// external assets (works air-gapped, honors the loopback doctrine).
'use strict';

export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>polyrun</title>
<style>
  :root { color-scheme: light dark; --line:#8884; --accent:#4a7dbd; --bad:#c0504d; --ok:#5a9e6f; --dim:#8888; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; margin: 0; padding: 1.5rem; max-width: 72rem; margin-inline: auto; }
  h1 { font-size: 1.1rem; } h1 small { color: var(--dim); font-weight: normal; }
  h2 { font-size: 0.95rem; border-bottom: 1px solid var(--line); padding-bottom: .3rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .25rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--dim); font-weight: normal; }
  tr.sel { outline: 1px solid var(--accent); }
  .rejected { color: var(--bad); } .accepted { color: var(--ok); } .unhandled { color: var(--bad); }
  .terminal { color: var(--dim); } .poisoned { color: var(--bad); font-weight: bold; } .active { color: var(--ok); }
  code, pre { background: #8881; padding: .1rem .3rem; border-radius: 3px; overflow-x: auto; }
  input, select { font: inherit; background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 4px; padding: .25rem .5rem; }
  .row { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin: .8rem 0; }
  #metrics { color: var(--dim); }
  .clickable { cursor: pointer; }
</style>
</head>
<body>
<h1>polyrun <small>read-only console</small></h1>
<div class="row">
  <select id="machine"></select>
  <select id="status">
    <option value="">all statuses</option>
    <option>active</option><option>terminal</option><option>poisoned</option>
  </select>
  <input id="filter" placeholder="filter instance id…">
  <span id="metrics"></span>
</div>
<h2>instances</h2>
<table id="instances"><thead><tr><th>instance</th><th>status</th><th>seq</th><th>state</th></tr></thead><tbody></tbody></table>
<h2 id="jtitle" hidden>journal</h2>
<table id="journal" hidden><thead><tr><th>#</th><th>action</th><th>step</th><th>reason</th><th>post</th></tr></thead><tbody></tbody></table>
<script>
  const $ = (s) => document.querySelector(s);
  const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); });
  // Instance ids and state values are caller-supplied data — never innerHTML.
  const cell = (parent, text, cls, mono) => {
    const td = document.createElement('td');
    if (mono) { const c = document.createElement('code'); c.textContent = text; td.appendChild(c); }
    else td.textContent = text;
    if (cls) td.className = cls;
    parent.appendChild(td);
    return td;
  };
  let machines = [];

  async function loadMachines() {
    machines = await j('/machines');
    const sel = $('#machine');
    sel.replaceChildren(...machines.map((m) => {
      const o = document.createElement('option');
      o.textContent = m;
      return o;
    }));
  }
  async function loadMetrics() {
    const m = await j('/metrics');
    $('#metrics').textContent = 'dispatches ' + m.dispatches + ' · accepted ' + m.accepted + ' · rejected ' + m.rejected + ' · deduped ' + m.deduped + ' · poisoned ' + m.poisoned;
  }
  async function loadInstances() {
    const machine = $('#machine').value;
    if (!machine) return;
    const status = $('#status').value;
    const rows = await j('/machines/' + encodeURIComponent(machine) + '/instances' + (status ? '?status=' + status : ''));
    const filter = $('#filter').value.trim();
    const tbody = $('#instances tbody');
    tbody.innerHTML = '';
    for (const r of rows) {
      if (filter && !r.instanceId.includes(filter)) continue;
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      cell(tr, r.instanceId);
      cell(tr, r.status, r.status);
      cell(tr, String(r.seq));
      cell(tr, JSON.stringify(r.state), '', true);
      tr.onclick = () => loadJournal(r.instanceId, tr);
      tbody.appendChild(tr);
    }
  }
  async function loadJournal(id, tr) {
    document.querySelectorAll('#instances tr').forEach((x) => x.classList.remove('sel'));
    if (tr) tr.classList.add('sel');
    const rows = await j('/instances/' + encodeURIComponent(id) + '/journal');
    $('#jtitle').hidden = false;
    $('#jtitle').textContent = 'journal — ' + id;
    const table = $('#journal');
    table.hidden = false;
    const tbody = table.querySelector('tbody');
    tbody.innerHTML = '';
    for (const r of rows) {
      const trr = document.createElement('tr');
      cell(trr, String(r.seq));
      cell(trr, r.action);
      cell(trr, r.step_kind, r.step_kind);
      cell(trr, r.reject_reason ?? '');
      cell(trr, JSON.stringify(r.post), '', true);
      tbody.appendChild(trr);
    }
  }
  $('#machine').onchange = loadInstances;
  $('#status').onchange = loadInstances;
  $('#filter').oninput = loadInstances;
  loadMachines().then(loadInstances);
  loadMetrics();
  setInterval(() => { loadInstances(); loadMetrics(); }, 3000);
</script>
</body>
</html>`;
