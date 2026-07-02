/**
 * timaeus fork: inline dep-atlas panels on declaration pages.
 *
 * Every rendered declaration gets two mutually exclusive toggles next to its
 * source link:
 *
 * - "deps": the statement closure — every local declaration this statement's
 *   meaning rests on, as a small layered DAG plus a list in reading order
 *   (each entry before the things it depends on) with full signatures, plus
 *   the external (Mathlib/core) frontier.
 * - "used by": every declaration whose statement transitively references this
 *   one, grouped into module clusters so the answer reads "the X and Y stuff,
 *   not the Z stuff".
 */

import { DepGraph, HeaderIndex, absolutizeLinks, kindBadge, infoIcon, closureDag } from "./depgraph.js";

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function extChip(name, url) {
  if (url) {
    const a = el("a", "depgraph_ext_chip");
    a.href = url;
    a.appendChild(el("code", null, name));
    return a;
  }
  const s = el("span", "depgraph_ext_chip depgraph_ext_unresolved");
  s.appendChild(el("code", null, name));
  return s;
}

function declItem(graph, headers, id, depth) {
  const nd = graph.node(id);
  const item = el("div", "depgraph_item");
  item.dataset.name = nd.n;
  if (depth !== undefined) item.style.setProperty("--depgraph-depth", depth);
  const meta = el("span", "depgraph_item_meta");
  if (nd.s) meta.appendChild(el("span", "depgraph_sorried", "sorry"));
  const mod = el("a", "depgraph_item_mod", graph.modules[nd.m]);
  mod.href = graph.moduleLink(nd.m);
  meta.appendChild(mod);
  item.appendChild(meta);
  const entry = headers.get(nd.n);
  if (entry) {
    // The signature already shows the kind and the linked name.
    const sig = el("div", "depgraph_item_sig");
    sig.innerHTML = entry.header;
    absolutizeLinks(sig);
    item.appendChild(sig);
    const doc = (entry.info.doc || "").trim();
    if (doc) {
      const firstPara = doc.split(/\n\s*\n/)[0].replace(/\s+/g, " ");
      item.appendChild(el("div", "depgraph_item_doc", firstPara));
    }
  } else {
    const head = el("div", "depgraph_item_head");
    head.appendChild(kindBadge(nd.k));
    const a = el("a", "depgraph_item_name");
    a.href = graph.declLink(id);
    a.appendChild(el("code", null, nd.n));
    head.appendChild(a);
    item.appendChild(head);
  }
  return item;
}

export function buildDepsPanel(graph, headers, id, { dag = true } = {}) {
  const panel = el("div", "depgraph_panel");
  const closure = graph.closure(id);
  const main = closure.filter(({ id: i }) => graph.node(i).k !== "instance");
  const instances = closure.filter(({ id: i }) => graph.node(i).k === "instance");
  const externals = graph.externalTypeDeps(id);

  const intro = el("div", "depgraph_panel_intro");
  intro.appendChild(el("strong", null, "Statement dependencies"));
  intro.appendChild(
    document.createTextNode(
      main.length === 0
        ? " — none within this project."
        : ` — ${main.length + instances.length} declaration${main.length + instances.length === 1 ? "" : "s"} \
referenced by this statement, directly or transitively, nearest first.`
    )
  );
  intro.appendChild(
    infoIcon(
      "The transitive closure of constants appearing in this statement's " +
        "signature, followed through the bodies of definitions (a definition's " +
        "body is part of its meaning) but not through proofs. Together these " +
        "determine what the statement says."
    )
  );
  panel.appendChild(intro);

  if (dag && main.length > 1 && closure.length <= 80) {
    const wrap = el("div", "atlas_dag_wrap");
    wrap.appendChild(closureDag(graph, id));
    panel.appendChild(wrap);
  }

  for (const { id: i, depth } of main) {
    panel.appendChild(declItem(graph, headers, i, depth));
  }

  if (instances.length > 0) {
    const details = el("details", "depgraph_instances");
    details.appendChild(el("summary", null, `instances involved (${instances.length})`));
    for (const { id: i } of instances) {
      details.appendChild(declItem(graph, headers, i));
    }
    panel.appendChild(details);
  }

  if (externals.length > 0) {
    const ext = el("div", "depgraph_externals");
    ext.appendChild(el("span", "depgraph_ext_label", "beyond this project (Mathlib/core): "));
    for (const [name, url] of externals.sort((a, b) => a[0].localeCompare(b[0]))) {
      ext.appendChild(extChip(name, url));
    }
    panel.appendChild(ext);
  }

  panel.appendChild(atlasFooter(graph, id));
  enableCrossHighlight(panel);
  return panel;
}

export function buildImpactPanel(graph, id) {
  const panel = el("div", "depgraph_panel");
  const meaning = graph.dependents(id);
  const proofOnly = new Set(
    [...graph.dependents(id, graph.revProof())].filter((i) => !meaning.has(i))
  );

  const intro = el("div", "depgraph_panel_intro");
  intro.appendChild(el("strong", null, "Statement dependents"));
  const parts = [];
  if (meaning.size === 0) {
    parts.push(" — none: no other statement references this declaration.");
  } else {
    parts.push(
      ` — ${meaning.size} declaration${meaning.size === 1 ? "" : "s"} reference \
this one in their statements, directly or transitively.`
    );
  }
  if (proofOnly.size > 0) {
    parts.push(` ${proofOnly.size} more reference it only inside proofs.`);
  }
  intro.appendChild(document.createTextNode(parts.join("")));
  intro.appendChild(
    infoIcon(
      "Statement dependents inherit this declaration's meaning: were it not to " +
        "say what was intended, their statements would be affected too. " +
        "Proof-only dependents are unaffected in meaning — only their proofs " +
        "route through this declaration."
    )
  );
  panel.appendChild(intro);

  if (meaning.size > 0) {
    const clusters = graph.impactByCluster(meaning);
    const untouched = clusters.filter((c) => c.affected.length === 0 && c.total > 0);
    for (const c of clusters) {
      if (c.affected.length === 0) continue;
      const row = el("details", "depgraph_cluster");
      const summary = el("summary");
      const label = el("span", "depgraph_cluster_label", c.label);
      label.title = c.label;
      summary.appendChild(label);
      summary.appendChild(el("span", "depgraph_cluster_count", `${c.affected.length} / ${c.total}`));
      const bar = el("span", "depgraph_cluster_bar");
      const fill = el("span", "depgraph_cluster_fill");
      fill.style.width = `${Math.round((100 * c.affected.length) / c.total)}%`;
      bar.appendChild(fill);
      summary.appendChild(bar);
      row.appendChild(summary);
      const list = el("div", "depgraph_cluster_list");
      for (const i of c.affected.sort((a, b) => graph.node(a).n.localeCompare(graph.node(b).n))) {
        const a = el("a", "depgraph_cluster_item");
        a.href = graph.declLink(i);
        a.appendChild(el("code", null, graph.node(i).n));
        list.appendChild(a);
      }
      row.appendChild(list);
      panel.appendChild(row);
    }
    if (untouched.length > 0) {
      panel.appendChild(
        el(
          "div",
          "depgraph_untouched",
          `none in: ${untouched.map((c) => c.label).join(", ")}`
        )
      );
    }
  }

  panel.appendChild(atlasFooter(graph, id));
  return panel;
}

function atlasFooter(graph, id) {
  const footer = el("div", "depgraph_panel_footer");
  const a = el("a", null, "open in dependency atlas →");
  a.href = `${SITE_ROOT}atlas.html#decl=${encodeURIComponent(graph.node(id).n)}`;
  footer.appendChild(a);
  return footer;
}

/** Hovering a name inside a signature highlights that name's entry in the panel. */
function enableCrossHighlight(panel) {
  let lit = null;
  panel.addEventListener("mouseover", (ev) => {
    const a = ev.target.closest("a[href]");
    if (lit) lit.classList.remove("depgraph_lit");
    lit = null;
    if (!a || !panel.contains(a)) return;
    const frag = a.href.split("#")[1];
    if (!frag) return;
    const target = panel.querySelector(`.depgraph_item[data-name="${CSS.escape(frag)}"]`);
    if (target && !target.contains(a)) {
      target.classList.add("depgraph_lit");
      lit = target;
    }
  });
}

function addToggles(graph, declDiv) {
  const name = declDiv.id;
  const id = graph.idOf(name);
  if (id === undefined) return;
  const inner = declDiv.firstElementChild;
  const gh = inner?.querySelector(":scope > .gh_link");
  if (!inner || !gh) return;

  const box = el("div", "depgraph_toggles");
  const panels = {};
  const btns = {};
  let open = null;
  const setOpen = async (label, build) => {
    if (open === label) {
      panels[label].style.display = "none";
      btns[label].classList.remove("depgraph_toggle_on");
      open = null;
      return;
    }
    if (open) {
      panels[open].style.display = "none";
      btns[open].classList.remove("depgraph_toggle_on");
    }
    open = label;
    btns[label].classList.add("depgraph_toggle_on");
    if (!panels[label]) {
      panels[label] = await build();
      inner.appendChild(panels[label]);
    } else {
      panels[label].style.display = "";
    }
  };
  const mkToggle = (label, build) => {
    const btn = el("a", "depgraph_toggle", label);
    btn.href = "javascript:void(0)";
    btn.addEventListener("click", () => setOpen(label, build));
    btns[label] = btn;
    box.appendChild(btn);
  };
  mkToggle("deps", async () => buildDepsPanel(graph, await HeaderIndex.init(), id));
  mkToggle("used by", async () => buildImpactPanel(graph, id));
  gh.after(box);
}

if (document.querySelector("div.decl")) {
  DepGraph.init().then((graph) => {
    for (const declDiv of document.querySelectorAll("div.decl[id]")) {
      addToggles(graph, declDiv);
    }
  }).catch((err) => console.warn("dep atlas unavailable:", err));
}
