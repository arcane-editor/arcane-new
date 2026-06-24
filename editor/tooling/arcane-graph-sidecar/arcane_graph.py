"""arcane-graph: a thin Python wrapper around graphify's structural extraction.

This is the sidecar binary bundled with the Arcane IDE. It exposes a tight
CLI surface that the Tauri Rust backend invokes:

    arcane-graph build <workspace> --out <graph.json>
    arcane-graph query <graph.json> <question> [--budget N] [--dfs]
    arcane-graph explain <graph.json> <node>
    arcane-graph path <graph.json> <node-a> <node-b>
    arcane-graph summary <graph.json>
    arcane-graph version

The build subcommand runs AST extraction only. It deliberately skips
graphify's semantic LLM step because the bundled binary has no subagent
runtime and we don't ask the user for any API keys.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

VERSION = "0.1.0"


def _emit_progress(msg: str) -> None:
    """Single-line progress event to stdout. The Rust side streams these."""
    print(f"[arcane-graph] {msg}", flush=True)


def cmd_build(args: argparse.Namespace) -> None:
    from graphify.detect import detect
    from graphify.extract import collect_files, extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.analyze import god_nodes
    from graphify.export import to_json

    workspace = Path(args.workspace).resolve()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Optional --root narrows scanning to a subdirectory. Useful for Unity
    # (Assets/) and any monorepo where most of the tree is non-code.
    scan_root = workspace
    if getattr(args, "root", None):
        candidate = (workspace / args.root).resolve()
        if candidate.is_dir():
            scan_root = candidate
            _emit_progress(f"scoping to {candidate.relative_to(workspace) if candidate != workspace else '.'}")
        else:
            _emit_progress(f"warn: --root {args.root!r} not found; scanning whole workspace")

    _emit_progress(f"scanning {scan_root}")
    detection = detect(scan_root)

    code_files: list[Path] = []
    for f in detection.get("files", {}).get("code", []):
        path = Path(f)
        if path.is_dir():
            code_files.extend(collect_files(path))
        else:
            code_files.append(path)

    # Optional --include-ext filters to a whitelist (e.g. .cs only for Unity).
    if getattr(args, "include_ext", None):
        wanted = set()
        for e in args.include_ext:
            normalized = e.lower()
            if not normalized.startswith("."):
                normalized = "." + normalized
            wanted.add(normalized)
        before = len(code_files)
        code_files = [p for p in code_files if p.suffix.lower() in wanted]
        _emit_progress(
            f"filtered to {len(code_files)}/{before} files matching {sorted(wanted)}"
        )

    if not code_files:
        _emit_progress("no code files found")
        # Write an empty graph so the frontend can distinguish "built" from "absent".
        out_path.write_text(json.dumps({"directed": False, "multigraph": False, "graph": {}, "nodes": [], "links": []}))
        _write_summary(out_path, nodes=0, edges=0, communities=0, god_nodes_list=[])
        print(json.dumps({"nodes": 0, "edges": 0, "communities": 0}), flush=True)
        return

    _emit_progress(f"extracting from {len(code_files)} code files (AST-only)")
    # AST cache lives next to the graph; a rebuild reuses it where possible.
    cache_root = out_path.parent / ".ast-cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    # Force sequential extraction. graphify's parallel mode spawns multiprocessing
    # workers, which collide with PyInstaller's frozen-binary fork semantics on
    # macOS and produce a flurry of harmless-but-scary "tracker_fd" warnings on
    # stderr (which we stream to the IDE). Sequential is plenty fast for AST.
    try:
        extraction = extract(code_files, cache_root=cache_root, parallel=False)
    except TypeError:
        # Older graphify versions don't accept parallel=False; let it run and
        # catch the BrokenProcessPool path internally.
        extraction = extract(code_files, cache_root=cache_root)

    G = build_from_json(extraction)
    if G.number_of_nodes() == 0:
        _emit_progress("graph is empty after extraction")
        sys.exit(2)

    _emit_progress(f"clustering {G.number_of_nodes()} nodes")
    communities = cluster(G)
    god_nodes_list = god_nodes(G)

    to_json(G, communities, str(out_path))
    _write_summary(
        out_path,
        nodes=G.number_of_nodes(),
        edges=G.number_of_edges(),
        communities=len(communities),
        god_nodes_list=god_nodes_list,
    )

    # Final line on stdout — Rust parses this as the JSON build result.
    print(
        json.dumps(
            {
                "nodes": G.number_of_nodes(),
                "edges": G.number_of_edges(),
                "communities": len(communities),
            }
        ),
        flush=True,
    )


def _write_summary(
    out_path: Path,
    *,
    nodes: int,
    edges: int,
    communities: int,
    god_nodes_list: list[dict[str, Any]],
) -> None:
    summary_path = out_path.with_suffix(".summary.json")
    god_labels = []
    for g in god_nodes_list[:12]:
        if isinstance(g, dict):
            god_labels.append({"label": g.get("label"), "source_file": g.get("source_file")})
    summary_path.write_text(
        json.dumps(
            {
                "nodes": nodes,
                "edges": edges,
                "communities": communities,
                "god_nodes": god_labels,
                "graph_path": str(out_path),
            },
            indent=2,
        )
    )


def _load_graph(graph_path: str):
    import networkx as nx  # noqa: F401  # used via json_graph
    from networkx.readwrite import json_graph

    data = json.loads(Path(graph_path).read_text())
    return json_graph.node_link_graph(data, edges="links")


def cmd_query(args: argparse.Namespace) -> None:
    G = _load_graph(args.graph)
    question = args.question
    terms = [t.lower() for t in question.split() if len(t) > 3]

    scored: list[tuple[int, str]] = []
    for nid, ndata in G.nodes(data=True):
        label = ndata.get("label", "").lower()
        score = sum(1 for t in terms if t in label)
        if score > 0:
            scored.append((score, nid))
    scored.sort(reverse=True)
    start_nodes = [nid for _, nid in scored[:3]]

    if not start_nodes:
        print(f"No graph nodes matched: {terms}")
        return

    subgraph_nodes: set[str] = set()
    subgraph_edges: list[tuple[str, str]] = []

    if args.dfs:
        visited: set[str] = set()
        stack: list[tuple[str, int]] = [(n, 0) for n in reversed(start_nodes)]
        while stack:
            node, depth = stack.pop()
            if node in visited or depth > 6:
                continue
            visited.add(node)
            subgraph_nodes.add(node)
            for neighbor in G.neighbors(node):
                if neighbor not in visited:
                    stack.append((neighbor, depth + 1))
                    subgraph_edges.append((node, neighbor))
    else:
        frontier: set[str] = set(start_nodes)
        subgraph_nodes = set(start_nodes)
        for _ in range(3):
            next_frontier: set[str] = set()
            for n in frontier:
                for neighbor in G.neighbors(n):
                    if neighbor not in subgraph_nodes:
                        next_frontier.add(neighbor)
                        subgraph_edges.append((n, neighbor))
            subgraph_nodes.update(next_frontier)
            frontier = next_frontier

    char_budget = args.budget * 4

    def relevance(nid: str) -> int:
        label = G.nodes[nid].get("label", "").lower()
        return sum(1 for t in terms if t in label)

    ranked = sorted(subgraph_nodes, key=relevance, reverse=True)
    lines = [
        f"Traversal: {'DFS' if args.dfs else 'BFS'} | "
        f"Start: {[G.nodes[n].get('label', n) for n in start_nodes]} | "
        f"{len(subgraph_nodes)} nodes",
    ]
    for nid in ranked:
        d = G.nodes[nid]
        lines.append(
            f"  NODE {d.get('label', nid)} "
            f"[src={d.get('source_file', '')} loc={d.get('source_location', '')}]"
        )
    for u, v in subgraph_edges:
        if u in subgraph_nodes and v in subgraph_nodes:
            d = G.edges[u, v]
            lines.append(
                f"  EDGE {G.nodes[u].get('label', u)} --{d.get('relation', '')} "
                f"[{d.get('confidence', '')}]--> {G.nodes[v].get('label', v)}"
            )

    out = "\n".join(lines)
    if len(out) > char_budget:
        out = out[:char_budget] + f"\n... (truncated at ~{args.budget} token budget)"
    print(out)


def cmd_explain(args: argparse.Namespace) -> None:
    G = _load_graph(args.graph)
    term = args.node.lower()
    scored = sorted(
        [
            (sum(1 for w in term.split() if w in G.nodes[n].get("label", "").lower()), n)
            for n in G.nodes()
        ],
        reverse=True,
    )
    if not scored or scored[0][0] == 0:
        print(f"No graph node matching: {args.node}")
        return
    nid = scored[0][1]
    data_n = G.nodes[nid]
    lines = [
        f"NODE: {data_n.get('label', nid)}",
        f"  source: {data_n.get('source_file', 'unknown')}",
        f"  type: {data_n.get('file_type', 'unknown')}",
        f"  degree: {G.degree(nid)}",
        "",
        "CONNECTIONS:",
    ]
    for neighbor in G.neighbors(nid):
        edge = G.edges[nid, neighbor]
        nlabel = G.nodes[neighbor].get("label", neighbor)
        rel = edge.get("relation", "")
        conf = edge.get("confidence", "")
        src_file = G.nodes[neighbor].get("source_file", "")
        lines.append(f"  --{rel}--> {nlabel} [{conf}] ({src_file})")
    print("\n".join(lines))


def cmd_path(args: argparse.Namespace) -> None:
    import networkx as nx

    G = _load_graph(args.graph)

    def find_node(term: str) -> str | None:
        term = term.lower()
        scored = sorted(
            [
                (sum(1 for w in term.split() if w in G.nodes[n].get("label", "").lower()), n)
                for n in G.nodes()
            ],
            reverse=True,
        )
        return scored[0][1] if scored and scored[0][0] > 0 else None

    src = find_node(args.a)
    tgt = find_node(args.b)
    if not src or not tgt:
        print(f"Could not find graph node matching: {args.a!r} or {args.b!r}")
        return
    try:
        path = nx.shortest_path(G, src, tgt)
        lines = [f"Shortest path ({len(path) - 1} hops):"]
        for i, nid in enumerate(path):
            label = G.nodes[nid].get("label", nid)
            if i < len(path) - 1:
                edge = G.edges[nid, path[i + 1]]
                rel = edge.get("relation", "")
                conf = edge.get("confidence", "")
                lines.append(f"  {label} --{rel}--> [{conf}]")
            else:
                lines.append(f"  {label}")
        print("\n".join(lines))
    except nx.NetworkXNoPath:
        print(f"No path between {args.a!r} and {args.b!r}")
    except nx.NodeNotFound as e:
        print(f"Node not found: {e}")


def cmd_summary(args: argparse.Namespace) -> None:
    summary_path = Path(args.graph).with_suffix(".summary.json")
    if summary_path.exists():
        print(summary_path.read_text())
        return
    # Regenerate from the graph file.
    from graphify.analyze import god_nodes

    G = _load_graph(args.graph)
    god_nodes_list = god_nodes(G)
    summary = {
        "nodes": G.number_of_nodes(),
        "edges": G.number_of_edges(),
        "communities": 0,
        "god_nodes": [
            {"label": g.get("label"), "source_file": g.get("source_file")}
            for g in god_nodes_list[:12]
            if isinstance(g, dict)
        ],
        "graph_path": str(Path(args.graph).resolve()),
    }
    print(json.dumps(summary, indent=2))


def cmd_version(_args: argparse.Namespace) -> None:
    print(VERSION)


def main() -> None:
    parser = argparse.ArgumentParser(prog="arcane-graph")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="Build the AST-only code graph for a workspace.")
    p_build.add_argument("workspace")
    p_build.add_argument("--out", required=True)
    p_build.add_argument(
        "--root",
        default=None,
        help="Restrict scanning to this subdirectory of <workspace> (e.g. 'Assets' for Unity).",
    )
    p_build.add_argument(
        "--include-ext",
        action="append",
        default=None,
        metavar=".EXT",
        dest="include_ext",
        help="Repeatable. If any provided, only code files with these extensions are extracted.",
    )

    p_query = sub.add_parser("query", help="Traverse the graph for a free-text question.")
    p_query.add_argument("graph")
    p_query.add_argument("question")
    p_query.add_argument("--budget", type=int, default=2000)
    p_query.add_argument("--dfs", action="store_true")

    p_explain = sub.add_parser("explain", help="Describe a node and its neighbors.")
    p_explain.add_argument("graph")
    p_explain.add_argument("node")

    p_path = sub.add_parser("path", help="Shortest path between two named concepts.")
    p_path.add_argument("graph")
    p_path.add_argument("a")
    p_path.add_argument("b")

    p_summary = sub.add_parser("summary", help="Emit summary JSON (god nodes, counts).")
    p_summary.add_argument("graph")

    sub.add_parser("version", help="Print sidecar version.")

    args = parser.parse_args()
    handlers = {
        "build": cmd_build,
        "query": cmd_query,
        "explain": cmd_explain,
        "path": cmd_path,
        "summary": cmd_summary,
        "version": cmd_version,
    }
    handlers[args.cmd](args)


if __name__ == "__main__":
    main()
