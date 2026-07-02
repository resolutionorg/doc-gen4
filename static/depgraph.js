/**
 * timaeus fork: core library for the dep atlas.
 *
 * Loads `declarations/depgraph.json` (see `DocGen4.Output.depGraphOutput` for
 * the format) and provides graph operations over two edge relations:
 *
 * - meaning edges: statement (type-site) dependencies everywhere, plus
 *   value-site dependencies of non-propositional declarations (a definition's
 *   body is part of its meaning). If a definition is wrong, everything
 *   reachable *backwards* along meaning edges is a statement about the wrong
 *   thing.
 * - proof edges: meaning edges plus value-site dependencies of proofs. If a
 *   lemma is false, everything reachable backwards along proof edges is
 *   unproven.
 */

export class DepGraph {
  static _promise = null;

  static async init() {
    if (!DepGraph._promise) {
      const url = new URL(`${SITE_ROOT}declarations/depgraph.json`, window.location);
      DepGraph._promise = fetch(url)
        .then((res) => res.json())
        .then((data) => new DepGraph(data));
    }
    return DepGraph._promise;
  }

  constructor(data) {
    this.modules = data.modules;
    this.external = data.external;
    this.nodes = data.nodes;
    this.byName = new Map(this.nodes.map((nd, i) => [nd.n, i]));
    this._revMeaning = null;
    this._revProof = null;
    this._moduleClusters = null;
  }

  node(i) {
    return this.nodes[i];
  }

  idOf(name) {
    return this.byName.get(name);
  }

  meaningDeps(i) {
    const nd = this.nodes[i];
    return nd.p ? nd.td : nd.td.concat(nd.vd);
  }

  proofDeps(i) {
    const nd = this.nodes[i];
    return nd.td.concat(nd.vd);
  }

  /** External (Mathlib/core) statement dependencies of a node: [name, url|null]. */
  externalTypeDeps(i) {
    const nd = this.nodes[i];
    let ext = nd.xt;
    if (!nd.p) ext = ext.concat(nd.xv);
    return ext.map((e) => this.external[e]);
  }

  _reverse(depsFn) {
    const rev = this.nodes.map(() => []);
    for (let i = 0; i < this.nodes.length; i++) {
      for (const d of depsFn(i)) rev[d].push(i);
    }
    return rev;
  }

  revMeaning() {
    if (!this._revMeaning) this._revMeaning = this._reverse((i) => this.meaningDeps(i));
    return this._revMeaning;
  }

  revProof() {
    if (!this._revProof) this._revProof = this._reverse((i) => this.proofDeps(i));
    return this._revProof;
  }

  /**
   * The dependency closure of `start` (excluded), ordered for reading: every
   * declaration appears before the things it depends on, and ties break
   * shallow-first, then by name. Cycles (mutual definitions) are tolerated.
   *
   * Returns [{id, depth}] where depth is the longest chain from `start`.
   */
  closure(start, depsFn = (i) => this.meaningDeps(i)) {
    const depth = new Map();
    const onPath = new Set();
    const visit = (i, d) => {
      if (onPath.has(i)) return;
      if (depth.has(i) && depth.get(i) >= d) return;
      depth.set(i, Math.max(d, depth.get(i) ?? 0));
      onPath.add(i);
      for (const dep of depsFn(i)) visit(dep, d + 1);
      onPath.delete(i);
    };
    for (const dep of depsFn(start)) visit(dep, 1);
    depth.delete(start);
    return Array.from(depth.entries())
      .map(([id, d]) => ({ id, depth: d }))
      .sort((a, b) => a.depth - b.depth || this.nodes[a.id].n.localeCompare(this.nodes[b.id].n));
  }

  /** The set of node ids whose meaning transitively rests on `start`. */
  dependents(start, rev = this.revMeaning()) {
    const seen = new Set();
    const stack = [...rev[start]];
    while (stack.length) {
      const i = stack.pop();
      if (seen.has(i)) continue;
      seen.add(i);
      for (const j of rev[i]) if (!seen.has(j)) stack.push(j);
    }
    return seen;
  }

  declLink(i) {
    const nd = this.nodes[i];
    const mod = this.modules[nd.m];
    return `${SITE_ROOT}${mod.split(".").join("/")}.html#${nd.n}`;
  }

  moduleLink(m) {
    return `${SITE_ROOT}${this.modules[m].split(".").join("/")}.html`;
  }

  /**
   * A stable partition of all modules into named prefix clusters ("the
   * AgreementL2 stuff", "the NewtonSet stuff", ...), by greedily splitting
   * the largest cluster of a token trie until `maxGroups` is reached.
   * Returns [{label, modules: [modIdx...]}].
   */
  moduleClusters(maxGroups = 14) {
    if (this._moduleClusters) return this._moduleClusters;
    const tokensOf = (name) =>
      name.split(".").flatMap((part) => part.match(/[A-Z][a-z0-9]*|[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [part]);
    const all = this.modules.map((name, idx) => ({ idx, tokens: tokensOf(name) }));
    let groups = [{ prefix: [], members: all }];
    const splittable = (g) => g.members.length > 2 && g.members.some((m) => m.tokens.length > g.prefix.length);
    while (groups.length < maxGroups) {
      groups.sort((a, b) => b.members.length - a.members.length);
      const g = groups.find(splittable);
      if (!g) break;
      const children = new Map();
      for (const m of g.members) {
        const tok = m.tokens[g.prefix.length] ?? "";
        if (!children.has(tok)) children.set(tok, []);
        children.get(tok).push(m);
      }
      if (children.size === 1) {
        g.prefix = g.prefix.concat([children.keys().next().value]);
        continue;
      }
      groups = groups.filter((x) => x !== g);
      for (const [tok, members] of children.entries()) {
        groups.push({ prefix: g.prefix.concat([tok]), members });
      }
    }
    // Drop leading tokens shared by every module (e.g. the project root) from labels.
    let common = 0;
    while (all.length > 1 && all.every((m) => m.tokens[common] === all[0].tokens[common])) common++;
    this._moduleClusters = groups
      .map((g) => ({
        label: g.prefix.length > common ? `${g.prefix.slice(common).join("")}*` : "(other)",
        modules: g.members.map((m) => m.idx).sort((a, b) => a - b),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return this._moduleClusters;
  }

  /**
   * Group a set of affected node ids by module cluster. Returns
   * [{label, affected: [ids], total}] for every cluster, affected-heavy first.
   */
  impactByCluster(affectedIds) {
    const byModule = new Map();
    for (const id of affectedIds) {
      const m = this.nodes[id].m;
      if (!byModule.has(m)) byModule.set(m, []);
      byModule.get(m).push(id);
    }
    const totals = new Map();
    for (const nd of this.nodes) totals.set(nd.m, (totals.get(nd.m) ?? 0) + 1);
    return this.moduleClusters()
      .map((c) => ({
        label: c.label,
        affected: c.modules.flatMap((m) => byModule.get(m) ?? []),
        total: c.modules.reduce((acc, m) => acc + (totals.get(m) ?? 0), 0),
      }))
      .sort((a, b) => b.affected.length - a.affected.length || a.label.localeCompare(b.label));
  }
}

/** Lazily fetched `declarations/header-data.bmp`: name → {header, info}. */
export class HeaderIndex {
  static _promise = null;

  static async init() {
    if (!HeaderIndex._promise) {
      const url = new URL(`${SITE_ROOT}declarations/header-data.bmp`, window.location);
      HeaderIndex._promise = fetch(url)
        .then((res) => res.json())
        .then((data) => new HeaderIndex(data));
    }
    return HeaderIndex._promise;
  }

  constructor(data) {
    this.data = data;
  }

  get(name) {
    return this.data[name];
  }
}

/**
 * Header HTML from header-data.bmp is rendered relative to the site root;
 * rewrite relative links so a fragment can be injected on any page.
 */
export function absolutizeLinks(el) {
  const root = new URL(SITE_ROOT, window.location);
  for (const a of el.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("./") || href.startsWith("../")) {
      a.setAttribute("href", new URL(href, root).href);
    }
  }
}

export function kindBadge(kind) {
  const span = document.createElement("span");
  span.className = `depgraph_kind depgraph_kind_${kind.replace(/ /g, "_")}`;
  span.textContent = kind;
  return span;
}

/** A hoverable ⓘ carrying interpretive guidance, so running copy can stay factual. */
export function infoIcon(text) {
  const s = document.createElement("span");
  s.className = "depgraph_info";
  s.textContent = "ⓘ";
  s.title = text;
  return s;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Render a small layered DAG as an SVG element. Layer 0 is drawn at the top;
 * edges run from a node to nodes in higher layers (its dependencies below it).
 *
 * nodes: [{id, label, title?, href?, kind?, layer, emphasis?, weight?}]
 * edges: [[fromId, toId, weight?]]
 *
 * This is a deliberate anti-hairball: it is only used for graphs that fit on
 * a screen (a statement closure, a cluster map), with layers given by the
 * data, one barycenter pass for crossing reduction, and no interactivity
 * beyond hover-highlighting and click-through.
 */
export function renderDag(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let layers = [];
  for (const n of nodes) {
    (layers[n.layer] ??= []).push(n);
  }
  layers = Array.from(layers, (l) => l ?? []);
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inc = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (byId.has(a) && byId.has(b)) {
      out.get(a).push(b);
      inc.get(b).push(a);
    }
  }

  // Barycenter ordering: two sweeps against the previous layer's positions.
  const posIn = new Map();
  const sortLayer = (layer, neighborsOf) => {
    const bary = (n) => {
      const ns = neighborsOf(n.id).filter((m) => posIn.has(m));
      if (!ns.length) return posIn.get(n.id) ?? 0;
      return ns.reduce((acc, m) => acc + posIn.get(m), 0) / ns.length;
    };
    layer.sort((a, b) => bary(a) - bary(b) || a.label.localeCompare(b.label));
    layer.forEach((n, i) => posIn.set(n.id, i));
  };
  layers[0]?.forEach((n, i) => posIn.set(n.id, i));
  for (let l = 1; l < layers.length; l++) sortLayer(layers[l] ?? [], (id) => inc.get(id));
  for (let l = layers.length - 2; l >= 0; l--) sortLayer(layers[l] ?? [], (id) => out.get(id));

  // Geometry. Layers wider than maxW wrap into multiple rows (a row break
  // within a layer carries no meaning; it only keeps the drawing on screen).
  const charW = 7.2;
  const nodeH = 22;
  const rowH = 64;
  const wrapRowH = 34;
  const gap = 16;
  const maxW = 740;
  const widthOf = (n) => Math.min(200, Math.max(50, n.label.length * charW + 18));
  const rows = [];
  for (const layer of layers) {
    let row = [];
    let w = 0;
    let isWrap = false;
    for (const n of layer) {
      const nw = widthOf(n) + gap;
      if (row.length && w + nw > maxW) {
        rows.push({ nodes: row, isWrap });
        row = [];
        w = 0;
        isWrap = true;
      }
      row.push(n);
      w += nw;
    }
    if (row.length) rows.push({ nodes: row, isWrap });
  }
  const rowWidth = (row) => row.reduce((acc, n) => acc + widthOf(n) + gap, -gap);
  const totalW = Math.min(maxW, Math.max(...rows.map((r) => rowWidth(r.nodes)))) + 20;
  const xy = new Map();
  let y = 6;
  rows.forEach((r, i) => {
    if (i > 0) y += r.isWrap ? wrapRowH : rowH;
    let x = (totalW - rowWidth(r.nodes)) / 2;
    for (const n of r.nodes) {
      xy.set(n.id, { x, y, w: widthOf(n) });
      x += widthOf(n) + gap;
    }
  });
  const totalH = y + nodeH + 12;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${totalW} ${totalH}`);
  svg.setAttribute("width", totalW);
  svg.setAttribute("class", "depgraph_dag");

  const edgeEls = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b, weight] of edges) {
    const pa = xy.get(a);
    const pb = xy.get(b);
    if (!pa || !pb) continue;
    const x1 = pa.x + pa.w / 2;
    const y1 = pa.y + nodeH;
    const x2 = pb.x + pb.w / 2;
    const y2 = pb.y;
    const path = document.createElementNS(SVG_NS, "path");
    const my = (y1 + y2) / 2;
    path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`);
    path.setAttribute("class", "dag_edge" + (byId.get(a).layer >= byId.get(b).layer ? " dag_edge_back" : ""));
    if (weight) path.setAttribute("stroke-width", Math.min(4, 1 + Math.log2(weight) / 2));
    svg.appendChild(path);
    edgeEls.get(a).push(path);
    edgeEls.get(b).push(path);
  }

  for (const n of nodes) {
    const p = xy.get(n.id);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `dag_node dag_kind_${(n.kind ?? "def").replace(/ /g, "_")}` + (n.emphasis ? " dag_emph" : ""));
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", p.x);
    rect.setAttribute("y", p.y);
    rect.setAttribute("width", p.w);
    rect.setAttribute("height", nodeH);
    rect.setAttribute("rx", 5);
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", p.x + p.w / 2);
    text.setAttribute("y", p.y + nodeH / 2 + 4);
    text.setAttribute("text-anchor", "middle");
    text.textContent = n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label;
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = n.title ?? n.label;
    g.append(title, rect, text);
    if (n.href) {
      const a = document.createElementNS(SVG_NS, "a");
      a.setAttribute("href", n.href);
      a.appendChild(g);
      svg.appendChild(a);
    } else {
      svg.appendChild(g);
    }
    g.addEventListener("mouseenter", () => {
      for (const e of edgeEls.get(n.id)) e.classList.add("dag_edge_hot");
    });
    g.addEventListener("mouseleave", () => {
      for (const e of edgeEls.get(n.id)) e.classList.remove("dag_edge_hot");
    });
  }
  return svg;
}

/**
 * The statement-closure DAG for one declaration: the target on top, its
 * transitive statement dependencies layered by distance. Instance nodes are
 * collapsed out (edges route through them to what they use).
 */
export function closureDag(graph, start) {
  const closure = graph.closure(start);
  const inSet = new Map(closure.map(({ id, depth }) => [id, depth]));
  inSet.set(start, 0);
  const keep = (i) => graph.node(i).k !== "instance" || i === start;
  const nodes = [...inSet.entries()]
    .filter(([id]) => keep(id))
    .map(([id, depth]) => ({
      id,
      label: graph.node(id).n.split(".").pop(),
      title: graph.node(id).n,
      href: graph.declLink(id),
      kind: graph.node(id).k,
      layer: depth,
      emphasis: id === start,
    }));
  const edges = [];
  const seen = new Set();
  const targetsOf = (u) => {
    // Route edges through collapsed instance nodes.
    const acc = [];
    const walk = (d, guard) => {
      if (!inSet.has(d) || guard.has(d)) return;
      if (keep(d)) return acc.push(d);
      guard.add(d);
      for (const e of graph.meaningDeps(d)) walk(e, guard);
    };
    for (const d of graph.meaningDeps(u)) walk(d, new Set());
    return acc;
  };
  for (const [u] of inSet.entries()) {
    if (!keep(u)) continue;
    for (const d of targetsOf(u)) {
      const key = `${u},${d}`;
      if (u !== d && !seen.has(key)) {
        seen.add(key);
        edges.push([u, d]);
      }
    }
  }
  return renderDag(nodes, edges);
}
