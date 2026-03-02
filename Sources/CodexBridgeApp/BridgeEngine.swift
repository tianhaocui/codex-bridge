import Foundation
import SwiftUI

@MainActor
final class BridgeEngine: ObservableObject {
    enum Side: String, Codable, CaseIterable {
        case a = "A"
        case b = "B"

        var opposite: Side { self == .a ? .b : .a }
    }

    enum Role: String, Codable {
        case user
        case assistant
        case system
    }

    struct ChatItem: Identifiable, Codable {
        let id: UUID
        let time: Date
        let side: Side?
        let role: Role
        let turnId: String?
        let text: String
    }

    struct ChannelConfig {
        let aProjectPath: String
        let aSessionID: String
        let bProjectPath: String
        let bSessionID: String

        func endpoint(for side: Side) -> (projectPath: String, sessionID: String) {
            switch side {
            case .a: return (aProjectPath, aSessionID)
            case .b: return (bProjectPath, bSessionID)
            }
        }
    }

    struct TurnDiffState: Codable {
        var turnId: String = ""
        var diff: String = ""
        var files: [String] = []
    }

    struct ReasoningSummaryEntry: Identifiable, Codable {
        let side: Side
        let turnId: String
        let summaryIndex: Int
        var text: String

        var id: String { "\(side.rawValue)-\(turnId)-\(summaryIndex)" }
    }

    struct TaskBoard: Codable {
        var todo: [String] = []
        var inProgress: [String] = []
        var done: [String] = []
        var blocker: [String] = []
    }

    struct SnapshotMeta: Identifiable, Hashable {
        let id: String
        let createdAt: Date
        let reason: String
        let summary: String
    }

    struct DiffFilterOptions {
        var additionsOnly = false
        var deletionsOnly = false
        var fileExtension = ""
        var keyword = ""
    }

    @Published var chatItems: [ChatItem] = []
    @Published var isSendingA = false
    @Published var isSendingB = false
    @Published var autoRelayEnabled = false
    @Published var stopOnStageDone = true
    @Published var stageDoneMarkers = #"{"bridge_stage":"done"},任务完成,阶段完成,阶段性完成,无需继续,结束对话,END_OF_TASK,[DONE]"#
    @Published var diffStateA = TurnDiffState()
    @Published var diffStateB = TurnDiffState()
    @Published var reasoningA: [ReasoningSummaryEntry] = []
    @Published var reasoningB: [ReasoningSummaryEntry] = []

    @Published var taskBoard = TaskBoard()
    @Published var historySnapshots: [SnapshotMeta] = []
    @Published var relayTurnCount = 0
    @Published var lastErrorA = ""
    @Published var lastErrorB = ""
    @Published var lastSuccessA: Date?
    @Published var lastSuccessB: Date?

    private var interruptedSides: Set<Side> = []

    private let workerA = CodexPersistentWorker(label: "A")
    private let workerB = CodexPersistentWorker(label: "B")
    private let stageJSONPattern = #"^\s*\{\s*"bridge_stage"\s*:\s*"(done|continue)"\s*\}\s*$"#
    private let snapshotEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private let snapshotDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
    private lazy var snapshotRootDir: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent(".codex-bridge", isDirectory: true)
            .appendingPathComponent("logs", isDirectory: true)
    }()

    private struct PersistedSnapshot: Codable {
        let id: String
        let createdAt: Date
        let reason: String
        let summary: String?
        let chatItems: [ChatItem]
        let diffStateA: TurnDiffState
        let diffStateB: TurnDiffState
        let reasoningA: [ReasoningSummaryEntry]
        let reasoningB: [ReasoningSummaryEntry]
        let relayTurnCount: Int
        let lastErrorA: String
        let lastErrorB: String
        let lastSuccessA: Date?
        let lastSuccessB: Date?
        let taskBoard: TaskBoard
    }

    private enum StageSignal: String {
        case done
        case `continue`
    }

    init() {
        ensureSnapshotDirectory()
        loadSnapshotMetas()
    }

    deinit {
        workerA.shutdown()
        workerB.shutdown()
    }

    func sendToA(message: String, config: ChannelConfig) {
        send(to: .a, message: message, config: config, initiatedByRelay: false)
    }

    func sendToB(message: String, config: ChannelConfig) {
        send(to: .b, message: message, config: config, initiatedByRelay: false)
    }

    func interruptA() {
        interruptConversation()
    }

    func interruptB() {
        interruptConversation()
    }

    func interruptConversation() {
        interruptedSides.insert(.a)
        interruptedSides.insert(.b)
        autoRelayEnabled = false

        workerA.interrupt()
        workerB.interrupt()

        appendSystem("已中断双向对话，自动互发已关闭", to: nil)
        persistSnapshot(reason: "interrupt")
    }

    func messages(for side: Side) -> [ChatItem] {
        chatItems.filter { $0.side == side || $0.side == nil }
    }

    func transcriptText(for side: Side) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return messages(for: side).map { item in
            let time = formatter.string(from: item.time)
            switch item.role {
            case .user:
                return "[\(time)] 你 -> \(side.rawValue): \(item.text)"
            case .assistant:
                return "[\(time)] \(side.rawValue): \(item.text)"
            case .system:
                return "[\(time)] 系统: \(item.text)"
            }
        }.joined(separator: "\n")
    }

    func clear() {
        chatItems.removeAll()
        diffStateA = TurnDiffState()
        diffStateB = TurnDiffState()
        reasoningA = []
        reasoningB = []
        relayTurnCount = 0
        lastErrorA = ""
        lastErrorB = ""
        lastSuccessA = nil
        lastSuccessB = nil
        taskBoard = TaskBoard()
        persistSnapshot(reason: "clear")
    }

    func diffState(for side: Side) -> TurnDiffState {
        switch side {
        case .a: return diffStateA
        case .b: return diffStateB
        }
    }

    func diffText(for side: Side, file: String?) -> String {
        let full = diffState(for: side).diff
        guard let file, !file.isEmpty else {
            return full.isEmpty ? "(暂无改动)" : full
        }
        let section = extractDiffBlock(for: file, from: full)
        return section.isEmpty ? "(该文件暂无可展示 diff)" : section
    }

    func filteredFiles(for side: Side, fileExtension: String) -> [String] {
        let ext = normalizedExtension(fileExtension)
        guard !ext.isEmpty else { return diffState(for: side).files }
        return diffState(for: side).files.filter { $0.lowercased().hasSuffix(ext.lowercased()) }
    }

    func filteredDiffText(for side: Side, file: String?, options: DiffFilterOptions) -> String {
        let base = diffText(for: side, file: file)
        if base == "(暂无改动)" || base == "(该文件暂无可展示 diff)" { return base }

        let ext = normalizedExtension(options.fileExtension)
        let keyword = options.keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        let blocks = splitDiffBlocks(from: base)
        var outputBlocks: [String] = []
        for block in blocks {
            if let extFile = block.filePath, !ext.isEmpty, !extFile.lowercased().hasSuffix(ext.lowercased()) {
                continue
            }
            if !keyword.isEmpty, !block.content.lowercased().contains(keyword) {
                continue
            }

            let filtered = filterBlockLines(
                block.content,
                additionsOnly: options.additionsOnly,
                deletionsOnly: options.deletionsOnly
            )

            if filtered.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                continue
            }
            outputBlocks.append(filtered)
        }

        if outputBlocks.isEmpty { return "(筛选后无结果)" }
        return outputBlocks.joined(separator: "\n\n")
    }

    func reasoningEntries(for side: Side) -> [ReasoningSummaryEntry] {
        switch side {
        case .a: return reasoningA
        case .b: return reasoningB
        }
    }

    func reasoningText(side: Side, turnId: String) -> String {
        let entries = reasoningEntries(for: side)
            .filter { $0.turnId == turnId }
            .sorted { lhs, rhs in
                if lhs.summaryIndex == rhs.summaryIndex {
                    return lhs.text.count < rhs.text.count
                }
                return lhs.summaryIndex < rhs.summaryIndex
            }
        guard !entries.isEmpty else { return "" }
        return entries
            .map { "#\($0.summaryIndex) \($0.text)" }
            .joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func replaySnapshot(id: String) -> String? {
        let path = snapshotRootDir.appendingPathComponent("\(id).json")
        guard let data = try? Data(contentsOf: path),
              let snapshot = try? snapshotDecoder.decode(PersistedSnapshot.self, from: data) else {
            return "回放失败：未找到快照"
        }

        chatItems = snapshot.chatItems
        diffStateA = snapshot.diffStateA
        diffStateB = snapshot.diffStateB
        reasoningA = snapshot.reasoningA
        reasoningB = snapshot.reasoningB
        relayTurnCount = snapshot.relayTurnCount
        lastErrorA = snapshot.lastErrorA
        lastErrorB = snapshot.lastErrorB
        lastSuccessA = snapshot.lastSuccessA
        lastSuccessB = snapshot.lastSuccessB
        taskBoard = snapshot.taskBoard

        return "已回放快照 \(id)（\(snapshot.reason)）"
    }

    private func send(to side: Side, message: String, config: ChannelConfig, initiatedByRelay: Bool) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendSystem("发送失败：消息为空", to: side)
            return
        }

        if isSending(side) {
            appendSystem("\(side.rawValue) 忙碌中，稍后再试", to: side)
            return
        }

        let endpoint = config.endpoint(for: side)
        let path = endpoint.projectPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else {
            appendSystem("发送失败：\(side.rawValue) 项目路径为空", to: side)
            return
        }

        interruptedSides.remove(side)

        if !initiatedByRelay {
            relayTurnCount = 0
            append(.init(id: UUID(), time: Date(), side: side, role: .user, turnId: nil, text: trimmed))
        } else {
            relayTurnCount += 1
            appendSystem("自动转发到 \(side.rawValue)（Relay #\(relayTurnCount)）", to: side)
        }

        setSending(side, true)

        let assistantID = UUID()
        append(.init(id: assistantID, time: Date(), side: side, role: .assistant, turnId: nil, text: ""))

        let worker = worker(for: side)
        let outboundMessage = composeOutboundMessage(
            baseMessage: trimmed,
            enforceStageProtocol: autoRelayEnabled && stopOnStageDone
        )

        worker.send(
            message: outboundMessage,
            cwd: path,
            resumeThreadId: endpoint.sessionID,
            onDelta: { [weak self] chunk in
                Task { @MainActor in
                    self?.appendToAssistantMessage(id: assistantID, chunk: chunk)
                }
            },
            onDiff: { [weak self] turnId, diff in
                Task { @MainActor in
                    self?.updateDiffState(side: side, turnId: turnId, diff: diff)
                }
            },
            onReasoningSummary: { [weak self] turnId, summaryIndex, delta in
                Task { @MainActor in
                    self?.bindTurnID(turnId, toMessage: assistantID)
                    self?.appendReasoningSummary(side: side, turnId: turnId, summaryIndex: summaryIndex, delta: delta)
                }
            },
            onDone: { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    defer { self.setSending(side, false) }

                    switch result {
                    case .failure(let error):
                        self.interruptedSides.remove(side)
                        self.updateHealthFailure(for: side, error: error)
                        self.appendSystem("\(side.rawValue) 执行失败：\(error.localizedDescription)", to: side)
                        self.persistSnapshot(reason: "failure-\(side.rawValue.lowercased())")

                    case .success(let finalReply):
                        self.updateHealthSuccess(for: side)
                        self.upsertAssistantMessage(id: assistantID, side: side, text: finalReply)

                        if self.interruptedSides.contains(side) {
                            self.interruptedSides.remove(side)
                            self.appendSystem("\(side.rawValue) 已中断，停止自动转发", to: side)
                            self.persistSnapshot(reason: "interrupted-\(side.rawValue.lowercased())")
                            return
                        }

                        let stageSignal = self.parseStageSignal(from: finalReply)
                        if self.autoRelayEnabled && self.stopOnStageDone {
                            if stageSignal == .done || (stageSignal == nil && self.isStageDoneByMarker(finalReply)) {
                                self.autoRelayEnabled = false
                                self.appendSystem("检测到阶段性任务完成，已自动停止互发", to: nil)
                                self.persistSnapshot(reason: "stage-done")
                                return
                            }
                            if stageSignal == nil {
                                self.appendSystem("提示：未检测到标准阶段 JSON（最后一行应为 {\"bridge_stage\":\"done|continue\"}）", to: side)
                            }
                        }

                        if self.autoRelayEnabled {
                            let relayPayload = self.sanitizedRelayPayload(from: finalReply)
                            if self.isRelayWorthy(relayPayload) {
                                let target = side.opposite
                                self.send(to: target, message: relayPayload, config: config, initiatedByRelay: true)
                            }
                        }

                        self.persistSnapshot(reason: "turn-\(side.rawValue.lowercased())")
                    }
                }
            }
        )
    }

    private func worker(for side: Side) -> CodexPersistentWorker {
        switch side {
        case .a: return workerA
        case .b: return workerB
        }
    }

    private func append(_ item: ChatItem) {
        chatItems.append(item)
        recalcTaskBoard()
    }

    private func appendSystem(_ text: String, to side: Side?) {
        chatItems.append(.init(id: UUID(), time: Date(), side: side, role: .system, turnId: nil, text: text))
        recalcTaskBoard()
    }

    private func upsertAssistantMessage(id: UUID, side: Side, text: String) {
        if let idx = chatItems.firstIndex(where: { $0.id == id }) {
            chatItems[idx] = ChatItem(
                id: id,
                time: chatItems[idx].time,
                side: side,
                role: .assistant,
                turnId: chatItems[idx].turnId,
                text: text
            )
            recalcTaskBoard()
            return
        }
        chatItems.append(.init(id: id, time: Date(), side: side, role: .assistant, turnId: nil, text: text))
        recalcTaskBoard()
    }

    private func appendToAssistantMessage(id: UUID, chunk: String) {
        guard !chunk.isEmpty else { return }
        if let idx = chatItems.firstIndex(where: { $0.id == id }) {
            let item = chatItems[idx]
            chatItems[idx] = ChatItem(
                id: item.id,
                time: item.time,
                side: item.side,
                role: item.role,
                turnId: item.turnId,
                text: item.text + chunk
            )
        }
    }

    private func bindTurnID(_ turnId: String, toMessage messageID: UUID) {
        guard let idx = chatItems.firstIndex(where: { $0.id == messageID }) else { return }
        let old = chatItems[idx]
        if old.turnId == turnId { return }
        chatItems[idx] = ChatItem(
            id: old.id,
            time: old.time,
            side: old.side,
            role: old.role,
            turnId: turnId,
            text: old.text
        )
    }

    private func setSending(_ side: Side, _ sending: Bool) {
        switch side {
        case .a: isSendingA = sending
        case .b: isSendingB = sending
        }
    }

    private func isSending(_ side: Side) -> Bool {
        switch side {
        case .a: return isSendingA
        case .b: return isSendingB
        }
    }

    private func isRelayWorthy(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return false }
        if trimmed == "(空回复)" { return false }
        return true
    }

    private func isStageDoneByMarker(_ text: String) -> Bool {
        let normalized = text.lowercased()
        let markers = stageDoneMarkers
            .split(whereSeparator: { $0 == "," || $0 == "\n" || $0 == ";" || $0 == "|" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        for marker in markers where normalized.contains(marker.lowercased()) {
            return true
        }
        return false
    }

    private func parseStageSignal(from text: String) -> StageSignal? {
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard let lastLine = lines.last else { return nil }

        guard let regex = try? NSRegularExpression(pattern: stageJSONPattern),
              regex.firstMatch(
                in: lastLine,
                range: NSRange(lastLine.startIndex..<lastLine.endIndex, in: lastLine)
              ) != nil else {
            return nil
        }

        guard let data = lastLine.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object.count == 1,
              let value = object["bridge_stage"] as? String else {
            return nil
        }

        return StageSignal(rawValue: value.lowercased())
    }

    private func composeOutboundMessage(baseMessage: String, enforceStageProtocol: Bool) -> String {
        guard enforceStageProtocol else { return baseMessage }

        return """
        \(baseMessage)

        [Bridge 控制协议]
        - 回复最后一行必须是且仅是单行 JSON：{"bridge_stage":"continue"} 或 {"bridge_stage":"done"}
        - 除该 JSON 外，最后一行不允许出现其他字符。
        """
    }

    private func sanitizedRelayPayload(from text: String) -> String {
        let lines = text.split(whereSeparator: \.isNewline).map(String.init)
        guard let lastIndex = lines.indices.last else { return text }
        let lastTrimmed = lines[lastIndex].trimmingCharacters(in: .whitespacesAndNewlines)

        guard let regex = try? NSRegularExpression(pattern: stageJSONPattern),
              regex.firstMatch(
                in: lastTrimmed,
                range: NSRange(lastTrimmed.startIndex..<lastTrimmed.endIndex, in: lastTrimmed)
              ) != nil else {
            return text
        }

        var kept = lines
        kept.removeLast()
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func updateDiffState(side: Side, turnId: String, diff: String) {
        let files = extractFiles(fromUnifiedDiff: diff)
        let state = TurnDiffState(turnId: turnId, diff: diff, files: files)
        switch side {
        case .a: diffStateA = state
        case .b: diffStateB = state
        }
    }

    private func extractFiles(fromUnifiedDiff diff: String) -> [String] {
        var files: [String] = []
        for line in diff.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix("+++ b/") {
                let path = String(line.dropFirst("+++ b/".count))
                if path != "/dev/null", !path.isEmpty, !files.contains(path) {
                    files.append(path)
                }
            }
        }
        return files
    }

    private func extractDiffBlock(for file: String, from fullDiff: String) -> String {
        guard !fullDiff.isEmpty else { return "" }
        let lines = fullDiff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [String] = []
        var current: [String] = []

        func flush() {
            guard !current.isEmpty else { return }
            let joined = current.joined(separator: "\n")
            if joined.contains("+++ b/\(file)") || joined.contains("--- a/\(file)") || joined.contains(" b/\(file)\n") {
                blocks.append(joined)
            }
            current.removeAll(keepingCapacity: true)
        }

        for line in lines {
            if line.hasPrefix("diff --git ") {
                flush()
            }
            current.append(line)
        }
        flush()

        return blocks.joined(separator: "\n\n")
    }

    private func appendReasoningSummary(side: Side, turnId: String, summaryIndex: Int, delta: String) {
        guard !delta.isEmpty else { return }
        switch side {
        case .a:
            upsertReasoning(in: &reasoningA, side: side, turnId: turnId, summaryIndex: summaryIndex, delta: delta)
        case .b:
            upsertReasoning(in: &reasoningB, side: side, turnId: turnId, summaryIndex: summaryIndex, delta: delta)
        }
    }

    private func upsertReasoning(
        in list: inout [ReasoningSummaryEntry],
        side: Side,
        turnId: String,
        summaryIndex: Int,
        delta: String
    ) {
        if let idx = list.firstIndex(where: { $0.turnId == turnId && $0.summaryIndex == summaryIndex }) {
            list[idx].text += delta
            return
        }
        list.append(.init(side: side, turnId: turnId, summaryIndex: summaryIndex, text: delta))
    }

    private func splitDiffBlocks(from diffText: String) -> [(filePath: String?, content: String)] {
        let lines = diffText.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var blocks: [String] = []
        var current: [String] = []

        func flush() {
            guard !current.isEmpty else { return }
            blocks.append(current.joined(separator: "\n"))
            current.removeAll(keepingCapacity: true)
        }

        for line in lines {
            if line.hasPrefix("diff --git "), !current.isEmpty {
                flush()
            }
            current.append(line)
        }
        flush()

        return blocks.map { block in
            let path = block
                .split(separator: "\n")
                .first(where: { $0.hasPrefix("+++ b/") })
                .map { String($0.dropFirst("+++ b/".count)) }
            return (filePath: path, content: block)
        }
    }

    private func filterBlockLines(_ block: String, additionsOnly: Bool, deletionsOnly: Bool) -> String {
        guard additionsOnly || deletionsOnly else { return block }

        let lines = block.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var output: [String] = []
        for line in lines {
            let keepHeader = line.hasPrefix("diff --git ")
                || line.hasPrefix("index ")
                || line.hasPrefix("--- ")
                || line.hasPrefix("+++ ")
                || line.hasPrefix("@@")
            if keepHeader {
                output.append(line)
                continue
            }

            if additionsOnly && line.hasPrefix("+") && !line.hasPrefix("+++") {
                output.append(line)
            }
            if deletionsOnly && line.hasPrefix("-") && !line.hasPrefix("---") {
                output.append(line)
            }
        }

        let hasChangeLine = output.contains { line in
            (line.hasPrefix("+") && !line.hasPrefix("+++"))
            || (line.hasPrefix("-") && !line.hasPrefix("---"))
        }
        return hasChangeLine ? output.joined(separator: "\n") : ""
    }

    private func normalizedExtension(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.hasPrefix(".") ? trimmed : ".\(trimmed)"
    }

    private func updateHealthFailure(for side: Side, error: Error) {
        switch side {
        case .a: lastErrorA = error.localizedDescription
        case .b: lastErrorB = error.localizedDescription
        }
    }

    private func updateHealthSuccess(for side: Side) {
        switch side {
        case .a:
            lastErrorA = ""
            lastSuccessA = Date()
        case .b:
            lastErrorB = ""
            lastSuccessB = Date()
        }
    }

    private func recalcTaskBoard() {
        var board = TaskBoard()

        for item in chatItems where item.role != .user {
            for line in item.text.split(whereSeparator: \.isNewline).map(String.init) {
                let task = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !task.isEmpty else { continue }

                if let payload = captureTask(task, pattern: #"^\s*-\s*\[\s\]\s*(.+)$"#) {
                    appendUnique(payload, to: &board.todo)
                    continue
                }
                if let payload = captureTask(task, pattern: #"^\s*-\s*\[[xX]\]\s*(.+)$"#) {
                    appendUnique(payload, to: &board.done)
                    continue
                }
                if let payload = captureTask(task, pattern: #"(?i)^\s*(todo|待办|待完成)[:：]\s*(.+)$"#, group: 2) {
                    appendUnique(payload, to: &board.todo)
                    continue
                }
                if let payload = captureTask(task, pattern: #"(?i)^\s*(in[\s-]?progress|进行中|处理中)[:：]\s*(.+)$"#, group: 2) {
                    appendUnique(payload, to: &board.inProgress)
                    continue
                }
                if let payload = captureTask(task, pattern: #"(?i)^\s*(done|已完成|完成)[:：]\s*(.+)$"#, group: 2) {
                    appendUnique(payload, to: &board.done)
                    continue
                }
                if let payload = captureTask(task, pattern: #"(?i)^\s*(blocker|阻塞|卡点|风险)[:：]\s*(.+)$"#, group: 2) {
                    appendUnique(payload, to: &board.blocker)
                    continue
                }
            }
        }

        taskBoard = board
    }

    private func captureTask(_ line: String, pattern: String, group: Int = 1) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, range: range),
              match.numberOfRanges > group,
              let payloadRange = Range(match.range(at: group), in: line) else {
            return nil
        }
        return line[payloadRange].trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func appendUnique(_ value: String, to list: inout [String]) {
        guard !value.isEmpty, !list.contains(value) else { return }
        list.append(value)
    }

    private func ensureSnapshotDirectory() {
        try? FileManager.default.createDirectory(at: snapshotRootDir, withIntermediateDirectories: true)
    }

    private func persistSnapshot(reason: String) {
        let id = snapshotID()
        let summary = buildSnapshotSummary(reason: reason)
        let snapshot = PersistedSnapshot(
            id: id,
            createdAt: Date(),
            reason: reason,
            summary: summary,
            chatItems: chatItems,
            diffStateA: diffStateA,
            diffStateB: diffStateB,
            reasoningA: reasoningA,
            reasoningB: reasoningB,
            relayTurnCount: relayTurnCount,
            lastErrorA: lastErrorA,
            lastErrorB: lastErrorB,
            lastSuccessA: lastSuccessA,
            lastSuccessB: lastSuccessB,
            taskBoard: taskBoard
        )

        guard let data = try? snapshotEncoder.encode(snapshot) else { return }

        let jsonURL = snapshotRootDir.appendingPathComponent("\(id).json")
        let transcriptURL = snapshotRootDir.appendingPathComponent("\(id).txt")
        try? data.write(to: jsonURL, options: .atomic)
        try? fullTranscriptForSnapshot().write(to: transcriptURL, atomically: true, encoding: .utf8)

        historySnapshots.insert(.init(id: id, createdAt: snapshot.createdAt, reason: reason, summary: summary), at: 0)
        if historySnapshots.count > 200 {
            historySnapshots = Array(historySnapshots.prefix(200))
        }
    }

    private func loadSnapshotMetas() {
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: snapshotRootDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            historySnapshots = []
            return
        }

        let jsonFiles = items.filter { $0.pathExtension == "json" }
        let metas: [SnapshotMeta] = jsonFiles.compactMap { url in
            guard let data = try? Data(contentsOf: url),
                  let snapshot = try? snapshotDecoder.decode(PersistedSnapshot.self, from: data) else {
                return nil
            }
            let summary = snapshot.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
            return .init(
                id: snapshot.id,
                createdAt: snapshot.createdAt,
                reason: snapshot.reason,
                summary: (summary?.isEmpty == false) ? summary! : "无描述"
            )
        }
        historySnapshots = metas.sorted(by: { $0.createdAt > $1.createdAt })
    }

    private func buildSnapshotSummary(reason: String) -> String {
        let latestUser = chatItems.last(where: { $0.role == .user })?.text ?? ""
        let latestAssistant = chatItems.last(where: { $0.role == .assistant })?.text ?? ""
        let compactUser = compactPreview(latestUser)
        let compactAssistant = compactPreview(latestAssistant)
        let diffFiles = Set(diffStateA.files + diffStateB.files).count

        if !compactUser.isEmpty {
            return "\(reason) | 用户: \(compactUser) | 变更文件:\(diffFiles)"
        }
        if !compactAssistant.isEmpty {
            return "\(reason) | 回复: \(compactAssistant) | 变更文件:\(diffFiles)"
        }
        return "\(reason) | 变更文件:\(diffFiles)"
    }

    private func compactPreview(_ text: String) -> String {
        let normalized = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\t", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return "" }
        if normalized.count <= 42 { return normalized }
        let idx = normalized.index(normalized.startIndex, offsetBy: 42)
        return String(normalized[..<idx]) + "..."
    }

    private func snapshotID() -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return formatter.string(from: Date())
    }

    private func fullTranscriptForSnapshot() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"

        return chatItems.map { item in
            let t = formatter.string(from: item.time)
            switch item.role {
            case .user:
                return "[\(t)] USER(\(item.side?.rawValue ?? "?")): \(item.text)"
            case .assistant:
                return "[\(t)] ASSISTANT(\(item.side?.rawValue ?? "?")): \(item.text)"
            case .system:
                return "[\(t)] SYSTEM: \(item.text)"
            }
        }.joined(separator: "\n")
    }

}
