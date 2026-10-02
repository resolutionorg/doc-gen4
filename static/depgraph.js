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
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
          return res.json();
        })
        .then((data) => new DepGraph(data));
      DepGraph._promise.catch(() => {
        DepGraph._promise = null;
      });
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
    // Label each cluster with the literal longest common prefix of its
    // members' module names, so labels are real name prefixes.
    const lcp = (names) => {
      let p = names[0];
      for (const s of names) {
        let k = 0;
        while (k < p.length && k < s.length && p[k] === s[k]) k++;
        p = p.slice(0, k);
      }
      return p;
    };
    this._moduleClusters = groups
      .map((g) => {
        const names = g.members.map((m) => this.modules[m.idx]);
        const prefix = names.length === 1 ? names[0] : lcp(names);
        return {
          label: names.length === 1 ? names[0] : prefix ? `${prefix}*` : "(other)",
          modules: g.members.map((m) => m.idx).sort((a, b) => a - b),
        };
      })
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
      HeaderIndex._promise = HeaderIndex._load().then((data) => new HeaderIndex(data));
      HeaderIndex._promise.catch(() => {
        HeaderIndex._promise = null;
      });
    }
    return HeaderIndex._promise;
  }

  /**
   * header-data.bmp is minified JSON that compresses ~20x; for large projects it
   * exceeds hosting per-file size limits, so the site build ships a gzipped
   * `header-data.bmp.gz` (decompressed here). Fall back to the plain file for raw
   * doc-gen4 builds that don't post-process.
   */
  static async _load() {
    const gz = new URL(`${SITE_ROOT}declarations/header-data.bmp.gz`, window.location);
    const gzRes = await fetch(gz);
    if (gzRes.ok && gzRes.body) {
      const stream = gzRes.body.pipeThrough(new DecompressionStream("gzip"));
      return new Response(stream).json();
    }
    const url = new URL(`${SITE_ROOT}declarations/header-data.bmp`, window.location);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return res.json();
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

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function kindBadge(kind) {
  return el("span", `depgraph_kind depgraph_kind_${kind.replace(/ /g, "_")}`, kind);
}

/** A hoverable ⓘ carrying interpretive guidance, so running copy can stay factual. */
export function infoIcon(text) {
  const s = el("span", "depgraph_info", "ⓘ");
  s.title = text;
  return s;
}

export const SVG_NS = "http://www.w3.org/2000/svg";

export function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

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

  const svg = svgEl("svg", {
    viewBox: `0 0 ${totalW} ${totalH}`,
    width: totalW,
    class: "depgraph_dag",
  });

  const edgeEls = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, b, weight] of edges) {
    const pa = xy.get(a);
    const pb = xy.get(b);
    if (!pa || !pb) continue;
    const x1 = pa.x + pa.w / 2;
    const y1 = pa.y + nodeH;
    const x2 = pb.x + pb.w / 2;
    const y2 = pb.y;
    const my = (y1 + y2) / 2;
    const path = svgEl("path", {
      d: `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`,
      class: "dag_edge" + (byId.get(a).layer >= byId.get(b).layer ? " dag_edge_back" : ""),
    });
    if (weight) path.setAttribute("stroke-width", Math.min(4, 1 + Math.log2(weight) / 2));
    svg.appendChild(path);
    edgeEls.get(a).push(path);
    edgeEls.get(b).push(path);
  }

  for (const n of nodes) {
    const p = xy.get(n.id);
    const g = svgEl("g", {
      class: `dag_node dag_kind_${(n.kind ?? "def").replace(/ /g, "_")}` + (n.emphasis ? " dag_emph" : ""),
    });
    const rect = svgEl("rect", { x: p.x, y: p.y, width: p.w, height: nodeH, rx: 5 });
    const text = svgEl("text", {
      x: p.x + p.w / 2,
      y: p.y + nodeH / 2 + 4,
      "text-anchor": "middle",
    });
    text.textContent = n.label.length > 26 ? n.label.slice(0, 25) + "…" : n.label;
    const title = svgEl("title", {});
    title.textContent = n.title ?? n.label;
    g.append(title, rect, text);
    if (n.href) {
      const a = svgEl("a", { href: n.href });
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
 * Deterministic force-directed layout (Fruchterman–Reingold). Positions are
 * computed once, synchronously — the drawing is static. Initial positions lie
 * on a golden-angle spiral so layouts are reproducible run to run.
 *
 * nodes: array (only its length is used); edges: [[i, j, weight?], ...].
 * Returns {x, y, size} with coordinates in [0, size]².
 */
export function forceLayout(nodes, edges, iterations = 400) {
  const n = nodes.length;
  // Bound main-thread time on large graphs by scaling down the iteration count.
  const iters = n <= 300 ? iterations : Math.max(80, Math.round((iterations * 300) / n));
  const size = Math.max(420, Math.ceil(Math.sqrt(n) * 95));
  const k = Math.sqrt((size * size) / Math.max(1, n));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963;
    const r = (size / 2.5) * Math.sqrt((i + 0.5) / n);
    x[i] = size / 2 + r * Math.cos(a);
    y[i] = size / 2 + r * Math.sin(a);
  }
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const ew = edges.map(([, , w]) => 1 + Math.log2(1 + (w ?? 1)));
  // Repulsion is cut off beyond 2.5k; without a cutoff the summed repulsion of
  // n nodes exceeds gravity at any distance and the periphery diverges.
  const cut2 = 2.5 * k * (2.5 * k);
  let temp = size / 8;
  for (let it = 0; it < iters; it++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i] - x[j];
        let ddy = y[i] - y[j];
        let d2 = ddx * ddx + ddy * ddy;
        if (d2 > cut2) continue;
        if (d2 < 0.01) {
          ddx = 0.011 * (i - j);
          ddy = 0.013;
          d2 = ddx * ddx + ddy * ddy;
        }
        const rep = (k * k) / d2;
        dx[i] += ddx * rep;
        dy[i] += ddy * rep;
        dx[j] -= ddx * rep;
        dy[j] -= ddy * rep;
      }
    }
    edges.forEach(([a, b], e) => {
      const ddx = x[a] - x[b];
      const ddy = y[a] - y[b];
      const att = (Math.sqrt(ddx * ddx + ddy * ddy) / k) * 0.06 * ew[e];
      dx[a] -= ddx * att;
      dy[a] -= ddy * att;
      dx[b] += ddx * att;
      dy[b] += ddy * att;
    });
    for (let i = 0; i < n; i++) {
      dx[i] += (size / 2 - x[i]) * 0.03;
      dy[i] += (size / 2 - y[i]) * 0.03;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const cap = Math.min(d, temp);
      x[i] += (dx[i] / d) * cap;
      y[i] += (dy[i] / d) * cap;
    }
    temp *= 0.985;
  }
  return { x, y, size };
}

/**
 * The statement-closure DAG for one declaration: the target on top, its
 * transitive statement dependencies layered by distance. Instance nodes are
 * collapsed out (edges route through them to what they use).
 *
 * Returns null when a DAG would not help: fewer than 2 non-instance nodes in
 * the closure, or more than 80 nodes total (a hairball).
 */
export function closureDag(graph, start) {
  const closure = graph.closure(start);
  const nonInstance = closure.filter(({ id }) => graph.node(id).k !== "instance").length;
  if (nonInstance < 2 || closure.length > 80) return null;
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
