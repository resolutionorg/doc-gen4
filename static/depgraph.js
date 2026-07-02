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
