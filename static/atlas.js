/**
 * timaeus fork: the dependency atlas page.
 *
 * Three coordinated views over the same graph:
 * - core: declarations ranked by how much of the project's meaning rests on
 *   them (the emergent trust core).
 * - matrix: a module-level dependency structure matrix in topological order —
 *   layering reads as a lower triangle, and dense columns are load-bearing
 *   modules.
 * - decl: focus on one declaration — its statement closure and blast radius.
 */

import { DepGraph, HeaderIndex, kindBadge } from "./depgraph.js";
import { buildDepsPanel, buildImpactPanel } from "./depgraph-decl.js";

const app = document.getElementById("atlas_app");

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function parseHash() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return {
    view: params.get("view") || (params.get("decl") ? "decl" : "core"),
    decl: params.get("decl") || undefined,
  };
}

function setHash(view, decl) {
  const params = new URLSearchParams();
  if (decl) params.set("decl", decl);
  if (view !== "decl" || !decl) params.set("view", view);
  history.replaceState(null, "", `#${params}`);
}

/* ------------------------------------------------------------------ */
/* mass computation                                                    */
/* ------------------------------------------------------------------ */

/** For every node, the number of nodes whose closure (via rev) contains it. */
function masses(graph, rev) {
  const n = graph.nodes.length;
  const result = new Int32Array(n);
  const stamp = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    let top = 0;
    for (const j of rev[s]) {
      if (stamp[j] !== s) {
        stamp[j] = s;
        stack[top++] = j;
      }
    }
    let count = 0;
    while (top > 0) {
      const i = stack[--top];
      count++;
      for (const j of rev[i]) {
        if (stamp[j] !== s) {
          stamp[j] = s;
          stack[top++] = j;
        }
      }
    }
    result[s] = count;
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* core view                                                           */
/* ------------------------------------------------------------------ */

const CORE_KINDS = ["def", "structure", "inductive", "class", "opaque", "axiom", "theorem", "instance"];
const CORE_DEFAULT = new Set(["def", "structure", "inductive", "class", "opaque", "axiom"]);

function coreView(graph, state) {
  if (!state.meaningMass) {
    state.meaningMass = masses(graph, graph.revMeaning());
    state.proofMass = masses(graph, graph.revProof());
  }
  const container = el("div", "atlas_core");
  container.appendChild(
    el(
      "p",
      "atlas_hint",
      "Ranked by meaning mass: the number of declarations whose statements " +
        "transitively rest on this one. These are the definitions to check first " +
        "before believing anything downstream. Proof mass additionally counts " +
        "declarations whose proofs use it."
    )
  );

  const filters = el("div", "atlas_kind_filters");
  const active = state.coreKinds ?? (state.coreKinds = new Set(CORE_DEFAULT));
  for (const kind of CORE_KINDS) {
    const label = el("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = active.has(kind);
    cb.addEventListener("change", () => {
      cb.checked ? active.add(kind) : active.delete(kind);
      renderRows();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(kind));
    filters.appendChild(label);
  }
  container.appendChild(filters);

  const table = el("table", "atlas_core_table");
  container.appendChild(table);
  const more = el("a", "atlas_more", "show more");
  more.href = "javascript:void(0)";
  container.appendChild(more);

  let limit = 50;
  const renderRows = () => {
    const ranked = graph.nodes
      .map((nd, i) => i)
      .filter((i) => active.has(graph.node(i).k) || (graph.node(i).k === "class inductive" && active.has("class")))
      .sort((a, b) => state.meaningMass[b] - state.meaningMass[a] || state.proofMass[b] - state.proofMass[a]);
    const maxMass = Math.max(1, ...ranked.slice(0, 1).map((i) => state.meaningMass[i]));
    table.innerHTML =
      "<thead><tr><th></th><th>declaration</th><th>meaning mass</th><th>proof mass</th></tr></thead>";
    const tbody = el("tbody");
    ranked.slice(0, limit).forEach((i, rank) => {
      const nd = graph.node(i);
      const tr = el("tr");
      tr.appendChild(el("td", "atlas_rank", String(rank + 1)));
      const nameTd = el("td");
      nameTd.appendChild(kindBadge(nd.k));
      const a = el("a");
      a.href = graph.declLink(i);
      a.appendChild(el("code", null, nd.n));
      nameTd.appendChild(a);
      if (nd.s) nameTd.appendChild(el("span", "depgraph_sorried", "sorry"));
      const focus = el("a", "atlas_focus_link", "focus");
      focus.href = "javascript:void(0)";
      focus.addEventListener("click", () => state.showDecl(nd.n));
      nameTd.appendChild(focus);
      tr.appendChild(nameTd);
      const massTd = el("td", "atlas_mass");
      const bar = el("span", "depgraph_cluster_bar");
      const fill = el("span", "depgraph_cluster_fill");
      fill.style.width = `${Math.round((100 * state.meaningMass[i]) / maxMass)}%`;
      bar.appendChild(fill);
      massTd.appendChild(bar);
      massTd.appendChild(el("span", null, ` ${state.meaningMass[i]}`));
      tr.appendChild(massTd);
      tr.appendChild(el("td", "atlas_mass_proof", String(state.proofMass[i])));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    more.style.display = ranked.length > limit ? "" : "none";
  };
  more.addEventListener("click", () => {
    limit += 100;
    renderRows();
  });
  renderRows();
  return container;
}

/* ------------------------------------------------------------------ */
/* matrix view                                                         */
/* ------------------------------------------------------------------ */

function moduleMatrix(graph) {
  const nMods = graph.modules.length;
  const counts = new Map(); // "a,b" -> #references from module a to module b
  const uses = graph.modules.map(() => new Set());
  for (let i = 0; i < graph.nodes.length; i++) {
    const a = graph.node(i).m;
    for (const d of graph.proofDeps(i)) {
      const b = graph.node(d).m;
      if (a === b) continue;
      uses[a].add(b);
      const key = a * nMods + b;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // Topological order, most-depended-on first (dependencies end up lower-left).
  const usedBy = graph.modules.map(() => []);
  const pending = uses.map((s) => s.size);
  for (let a = 0; a < nMods; a++) for (const b of uses[a]) usedBy[b].push(a);
  const order = [];
  let frontier = [];
  for (let m = 0; m < nMods; m++) if (pending[m] === 0) frontier.push(m);
  while (frontier.length) {
    frontier.sort((x, y) => graph.modules[x].localeCompare(graph.modules[y]));
    const next = [];
    for (const b of frontier) {
      order.push(b);
      for (const a of usedBy[b]) if (--pending[a] === 0) next.push(a);
    }
    frontier = next;
  }
  for (let m = 0; m < nMods; m++) if (!order.includes(m)) order.push(m); // cycle fallback
  return { counts, order };
}

function matrixView(graph, state) {
  const container = el("div", "atlas_matrix");
  container.appendChild(
    el(
      "p",
      "atlas_hint",
      "Module × module references (row uses column), modules in topological order — " +
        "foundations top-left. A clean layering is a lower triangle; dense columns are " +
        "load-bearing modules. Hover for names, click a cell for the crossing references."
    )
  );
  const { counts, order } = moduleMatrix(graph);
  const nMods = graph.modules.length;
  const cell = Math.max(3, Math.min(14, Math.floor(840 / Math.max(1, nMods))));
  const size = cell * nMods;

  const wrap = el("div", "atlas_matrix_wrap");
  const canvas = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.fillStyle = dark ? "#222" : "#f2f2f2";
  for (let i = 0; i < nMods; i++) ctx.fillRect(i * cell, i * cell, cell, cell);
  let maxCount = 1;
  for (const v of counts.values()) maxCount = Math.max(maxCount, v);
  const pos = new Int32Array(nMods);
  order.forEach((m, i) => (pos[m] = i));
  for (const [key, v] of counts.entries()) {
    const a = Math.floor(key / nMods);
    const b = key % nMods;
    const intensity = 0.25 + (0.75 * Math.log(1 + v)) / Math.log(1 + maxCount);
    ctx.fillStyle = dark
      ? `rgba(88, 166, 255, ${intensity})`
      : `rgba(21, 93, 176, ${intensity})`;
    ctx.fillRect(pos[b] * cell, pos[a] * cell, cell, cell);
  }
  wrap.appendChild(canvas);
  container.appendChild(wrap);

  const tooltip = el("div", "atlas_matrix_tooltip");
  tooltip.style.display = "none";
  container.appendChild(tooltip);
  const detail = el("div", "atlas_matrix_detail");
  container.appendChild(detail);

  const cellAt = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((ev.clientX - rect.left) / cell);
    const row = Math.floor((ev.clientY - rect.top) / cell);
    if (row < 0 || row >= nMods || col < 0 || col >= nMods) return null;
    return { a: order[row], b: order[col] };
  };
  canvas.addEventListener("mousemove", (ev) => {
    const c = cellAt(ev);
    if (!c) return (tooltip.style.display = "none");
    const v = counts.get(c.a * nMods + c.b) ?? 0;
    tooltip.style.display = "";
    tooltip.style.left = `${ev.clientX + 12}px`;
    tooltip.style.top = `${ev.clientY + 12}px`;
    tooltip.textContent =
      c.a === c.b
        ? graph.modules[c.a]
        : `${graph.modules[c.a]} → ${graph.modules[c.b]}${v ? ` (${v} refs)` : ""}`;
  });
  canvas.addEventListener("mouseleave", () => (tooltip.style.display = "none"));
  canvas.addEventListener("click", (ev) => {
    const c = cellAt(ev);
    if (!c || c.a === c.b) return;
    detail.innerHTML = "";
    const v = counts.get(c.a * nMods + c.b) ?? 0;
    if (!v) return;
    detail.appendChild(el("h3", null, `${graph.modules[c.a]} → ${graph.modules[c.b]}`));
    const list = el("div", "depgraph_cluster_list");
    for (let i = 0; i < graph.nodes.length; i++) {
      if (graph.node(i).m !== c.a) continue;
      for (const d of new Set(graph.proofDeps(i))) {
        if (graph.node(d).m !== c.b) continue;
        const row = el("div");
        const from = el("a");
        from.href = graph.declLink(i);
        from.appendChild(el("code", null, graph.node(i).n));
        const to = el("a");
        to.href = graph.declLink(d);
        to.appendChild(el("code", null, graph.node(d).n));
        row.appendChild(from);
        row.appendChild(document.createTextNode(" → "));
        row.appendChild(to);
        list.appendChild(row);
      }
    }
    detail.appendChild(list);
  });
  return container;
}

/* ------------------------------------------------------------------ */
/* decl view                                                           */
/* ------------------------------------------------------------------ */

function declView(graph, state) {
  const container = el("div", "atlas_decl");
  const box = el("input", "atlas_search");
  box.placeholder = "find a declaration…";
  box.value = state.decl ?? "";
  const results = el("div", "atlas_search_results");
  const target = el("div", "atlas_decl_target");
  const panels = el("div", "atlas_decl_panels");
  container.append(box, results, target, panels);

  const render = async (name) => {
    results.innerHTML = "";
    target.innerHTML = "";
    panels.innerHTML = "";
    const id = graph.idOf(name);
    if (id === undefined) return;
    state.decl = name;
    setHash("decl", name);
    const headers = await HeaderIndex.init();
    const head = el("div", "depgraph_item");
    head.appendChild(kindBadge(graph.node(id).k));
    const a = el("a");
    a.href = graph.declLink(id);
    a.appendChild(el("code", null, name));
    head.appendChild(a);
    const entry = headers.get(name);
    if (entry) {
      const sig = el("div", "depgraph_item_sig");
      sig.innerHTML = entry.header;
      head.appendChild(sig);
    }
    target.appendChild(head);
    const left = el("div", "atlas_decl_col");
    const right = el("div", "atlas_decl_col");
    left.appendChild(buildDepsPanel(graph, headers, id));
    right.appendChild(buildImpactPanel(graph, id));
    panels.append(left, right);
  };

  box.addEventListener("input", () => {
    const q = box.value.trim().toLowerCase();
    results.innerHTML = "";
    if (q.length < 2) return;
    const hits = [];
    for (const nd of graph.nodes) {
      if (nd.n.toLowerCase().includes(q)) hits.push(nd.n);
      if (hits.length >= 20) break;
    }
    for (const name of hits) {
      const item = el("a", "atlas_search_hit");
      item.href = "javascript:void(0)";
      item.appendChild(el("code", null, name));
      item.addEventListener("click", () => {
        box.value = name;
        render(name);
      });
      results.appendChild(item);
    }
  });

  if (state.decl) render(state.decl);
  return container;
}

/* ------------------------------------------------------------------ */
/* shell                                                               */
/* ------------------------------------------------------------------ */

DepGraph.init()
  .then((graph) => {
    const state = parseHash();
    app.innerHTML = "";

    const tabs = el("div", "atlas_tabs");
    const body = el("div", "atlas_body");
    app.append(tabs, body);

    const views = {
      core: () => coreView(graph, state),
      matrix: () => matrixView(graph, state),
      decl: () => declView(graph, state),
    };
    const buttons = {};
    const show = (view) => {
      state.view = view;
      setHash(view, view === "decl" ? state.decl : undefined);
      body.innerHTML = "";
      body.appendChild(views[view]());
      for (const [v, b] of Object.entries(buttons)) {
        b.classList.toggle("atlas_tab_on", v === view);
      }
    };
    state.showDecl = (name) => {
      state.decl = name;
      show("decl");
    };
    for (const [view, label] of [
      ["core", "trust core"],
      ["matrix", "module matrix"],
      ["decl", "declaration"],
    ]) {
      const b = el("a", "atlas_tab", label);
      b.href = "javascript:void(0)";
      b.addEventListener("click", () => show(view));
      tabs.appendChild(b);
      buttons[view] = b;
    }
    show(state.view in views ? state.view : "core");
  })
  .catch((err) => {
    app.textContent = `Dependency data unavailable: ${err}`;
  });
