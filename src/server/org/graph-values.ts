/** The existing complete restored-graph algorithm, without repository/capture I/O.
 * Callers own admission, data, and budgeting. This is not an unknown-value API. */
export type PlannedOrgNode = Readonly<{ id: string; parentId: string | null; role: string }>;
export type OrgGraphValueFailure = Readonly<{ kind: "role-position" | "missing-parent" | "root-count" | "cycle"; nodeId: string | null }>;
export function checkOrgGraphValues(nodes: ReadonlyMap<string, PlannedOrgNode>, check: () => void = () => {}): OrgGraphValueFailure | null {
  let roots = 0;
  for (const node of nodes.values()) {
    check();
    if (!["top_manager", "sub_manager", "member"].includes(node.role) ||
      (node.parentId === null) !== (node.role === "top_manager")) return { kind: "role-position", nodeId: node.id };
    if (node.parentId === null) roots++;
    else if (!nodes.has(node.parentId)) return { kind: "missing-parent", nodeId: node.id };
  }
  if (roots !== (nodes.size === 0 ? 0 : 1)) return { kind: "root-count", nodeId: null };
  const complete = new Set<string>();
  for (const node of nodes.values()) {
    const visiting = new Set<string>();
    let id: string | null = node.id;
    while (id !== null && !complete.has(id)) {
      check();
      if (visiting.has(id)) return { kind: "cycle", nodeId: id };
      visiting.add(id); id = nodes.get(id)!.parentId;
    }
    for (const visited of visiting) complete.add(visited);
  }
  return null;
}
