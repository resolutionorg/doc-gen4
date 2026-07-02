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

import { DepGraph, HeaderIndex, kindBadge, infoIcon, forceLayout, closureDag } from "./depgraph.js";
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
  const view = params.get("view");
  const decl = params.get("decl") || undefined;
  return {
    view: ["core", "map", "matrix", "decl"].includes(view) ? view : decl ? "decl" : "core",
    decl,
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
  const hint = el(
    "p",
    "atlas_hint",
    "Declarations ranked by meaning mass: the number of declarations that " +
      "reference this one in their statements, directly or transitively. " +
      "Proof mass additionally counts references from proofs."
  );
  hint.appendChild(
    infoIcon(
      "A high meaning mass marks a foundational definition — everything counted " +
        "depends on it for what it says, so an error in it propagates to all of " +
        "them. Theorems and instances are excluded by default: their mass is " +
        "usually small because statements rarely reference them."
    )
  );
  container.appendChild(hint);

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
      "Module × module references (row uses column), modules in topological order, " +
        "foundations top-left. Layering appears as a lower triangle; dense columns " +
        "are heavily referenced modules. Hover for names, click a cell for the " +
        "crossing references."
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
/* map view                                                            */
/* ------------------------------------------------------------------ */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const clusterHue = (ci) => Math.round(ci * 137.508) % 360;

/** Build the map's node/edge sets at cluster or module granularity. */
function mapData(graph, granularity) {
  const clusters = graph.moduleClusters();
  const modToCluster = new Map();
  clusters.forEach((c, ci) => c.modules.forEach((m) => modToCluster.set(m, ci)));
  const declPerModule = new Array(graph.modules.length).fill(0);
  for (const nd of graph.nodes) declPerModule[nd.m]++;

  const groupOf = granularity === "module" ? (m) => m : (m) => modToCluster.get(m);
  const nGroups = granularity === "module" ? graph.modules.length : clusters.length;
  const counts = new Map();
  for (let i = 0; i < graph.nodes.length; i++) {
    const a = groupOf(graph.node(i).m);
    for (const d of graph.proofDeps(i)) {
      const b = groupOf(graph.node(d).m);
      if (a !== b) counts.set(a * nGroups + b, (counts.get(a * nGroups + b) ?? 0) + 1);
    }
  }
  const edges = [...counts.entries()].map(([key, w]) => [Math.floor(key / nGroups), key % nGroups, w]);
  const nodes =
    granularity === "module"
      ? graph.modules.map((name, m) => ({
          name,
          decls: declPerModule[m],
          hue: clusterHue(modToCluster.get(m)),
          href: graph.moduleLink(m),
        }))
      : clusters.map((c, ci) => ({
          name: c.label,
          decls: c.modules.reduce((acc, m) => acc + declPerModule[m], 0),
          modules: c.modules.length,
          hue: clusterHue(ci),
        }));
  const groupOfDecl = graph.nodes.map((nd) => groupOf(nd.m));
  return { nodes, edges, groupOfDecl };
}

/**
 * The dependency cones of one map node, computed on the declaration graph
 * (module-level transitivity would over-approximate) and projected back to
 * map nodes. `up` = nodes with declarations that transitively reference the
 * group's declarations; `down` = nodes the group's declarations reference.
 */
function mapCones(graph, groupOfDecl, groupDecls, gi) {
  const cone = (neighbors) => {
    const groups = new Set();
    const seen = new Set(groupDecls[gi]);
    const stack = [...groupDecls[gi]];
    while (stack.length) {
      const i = stack.pop();
      for (const j of neighbors(i)) {
        if (!seen.has(j)) {
          seen.add(j);
          groups.add(groupOfDecl[j]);
          stack.push(j);
        }
      }
    }
    groups.delete(gi);
    return groups;
  };
  const revP = graph.revProof();
  return { up: cone((i) => revP[i]), down: cone((i) => graph.proofDeps(i)) };
}

function mapView(graph, state) {
  const container = el("div", "atlas_map");
  const hint = el(
    "p",
    "atlas_hint",
    "References between modules. Node area = declarations, color = name-prefix cluster; the layout is force-directed."
  );
  hint.appendChild(
    infoIcon(
      "Position is emergent — only adjacency is meaningful. Hover cones are " +
        "transitive and computed on the declaration graph. Color mixing across " +
        "the layout means related names do not form a dependency neighborhood. " +
        "Click a module to open it."
    )
  );
  container.appendChild(hint);

  const granularity = state.mapGranularity ?? "cluster";
  const controls = el("div", "atlas_map_controls");
  for (const [key, label] of [["cluster", "clusters"], ["module", "modules"]]) {
    const a = el("a", "atlas_map_gran" + (granularity === key ? " atlas_tab_on" : ""), label);
    a.href = "javascript:void(0)";
    a.addEventListener("click", () => {
      state.mapGranularity = key;
      container.replaceWith(mapView(graph, state));
    });
    controls.appendChild(a);
  }
  const legendSwatch = (cls) => {
    const s = svgEl("svg", { viewBox: "0 0 18 8", class: "atlas_legend_swatch" });
    s.appendChild(svgEl("line", { x1: 1, y1: 4, x2: 17, y2: 4, class: cls, "stroke-width": 2 }));
    return s;
  };
  const legend = el("span", "atlas_legend");
  legend.append(
    el("span", null, "hover: "),
    legendSwatch("atlas_legend_up"),
    el("span", null, " depends on it "),
    legendSwatch("atlas_legend_down"),
    el("span", null, " its dependencies"),
    el("span", "atlas_legend_keys", "scroll zoom · drag pan · double-click reset")
  );
  controls.appendChild(legend);
  container.appendChild(controls);

  const { nodes, edges, groupOfDecl } = mapData(graph, granularity);
  const groupDecls = nodes.map(() => []);
  groupOfDecl.forEach((g, i) => groupDecls[g].push(i));
  const { x, y } = forceLayout(nodes, edges);
  const radius = (n) => 3.5 + 2.4 * Math.sqrt(n.decls);
  const pad = 14 + Math.max(...nodes.map(radius));
  const minX = Math.min(...x) - pad;
  const maxX = Math.max(...x) + pad;
  const minY = Math.min(...y) - pad;
  const maxY = Math.max(...y) + pad + 10; // room for labels below nodes
  const svg = svgEl("svg", {
    viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
    class: "atlas_force",
  });
  svg.style.width = "100%";
  svg.style.maxWidth = "740px";

  let maxW = 1;
  for (const [, , w] of edges) maxW = Math.max(maxW, w);
  const edgeRecs = [];
  for (const [a, b, w] of edges) {
    const line = svgEl("line", {
      x1: x[a], y1: y[a], x2: x[b], y2: y[b],
      class: "force_edge",
      "stroke-width": (0.6 + (1.8 * Math.log(1 + w)) / Math.log(1 + maxW)).toFixed(2),
    });
    svg.appendChild(line);
    edgeRecs.push({ el: line, a, b });
  }

  const fullW = maxX - minX;
  const fullH = maxY - minY;
  const baseFont = 9.5 * Math.max(1, fullW / 740);
  const hitPad = 4 * Math.max(1, fullW / 740);

  const nodeEls = [];
  const dotEls = [];
  const hitEls = [];
  const labelEls = [];
  nodes.forEach((n, i) => {
    const g = svgEl("g", { class: "force_node" });
    // Small nodes render at ~2px; an invisible halo keeps them hover/clickable.
    const hit = svgEl("circle", { cx: x[i], cy: y[i], class: "force_hit" });
    const circle = svgEl("circle", { cx: x[i], cy: y[i], class: "force_dot" });
    circle.style.fill = `hsl(${n.hue} 45% 55%)`;
    g.append(hit, circle);
    const t = svgEl("text", { x: x[i], "text-anchor": "middle", class: "force_label" });
    t.textContent = n.name;
    g.appendChild(t);
    nodeEls.push(g);
    dotEls.push(circle);
    hitEls.push(hit);
    labelEls.push(t);
    if (n.href) {
      const a = svgEl("a", { href: n.href });
      a.appendChild(g);
      svg.appendChild(a);
    } else {
      svg.appendChild(g);
    }
  });

  // Semantic labelling: dots and edge widths are constant on screen (dot
  // radii shrink in world units as you zoom in), while label text scales
  // with zoom (capped at 2.5×). A label is shown iff there is room for it at
  // the current scale — largest declaration count wins — so zooming in
  // reveals more labels as space opens up between nodes.
  const labelOrder = [...nodes.keys()].sort((a, b) => nodes[b].decls - nodes[a].decls);
  const visibleLabels = new Set();
  const relayout = (viewW) => {
    const scale = viewW / fullW;
    const zoom = 1 / scale;
    const f = baseFont * scale * Math.min(zoom, 2.5);
    const r = nodes.map((n) => radius(n) * scale);
    nodes.forEach((n, i) => {
      dotEls[i].setAttribute("r", r[i].toFixed(2));
      hitEls[i].setAttribute("r", ((radius(n) + hitPad) * scale).toFixed(2));
      labelEls[i].setAttribute("y", (y[i] + r[i] + f).toFixed(1));
      labelEls[i].style.fontSize = `${f.toFixed(2)}px`;
    });
    visibleLabels.clear();
    const placed = [];
    const collides = (b) =>
      placed.some((o) => b.x0 < o.x1 && o.x0 < b.x1 && b.y0 < o.y1 && o.y0 < b.y1);
    for (const i of labelOrder) {
      const w = nodes[i].name.length * f * 0.62;
      const box = { x0: x[i] - w / 2, x1: x[i] + w / 2, y0: y[i] + r[i], y1: y[i] + r[i] + f * 1.25 };
      let ok = !collides(box);
      if (ok) {
        for (let j = 0; j < nodes.length && ok; j++) {
          if (j !== i && box.x0 < x[j] + r[j] && x[j] - r[j] < box.x1 &&
              box.y0 < y[j] + r[j] && y[j] - r[j] < box.y1) ok = false;
        }
      }
      labelEls[i].style.display = ok ? "" : "none";
      if (ok) {
        visibleLabels.add(i);
        placed.push(box);
      }
    }
  };

  // Hover: color the node's dependency cones and reveal its label in place.
  const coneCache = new Map();
  let marked = [];
  let hovered = null;
  const unhover = () => {
    for (const [el2, cls] of marked) el2.classList.remove(cls);
    marked = [];
    if (hovered !== null && !visibleLabels.has(hovered)) labelEls[hovered].style.display = "none";
    hovered = null;
  };
  const hover = (i) => {
    unhover();
    hovered = i;
    if (!coneCache.has(i)) coneCache.set(i, mapCones(graph, groupOfDecl, groupDecls, i));
    const { up, down } = coneCache.get(i);
    const mark = (el2, cls) => {
      el2.classList.add(cls);
      marked.push([el2, cls]);
    };
    mark(nodeEls[i], "force_hot");
    mark(labelEls[i], "force_label_hot");
    labelEls[i].style.display = "";
    for (const j of up) mark(nodeEls[j], "force_up");
    for (const j of down) mark(nodeEls[j], "force_down");
    for (const e of edgeRecs) {
      if (up.has(e.a) && (up.has(e.b) || e.b === i)) mark(e.el, "force_edge_up");
      else if (down.has(e.b) && (down.has(e.a) || e.a === i)) mark(e.el, "force_edge_down");
    }
  };
  nodeEls.forEach((g, i) => {
    g.addEventListener("mouseenter", () => hover(i));
    g.addEventListener("mouseleave", unhover);
  });

  // Zoom (wheel, cursor-centered) and pan (drag); double-click resets.
  // Label visibility only depends on scale, so relayout runs on zoom, not pan.
  const view = { x: minX, y: minY, w: fullW };
  let layoutW = null;
  const apply = () => {
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${(view.w * fullH) / fullW}`);
    if (view.w !== layoutW) {
      layoutW = view.w;
      relayout(view.w);
      if (hovered !== null) labelEls[hovered].style.display = "";
    }
  };
  apply();
  svg.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const newW = Math.min(fullW * 1.5, Math.max(fullW / 20, view.w * Math.exp(ev.deltaY * 0.0015)));
    const px = view.x + ((ev.clientX - rect.left) / rect.width) * view.w;
    const py = view.y + ((ev.clientY - rect.top) / rect.height) * ((view.w * fullH) / fullW);
    const s = newW / view.w;
    view.x = px - (px - view.x) * s;
    view.y = py - (py - view.y) * s;
    view.w = newW;
    apply();
  }, { passive: false });
  let pan = null;
  svg.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    pan = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y, moved: false };
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!pan) return;
    const rect = svg.getBoundingClientRect();
    const dx = ev.clientX - pan.x;
    const dy = ev.clientY - pan.y;
    if (!pan.moved) {
      if (Math.abs(dx) + Math.abs(dy) <= 4) return;
      // Capturing on pointerdown would retarget pointerup (and the derived
      // click) to the svg, breaking node links — capture only once a real
      // drag has started.
      pan.moved = true;
      svg.setPointerCapture(ev.pointerId);
    }
    view.x = pan.vx - (dx / rect.width) * view.w;
    view.y = pan.vy - (dy / rect.height) * ((view.w * fullH) / fullW);
    apply();
  });
  let lastMoved = false;
  svg.addEventListener("pointerup", () => {
    lastMoved = pan?.moved ?? false;
    pan = null;
  });
  // A drag is not a click: keep module links from firing after a pan.
  svg.addEventListener("click", (ev) => {
    if (lastMoved) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, true);
  svg.addEventListener("dblclick", () => {
    view.x = minX;
    view.y = minY;
    view.w = fullW;
    apply();
  });

  const wrap = el("div", "atlas_dag_wrap");
  wrap.appendChild(svg);
  container.appendChild(wrap);
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
    const closureSize = graph.closure(id).length;
    if (closureSize > 0 && closureSize <= 80) {
      const wrap = el("div", "atlas_dag_wrap");
      wrap.appendChild(closureDag(graph, id));
      target.appendChild(wrap);
    }
    const left = el("div", "atlas_decl_col");
    const right = el("div", "atlas_decl_col");
    left.appendChild(buildDepsPanel(graph, headers, id, { dag: false }));
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
      map: () => mapView(graph, state),
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
      ["core", "core"],
      ["map", "map"],
      ["matrix", "module matrix"],
      ["decl", "declaration"],
    ]) {
      const b = el("a", "atlas_tab", label);
      b.href = "javascript:void(0)";
      b.addEventListener("click", () => show(view));
      tabs.appendChild(b);
      buttons[view] = b;
    }
    // setHash uses replaceState (no hashchange), so this only fires on real
    // navigation, e.g. following an atlas link while already on the atlas.
    window.addEventListener("hashchange", () => {
      const s = parseHash();
      if (s.decl) state.decl = s.decl;
      show(views[s.view] ? s.view : "core");
    });
    show(views[state.view] ? state.view : "core");
  })
  .catch((err) => {
    app.textContent = `Dependency data unavailable: ${err}`;
  });
