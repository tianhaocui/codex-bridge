@preconcurrency import Foundation

final class CodexPersistentWorker: @unchecked Sendable {
    enum WorkerError: LocalizedError {
        case startup(String)
        case protocolError(String)
        case terminated

        var errorDescription: String? {
            switch self {
            case .startup(let msg): return msg
            case .protocolError(let msg): return msg
            case .terminated: return "Codex 常驻连接已终止"
            }
        }
    }

    private let queue: DispatchQueue
    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?

    private var outBuffer = Data()
    private var errBuffer = Data()

    private var nextRequestID = 1
    private var pending: [String: (Result<[String: Any], Error>) -> Void] = [:]

    private var threadId: String?
    private var activeTurnId: String?
    private var configuredCwd: String?
    private var configuredResumeId: String?

    private var streamingText = ""
    private var activeDelta: ((String) -> Void)?
    private var activeDiff: ((String, String) -> Void)?
    private var activeReasoningSummary: ((String, Int, String) -> Void)?
    private var activeDone: ((Result<String, Error>) -> Void)?

    init(label: String) {
        self.queue = DispatchQueue(label: "codex.worker.\(label)")
    }

    func send(
        message: String,
        cwd: String,
        resumeThreadId: String?,
        onDelta: @escaping @Sendable (String) -> Void,
        onDiff: @escaping @Sendable (String, String) -> Void,
        onReasoningSummary: @escaping @Sendable (String, Int, String) -> Void,
        onDone: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        queue.async {
            self.ensureReady(cwd: cwd, resumeThreadId: resumeThreadId) { ready in
                switch ready {
                case .failure(let error):
                    onDone(.failure(error))
                case .success:
                    self.startTurn(
                        message: message,
                        onDelta: onDelta,
                        onDiff: onDiff,
                        onReasoningSummary: onReasoningSummary,
                        onDone: onDone
                    )
                }
            }
        }
    }

    func interrupt() {
        queue.async {
            guard let tid = self.threadId, let turnId = self.activeTurnId else { return }
            self.sendRequest(method: "turn/interrupt", params: [
                "threadId": tid,
                "turnId": turnId
            ]) { _ in }
        }
    }

    func shutdown() {
        queue.async {
            self.cleanupProcess()
            self.failActiveTurn(with: WorkerError.terminated)
        }
    }

    private func ensureReady(cwd: String, resumeThreadId: String?, completion: @escaping @Sendable (Result<Void, Error>) -> Void) {
        let normalizedResume = resumeThreadId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resume = (normalizedResume?.isEmpty == false) ? normalizedResume : nil

        if process != nil,
           threadId != nil,
           configuredCwd == cwd,
           configuredResumeId == resume {
            completion(.success(()))
            return
        }

        cleanupProcess()
        threadId = nil
        activeTurnId = nil
        configuredCwd = cwd
        configuredResumeId = resume

        do {
            try startProcess()
        } catch {
            completion(.failure(error))
            return
        }

        sendRequest(method: "initialize", params: [
            "clientInfo": [
                "name": "codex-bridge-macapp",
                "version": "0.1.0"
            ],
            "capabilities": [
                "experimentalApi": true
            ]
        ]) { initResult in
            switch initResult {
            case .failure(let error):
                completion(.failure(error))
            case .success:
                if let resume {
                    self.sendRequest(method: "thread/resume", params: [
                        "threadId": resume,
                        "cwd": cwd,
                        "approvalPolicy": "never",
                        "sandbox": "workspace-write"
                    ]) { resumeResult in
                        switch resumeResult {
                        case .failure(let error):
                            completion(.failure(error))
                        case .success(let result):
                            self.threadId = Self.extractThreadID(from: result) ?? resume
                            completion(.success(()))
                        }
                    }
                } else {
                    self.sendRequest(method: "thread/start", params: [
                        "cwd": cwd,
                        "approvalPolicy": "never",
                        "sandbox": "workspace-write"
                    ]) { startResult in
                        switch startResult {
                        case .failure(let error):
                            completion(.failure(error))
                        case .success(let result):
                            guard let tid = Self.extractThreadID(from: result) else {
                                completion(.failure(WorkerError.protocolError("thread/start 未返回 thread.id")))
                                return
                            }
                            self.threadId = tid
                            completion(.success(()))
                        }
                    }
                }
            }
        }
    }

    private func startTurn(
        message: String,
        onDelta: @escaping @Sendable (String) -> Void,
        onDiff: @escaping @Sendable (String, String) -> Void,
        onReasoningSummary: @escaping @Sendable (String, Int, String) -> Void,
        onDone: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        guard let tid = threadId else {
            onDone(.failure(WorkerError.protocolError("thread 未初始化")))
            return
        }
        if activeDone != nil {
            onDone(.failure(WorkerError.protocolError("当前已有进行中的 turn")))
            return
        }

        streamingText = ""
        activeDelta = onDelta
        activeDiff = onDiff
        activeReasoningSummary = onReasoningSummary
        activeDone = onDone
        activeTurnId = nil

        sendRequest(method: "turn/start", params: [
            "threadId": tid,
            "input": [
                [
                    "type": "text",
                    "text": message
                ]
            ]
        ]) { result in
            switch result {
            case .failure(let error):
                self.failActiveTurn(with: error)
            case .success(let response):
                if let turn = response["turn"] as? [String: Any],
                   let turnID = turn["id"] as? String {
                    self.activeTurnId = turnID
                }
            }
        }
    }

    private func startProcess() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["codex", "app-server", "--listen", "stdio://"]

        let inPipe = Pipe()
        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardInput = inPipe
        process.standardOutput = outPipe
        process.standardError = errPipe

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty { return }
            self.queue.async {
                self.consumeStdout(data)
            }
        }

        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty { return }
            self.queue.async {
                self.consumeStderr(data)
            }
        }

        process.terminationHandler = { [weak self] _ in
            guard let self else { return }
            self.queue.async {
                self.cleanupProcess()
                self.failActiveTurn(with: WorkerError.terminated)
            }
        }

        try process.run()

        self.process = process
        self.stdinHandle = inPipe.fileHandleForWriting
        self.stdoutHandle = outPipe.fileHandleForReading
        self.stderrHandle = errPipe.fileHandleForReading
    }

    private func cleanupProcess() {
        stdoutHandle?.readabilityHandler = nil
        stderrHandle?.readabilityHandler = nil

        if let process {
            process.terminationHandler = nil
            if process.isRunning {
                process.terminate()
            }
        }

        process = nil
        stdinHandle = nil
        stdoutHandle = nil
        stderrHandle = nil
        outBuffer.removeAll(keepingCapacity: false)
        errBuffer.removeAll(keepingCapacity: false)
        pending.removeAll(keepingCapacity: false)
    }

    private func sendRequest(method: String, params: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        let requestID = nextRequestID
        nextRequestID += 1
        pending[String(requestID)] = completion

        let payload: [String: Any] = [
            "jsonrpc": "2.0",
            "id": requestID,
            "method": method,
            "params": params
        ]

        do {
            try sendJSONObject(payload)
        } catch {
            pending.removeValue(forKey: String(requestID))
            completion(.failure(error))
        }
    }

    private func sendJSONObject(_ object: [String: Any]) throws {
        guard let stdinHandle else {
            throw WorkerError.startup("app-server stdin 不可用")
        }
        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        var line = data
        line.append(0x0A)
        stdinHandle.write(line)
    }

    private func consumeStdout(_ data: Data) {
        outBuffer.append(data)
        while let idx = outBuffer.firstIndex(of: 0x0A) {
            let lineData = outBuffer.subdata(in: 0..<idx)
            outBuffer.removeSubrange(0...idx)
            guard !lineData.isEmpty else { continue }
            handleJSONLine(lineData)
        }
    }

    private func consumeStderr(_ data: Data) {
        errBuffer.append(data)
    }

    private func handleJSONLine(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = obj as? [String: Any] else {
            return
        }

        if let id = dict["id"] {
            let key = String(describing: id)
            let completion = pending.removeValue(forKey: key)
            if let errorObj = dict["error"] as? [String: Any] {
                let message = (errorObj["message"] as? String) ?? "未知错误"
                completion?(.failure(WorkerError.protocolError(message)))
            } else if let result = dict["result"] as? [String: Any] {
                completion?(.success(result))
            } else {
                completion?(.success([:]))
            }
            return
        }

        guard let method = dict["method"] as? String,
              let params = dict["params"] as? [String: Any] else {
            return
        }

        switch method {
        case "item/agentMessage/delta":
            let notifThread = params["threadId"] as? String
            let turnId = params["turnId"] as? String
            guard notifThread == threadId else { return }
            if let activeTurnId, let turnId, activeTurnId != turnId { return }
            if let delta = params["delta"] as? String, !delta.isEmpty {
                streamingText += delta
                activeDelta?(delta)
            }

        case "turn/diff/updated":
            let notifThread = params["threadId"] as? String
            let turnId = params["turnId"] as? String
            guard notifThread == threadId else { return }
            if let activeTurnId, let turnId, activeTurnId != turnId { return }
            if let diff = params["diff"] as? String, let turnId {
                activeDiff?(turnId, diff)
            }

        case "item/reasoning/summaryTextDelta":
            let notifThread = params["threadId"] as? String
            let turnId = params["turnId"] as? String
            guard notifThread == threadId else { return }
            if let activeTurnId, let turnId, activeTurnId != turnId { return }
            if let delta = params["delta"] as? String,
               let turnId,
               let summaryIndex = params["summaryIndex"] as? Int {
                activeReasoningSummary?(turnId, summaryIndex, delta)
            }

        case "turn/started":
            let notifThread = params["threadId"] as? String
            guard notifThread == threadId else { return }
            if let turn = params["turn"] as? [String: Any], let id = turn["id"] as? String {
                activeTurnId = id
            }

        case "turn/completed":
            let notifThread = params["threadId"] as? String
            guard notifThread == threadId else { return }
            if let activeTurnId, let turn = params["turn"] as? [String: Any], let tid = turn["id"] as? String, tid != activeTurnId {
                return
            }
            completeActiveTurnSuccessfully()

        case "error":
            let notifThread = params["threadId"] as? String
            guard notifThread == threadId else { return }
            let errObj = params["error"] as? [String: Any]
            let message = (errObj?["message"] as? String) ?? "未知错误"
            let willRetry = (params["willRetry"] as? Bool) ?? false
            if !willRetry {
                failActiveTurn(with: WorkerError.protocolError(message))
            }

        default:
            break
        }
    }

    private func completeActiveTurnSuccessfully() {
        let text = streamingText.trimmingCharacters(in: .whitespacesAndNewlines)
        let output = text.isEmpty ? "(空回复)" : text
        let done = activeDone
        activeDone = nil
        activeDelta = nil
        activeDiff = nil
        activeReasoningSummary = nil
        activeTurnId = nil
        streamingText = ""
        done?(.success(output))
    }

    private func failActiveTurn(with error: Error) {
        let done = activeDone
        activeDone = nil
        activeDelta = nil
        activeDiff = nil
        activeReasoningSummary = nil
        activeTurnId = nil
        streamingText = ""
        done?(.failure(error))
    }

    private static func extractThreadID(from result: [String: Any]) -> String? {
        if let thread = result["thread"] as? [String: Any], let tid = thread["id"] as? String {
            return tid
        }
        if let tid = result["threadId"] as? String {
            return tid
        }
        return nil
    }
}
