import { MadgeModuleDependencyGraph } from "madge"

export function findAllDependencies(graph: Map<string, Set<string>>, name: string, oldGraph: Map<string, Set<string>>) {
  const result = new Map(graph.entries())

  const resolveOneDependency = (dep: string): Set<string> => {
    if (result.get(dep)) {
      return result.get(dep)!
    }

    if (!graph.get(dep)) {
      return oldGraph.get(dep) ?? new Set()
    }

    const dependencies = new Set([dep])
    for (const dependency of graph.get(dep)!) {
      for (const res of resolveOneDependency(dependency)) {
        dependencies.add(res)
      }
    }

    return dependencies
  }

  resolveOneDependency(name)

  return result
}

function madgeToMap(graph: MadgeModuleDependencyGraph): Map<string, Set<string>> {
  return new Map(Object.entries(graph).map(([key, value]) => [key, new Set(value)]))
}

export class DependencyGraph {
  nodes: Map<string, Node>

  constructor(madgeGraph: MadgeModuleDependencyGraph) {
    const graph = madgeToMap(madgeGraph)
    this.nodes = new Map()

    // Creates nodes
    for (const name of graph.keys()) {
      this.nodes.set(name, new Node(name))
    }

    // Creates dependsOn & dependencies
    for (const [name, dependencies] of graph.entries()) {
      const node = this.getNode(name)

      node.addDependencies(...[...dependencies].map(dep => this.getNode(dep)))

      for (const dependency of dependencies) {
        this.nodes.get(dependency)!.dependsOn.add(node)
      }
    }
  }

  /**
   * Get a node from the graph.
   * 
   * @param name The name of the node to get.
   * @returns The node.
   * @throws If the node doesn't exist.
   */
  getNode(name: string): Node {
    const node = this.nodes.get(name)
    if (!node) {
      throw new Error(`Node ${name} not found`)
    }

    return node
  }

  /**
   * Merge two dependency graphs.
   * Changes the current graph.
   * 
   * @param graph The graph to merge with.
   * 
   * @returns The current graph, modified.
   */
  merge(graph: DependencyGraph) {
    // Merge nodes
    for (const [name, node] of this.nodes.entries()) {
      try {
        const newNode = graph.getNode(name)

        // Set the current node's dependencies to the new node's dependencies
        node.dependencies.clear()
        for (const dependency of newNode.dependencies) {
          node.dependencies.add(this.getNode(dependency.name))
        }

        // Set the current node's dependsOn to the new node's dependsOn
        node.dependsOn.clear()
        for (const dependsOn of newNode.dependsOn) {
          node.dependsOn.add(this.getNode(dependsOn.name))
        }
      }
      catch (e) {
        // Nothing to do: the new graph does not have this node. It's fine, because the new graph is a subset of entire graph.
      }
    }

    // Add nodes that don't exist yet
    const newNodes = []
    for (const [name, node] of graph.nodes.entries()) {
      if (!this.nodes.has(name)) {
        this.nodes.set(name, node)
        newNodes.push(node)
      }
    }

    // Update dependencies/dependsOn to reference old nodes
    for (const node of newNodes) {
      const dependencies = [...node.dependencies]
      node.dependencies.clear()
      for (const dependency of dependencies) {
        node.dependencies.add(this.getNode(dependency.name))
      }

      const dependsOn = [...node.dependsOn]
      node.dependsOn.clear()
      for (const dependsOnNode of dependsOn) {
        node.dependsOn.add(this.getNode(dependsOnNode.name))
      }
    }

    return graph
  }

  /**
   * Delete a node from the graph.
   * 
   * @param name The name of the node to delete.
   */
  delete(name: string) {
    const node = this.getNode(name)

    for (const dependency of node.dependencies) {
      dependency.dependsOn.delete(node)
    }

    for (const dependsOn of node.dependsOn) {
      dependsOn.dependencies.delete(node)
    }

    this.nodes.delete(name)
  }

  toString() {
    let result = ''

    for (const [name, node] of this.nodes.entries()) {
      result += name + '\n'
      result += `Depends on   : ${[...node.getDependencies({ recursive: true })].map(n => `"${n.toString()}`)}\n`
      result += `Dependency of: ${[...node.getDependsOn({ recursive: true })].map(n => `"${n.toString()}"`)}\n\n`
    }

    return result
  }
}

class Node {
  name: string
  dependencies: Set<Node>
  dependsOn: Set<Node>

  // Used to avoid infinite recursion
  protected traversed: boolean

  constructor(name: string) {
    this.name = name
    this.dependencies = new Set()
    this.dependsOn = new Set()
    this.traversed = false
  }

  addDependencies(...nodes: Node[]) {
    for (const node of nodes) {
      this.dependencies.add(node)
    }
  }

  addDependsOn(...nodes: Node[]) {
    for (const node of nodes) {
      this.dependsOn.add(node)
    }
  }

  getDependencies(opts: { recursive?: boolean, includeSelf?: boolean }): Set<Node> {
    const result = new Set<Node>()

    if (opts.includeSelf) {
      result.add(this)
    }

    if (this.traversed) {
      return result
    }

    this.traversed = true

    // Recursively get all dependencies if recursive is true
    if (opts.recursive) {
      for (const dependency of this.dependencies) {
        for (const dep of dependency.getDependencies({ recursive: true, includeSelf: true })) {
          result.add(dep)
        }
      }
    }

    this.traversed = false
    return result
  }

  getDependsOn(opts: { recursive?: boolean, includeSelf?: boolean }): Set<Node> {
    const result = new Set<Node>()

    if (opts.includeSelf) {
      result.add(this)
    }

    if (this.traversed) {
      return result
    }

    this.traversed = true

    // Recursively get all dependencies if recursive is true
    if (opts.recursive) {
      for (const parent of this.dependsOn) {
        for (const dep of parent.getDependsOn({ recursive: true, includeSelf: true })) {
          result.add(dep)
        }
      }
    }

    this.traversed = false
    return result
  }

  toString() {
    return this.name
  }
}