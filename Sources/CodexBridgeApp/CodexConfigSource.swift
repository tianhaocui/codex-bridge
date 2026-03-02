import Foundation

struct CodexOptions {
    let projects: [String]
    let sessions: [SessionOption]
}

struct SessionOption: Identifiable {
    let id: String
    let preview: String
    let cwd: String?

    var displayLabel: String {
        let shortID = String(id.prefix(8))
        if preview.isEmpty {
            return "\(shortID) - (无首句)"
        }
        return "\(shortID) - \(preview)"
    }
}

enum CodexConfigSource {
    static func loadFromHomeCodex() throws -> CodexOptions {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let codexDir = URL(fileURLWithPath: home).appendingPathComponent(".codex")
        let configPath = codexDir.appendingPathComponent("config.toml").path
        let historyPath = codexDir.appendingPathComponent("history.jsonl").path

        let projects = try parseProjects(from: configPath)
        let sessions = try parseSessions(from: historyPath, codexDir: codexDir)
        return CodexOptions(projects: projects, sessions: sessions)
    }

    private static func parseProjects(from path: String) throws -> [String] {
        let content = try String(contentsOfFile: path, encoding: .utf8)
        let pattern = #"^\s*\[projects\."(.+)"\]\s*$"#
        let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
        let range = NSRange(location: 0, length: (content as NSString).length)
        let matches = regex.matches(in: content, options: [], range: range)

        var projects: [String] = []
        projects.reserveCapacity(matches.count)
        for match in matches {
            guard match.numberOfRanges > 1 else { continue }
            let ns = content as NSString
            var pathValue = ns.substring(with: match.range(at: 1))
            pathValue = pathValue.replacingOccurrences(of: "\\\"", with: "\"")
            if !pathValue.isEmpty {
                projects.append(pathValue)
            }
        }
        return Array(Set(projects)).sorted()
    }

    private static func parseSessions(from path: String, codexDir: URL) throws -> [SessionOption] {
        struct HistoryItem: Decodable {
            let session_id: String
            let ts: Int?
            let text: String?
        }

        let content = try String(contentsOfFile: path, encoding: .utf8)
        var latestTsBySession: [String: Int] = [:]
        var firstTextBySession: [String: String] = [:]

        for line in content.split(separator: "\n") {
            guard let data = line.data(using: .utf8),
                  let item = try? JSONDecoder().decode(HistoryItem.self, from: data),
                  !item.session_id.isEmpty else {
                continue
            }
            let ts = item.ts ?? 0
            if firstTextBySession[item.session_id] == nil {
                let raw = item.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                firstTextBySession[item.session_id] = firstLinePreview(raw)
            }
            latestTsBySession[item.session_id] = max(ts, latestTsBySession[item.session_id] ?? ts)
        }

        let sortedIDs = latestTsBySession
            .map { ($0.key, $0.value) }
            .sorted { lhs, rhs in lhs.1 > rhs.1 }
            .map(\.0)

        if sortedIDs.isEmpty {
            return []
        }

        let topIDs = Array(sortedIDs.prefix(80))
        let cwdBySession = parseSessionCwds(for: Set(topIDs), codexDir: codexDir)
        return topIDs.map { sid in
            SessionOption(id: sid, preview: firstTextBySession[sid] ?? "", cwd: cwdBySession[sid])
        }
    }

    private static func parseSessionCwds(for sessionIDs: Set<String>, codexDir: URL) -> [String: String] {
        struct MetaEnvelope: Decodable {
            let type: String
            let payload: MetaPayload
        }

        struct MetaPayload: Decodable {
            let id: String
            let cwd: String?
        }

        var remaining = sessionIDs
        var result: [String: String] = [:]

        let roots = [
            codexDir.appendingPathComponent("sessions"),
            codexDir.appendingPathComponent("archived_sessions")
        ]

        for root in roots where !remaining.isEmpty {
            guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) else {
                continue
            }
            for case let fileURL as URL in enumerator {
                if remaining.isEmpty { break }
                guard fileURL.pathExtension == "jsonl" else { continue }

                guard let head = readFileHead(fileURL.path, maxBytes: 16_384) else { continue }
                let lines = head.split(separator: "\n", maxSplits: 6, omittingEmptySubsequences: true)
                for line in lines {
                    guard let data = line.data(using: .utf8),
                          let meta = try? JSONDecoder().decode(MetaEnvelope.self, from: data),
                          meta.type == "session_meta",
                          remaining.contains(meta.payload.id) else {
                        continue
                    }
                    if let cwd = meta.payload.cwd {
                        result[meta.payload.id] = cwd
                    }
                    remaining.remove(meta.payload.id)
                    break
                }
            }
        }

        return result
    }

    private static func readFileHead(_ path: String, maxBytes: Int) -> String? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        let data = handle.readData(ofLength: maxBytes)
        return String(data: data, encoding: .utf8)
    }

    private static func firstLinePreview(_ text: String) -> String {
        guard !text.isEmpty else { return "" }
        let line = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let compact = line.replacingOccurrences(of: "\t", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        if compact.count <= 40 {
            return compact
        }
        let idx = compact.index(compact.startIndex, offsetBy: 40)
        return String(compact[..<idx]) + "..."
    }
}
