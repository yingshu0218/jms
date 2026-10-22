import Foundation

enum NodeBrowser {
    static func rows(_ nodes: [Node], search: String, protocolFilter: String, sort: String, latency: [String: NodeLatency]) -> [(Int, Node)] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        let rows = nodes.enumerated().compactMap { index, node -> (Int, Node)? in
            guard protocolFilter == "all" || node.type == protocolFilter else { return nil }
            guard query.isEmpty || node.name.localizedCaseInsensitiveContains(query) || node.server.localizedCaseInsensitiveContains(query) else { return nil }
            return (index, node)
        }
        return rows.sorted { left, right in
            if sort == "name" {
                let order = left.1.name.localizedStandardCompare(right.1.name)
                return order == .orderedSame ? left.0 < right.0 : order == .orderedAscending
            }
            if sort == "latency" {
                let a = latency[String(left.0)]; let b = latency[String(right.0)]
                let x = a?.ok == true ? a?.delay ?? Int.max : Int.max
                let y = b?.ok == true ? b?.delay ?? Int.max : Int.max
                return x == y ? left.0 < right.0 : x < y
            }
            return left.0 < right.0
        }
    }
}
