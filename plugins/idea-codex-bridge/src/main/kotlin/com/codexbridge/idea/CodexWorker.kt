package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.text.Charsets.UTF_8

class CodexWorker : BridgeWorker {
    private var process: Process? = null
    private var threadId: String? = null
    private var activeTurnId: String? = null
    private var configuredCwd: String? = null
    private var configuredResumeId: String? = null
    private var streamingText = ""
    private val stderrTail = ArrayDeque<String>()

    private val nextRequestId = AtomicInteger(1)
    private val pending = ConcurrentHashMap<String, (Map<String, Any?>) -> Unit>()

    override fun send(
        message: String,
        cwd: String,
        resumeThreadId: String?,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            var attempt = 0
            while (attempt < 2) {
                try {
                    ensureReady(cwd, resumeThreadId)
                    startTurn(message, onDelta, onDone)
                    return@executeOnPooledThread
                } catch (e: Exception) {
                    val retryable = isRetryableConnectionError(e)
                    if (retryable && attempt == 0) {
                        shutdown()
                        threadId = null
                        activeTurnId = null
                        attempt++
                        continue
                    }
                    onDone(Result.failure(e))
                    return@executeOnPooledThread
                }
            }
        }
    }

    override fun shutdown() {
        process?.destroy()
        process = null
        synchronized(stderrTail) { stderrTail.clear() }
        pending.clear()
    }

    override fun interrupt() {
        val tid = threadId ?: return
        val turnId = activeTurnId ?: return
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                sendRequest("turn/interrupt", mapOf("threadId" to tid, "turnId" to turnId))
            } catch (_: Exception) {
            }
        }
    }

    private fun ensureReady(cwd: String, resumeThreadId: String?) {
        val normalizedResume = resumeThreadId?.trim()?.takeIf { it.isNotEmpty() }
        if (process?.isAlive == true && threadId != null && configuredCwd == cwd && configuredResumeId == normalizedResume) {
            return
        }

        shutdown()
        threadId = null
        activeTurnId = null
        configuredCwd = cwd
        configuredResumeId = normalizedResume

        startProcess()

        sendRequest("initialize", mapOf(
            "clientInfo" to mapOf("name" to "agent-bridge-idea", "version" to "0.1.2"),
            "capabilities" to mapOf("experimentalApi" to true)
        ))

        if (normalizedResume != null) {
            val resumeResult = sendRequest("thread/resume", mapOf(
                "threadId" to normalizedResume,
                "cwd" to cwd,
                "approvalPolicy" to "never",
                "sandbox" to "workspace-write"
            ))
            threadId = extractThreadId(resumeResult) ?: normalizedResume
        } else {
            val startResult = sendRequest("thread/start", mapOf(
                "cwd" to cwd,
                "approvalPolicy" to "never",
                "sandbox" to "workspace-write"
            ))
            threadId = extractThreadId(startResult)
                ?: throw IllegalStateException("thread/start 未返回 thread.id")
        }
    }

    private fun startTurn(
        message: String,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    ) {
        val tid = threadId ?: run {
            onDone(Result.failure(IllegalStateException("thread 未初始化")))
            return
        }

        streamingText = ""
        activeTurnId = null

        val done = AtomicBoolean(false)
        val currentTurnDone: (Boolean, String) -> Unit = { success, text ->
            if (done.compareAndSet(false, true)) {
                setRealtimeHandler(null)
                activeTurnId = null
                if (success) onDone(Result.success(text.ifBlank { "(空回复)" }))
                else onDone(Result.failure(IllegalStateException(text)))
            }
        }

        setRealtimeHandler { method, params ->
            when (method) {
                "item/agentMessage/delta" -> {
                    if (params["threadId"] != threadId) return@setRealtimeHandler
                    val turnId = params["turnId"] as? String
                    if (activeTurnId != null && turnId != null && turnId != activeTurnId) return@setRealtimeHandler
                    val delta = params["delta"] as? String ?: return@setRealtimeHandler
                    streamingText += delta
                    onDelta(delta)
                }
                "turn/started" -> {
                    if (params["threadId"] != threadId) return@setRealtimeHandler
                    val turn = params["turn"] as? Map<*, *>
                    val id = turn?.get("id") as? String
                    if (id != null) activeTurnId = id
                }
                "turn/completed" -> {
                    if (params["threadId"] != threadId) return@setRealtimeHandler
                    currentTurnDone(true, streamingText.trim())
                }
                "error" -> {
                    if (params["threadId"] != threadId) return@setRealtimeHandler
                    val willRetry = params["willRetry"] as? Boolean ?: false
                    if (!willRetry) {
                        val err = (params["error"] as? Map<*, *>)?.get("message") as? String ?: "未知错误"
                        currentTurnDone(false, err)
                    }
                }
            }
        }

        try {
            sendRequestAsync("turn/start", mapOf(
                "threadId" to tid,
                "input" to listOf(mapOf("type" to "text", "text" to message))
            )) { response ->
                val err = response["error"] as? Map<*, *>
                if (err != null) {
                    val messageText = err["message"] as? String ?: "turn/start 失败"
                    currentTurnDone(false, messageText)
                    return@sendRequestAsync
                }
                val turn = response["result"] as? Map<*, *>
                val turnObj = turn?.get("turn") as? Map<*, *>
                val id = turnObj?.get("id") as? String
                if (id != null) activeTurnId = id
            }
        } catch (e: Exception) {
            currentTurnDone(false, e.message ?: "turn/start 异常")
            return
        }

        // 兜底：防止极端情况下事件丢失导致 UI 永远显示“发送中”
        ApplicationManager.getApplication().executeOnPooledThread {
            Thread.sleep(120_000)
            if (!done.get()) {
                currentTurnDone(false, "响应超时（120s），请重试")
            }
        }
    }

    @Volatile
    private var realtimeHandler: ((String, Map<String, Any?>) -> Unit)? = null

    private fun setRealtimeHandler(handler: ((String, Map<String, Any?>) -> Unit)?) {
        realtimeHandler = handler
    }

    private fun startProcess() {
        val codexExec = resolveCodexExecutable()
        val processBuilder = createProcessBuilder(codexExec)
        process = processBuilder
            .redirectErrorStream(false)
            .start()

        val p = process ?: throw IllegalStateException("无法启动 codex app-server")
        synchronized(stderrTail) { stderrTail.clear() }

        Thread {
            BufferedReader(InputStreamReader(p.inputStream, UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) continue
                    handleJsonLine(line)
                }
            }
            if (process === p) {
                process = null
                val exitCode = runCatching { p.exitValue() }.getOrNull()
                val stderr = consumeStderrSummary()
                val details = buildString {
                    append("codex app-server 已断开连接")
                    if (exitCode != null) append(" (exit=").append(exitCode).append(")")
                    if (stderr.isNotBlank()) append("：").append(stderr)
                }
                failAllPending(details)
            }
        }.start()

        Thread {
            BufferedReader(InputStreamReader(p.errorStream, UTF_8)).use { reader ->
                while (true) {
                    val line = reader.readLine() ?: break
                    rememberStderr(line)
                }
            }
        }.start()
    }

    private fun createProcessBuilder(codexExec: String): ProcessBuilder {
        val os = System.getProperty("os.name").orEmpty().lowercase()
        if (os.contains("win")) {
            return ProcessBuilder(codexExec, "app-server", "--listen", "stdio://")
        }
        val escaped = codexExec.replace("'", "'\"'\"'")
        val cmd = "'$escaped' app-server --listen stdio://"
        return ProcessBuilder("/bin/zsh", "-lc", cmd)
    }

    private fun resolveCodexExecutable(): String {
        fun isExecutable(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            val file = File(path.trim())
            return file.exists() && file.canExecute()
        }

        val candidates = linkedSetOf<String>()

        val envCodexBin = System.getenv("CODEX_BIN")
        if (!envCodexBin.isNullOrBlank()) candidates.add(envCodexBin.trim())

        val envPath = System.getenv("PATH").orEmpty()
        if (envPath.isNotBlank()) {
            envPath.split(File.pathSeparator)
                .filter { it.isNotBlank() }
                .forEach { dir -> candidates.add(File(dir, "codex").absolutePath) }
        }

        candidates.add("/opt/homebrew/bin/codex")
        candidates.add("/usr/local/bin/codex")
        candidates.add(File(System.getProperty("user.home").orEmpty(), ".local/bin/codex").absolutePath)

        val shellFound = findCodexViaShell()
        if (!shellFound.isNullOrBlank()) candidates.add(shellFound.trim())

        for (candidate in candidates) {
            if (isExecutable(candidate)) return candidate
        }

        throw IllegalStateException(
            "未找到 codex 可执行文件。请先安装 Codex CLI，并在 IDE 环境配置 PATH 或 CODEX_BIN。"
        )
    }

    private fun findCodexViaShell(): String? {
        return try {
            val process = ProcessBuilder("/bin/zsh", "-lc", "command -v codex || true")
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader(UTF_8).readText().trim()
            process.waitFor()
            output.lineSequence().firstOrNull()?.trim().takeIf { !it.isNullOrBlank() }
        } catch (_: Exception) {
            null
        }
    }

    private fun sendRequest(method: String, params: Map<String, Any?>): Map<String, Any?> {
        var result: Map<String, Any?>? = null
        var error: String? = null
        val lock = Object()

        sendRequestAsync(method, params) { response ->
            synchronized(lock) {
                val err = response["error"] as? Map<*, *>
                if (err != null) error = err["message"] as? String ?: "未知错误"
                else result = response["result"] as? Map<String, Any?> ?: emptyMap()
                lock.notifyAll()
            }
        }

        synchronized(lock) {
            while (result == null && error == null) lock.wait(20)
        }

        if (error != null) throw IllegalStateException(error)
        return result ?: emptyMap()
    }

    private fun sendRequestAsync(
        method: String,
        params: Map<String, Any?>,
        callback: (Map<String, Any?>) -> Unit
    ) {
        val p = process ?: throw IllegalStateException("app-server 未启动")
        if (!p.isAlive) {
            process = null
            throw IllegalStateException("app-server 未启动")
        }
        val id = nextRequestId.getAndIncrement().toString()
        pending[id] = callback

        val payload = mapOf(
            "jsonrpc" to "2.0",
            "id" to id.toInt(),
            "method" to method,
            "params" to params
        )

        val json = JsonUtil.stringify(payload)
        try {
            p.outputStream.write((json + "\n").toByteArray(UTF_8))
            p.outputStream.flush()
        } catch (e: IOException) {
            pending.remove(id)
            process = null
            throw IllegalStateException("codex app-server 连接已断开：${e.message}", e)
        }
    }

    private fun handleJsonLine(line: String) {
        val dict = JsonUtil.parseObject(line) ?: return
        val id = dict["id"]
        if (id != null) {
            val key = id.toString()
            val cb = pending.remove(key)
            cb?.invoke(dict)
            return
        }

        val method = dict["method"] as? String ?: return
        val params = dict["params"] as? Map<String, Any?> ?: emptyMap()
        realtimeHandler?.invoke(method, params)
    }

    private fun extractThreadId(result: Map<String, Any?>): String? {
        val thread = result["thread"] as? Map<*, *>
        val threadId = thread?.get("id") as? String
        if (!threadId.isNullOrBlank()) return threadId
        return result["threadId"] as? String
    }

    private fun failAllPending(message: String) {
        if (pending.isEmpty()) return
        val errorResponse = mapOf(
            "error" to mapOf("message" to message)
        )
        val callbacks = pending.values.toList()
        pending.clear()
        callbacks.forEach { cb ->
            try {
                cb(errorResponse)
            } catch (_: Exception) {
            }
        }
    }

    private fun isRetryableConnectionError(e: Exception): Boolean {
        val msg = e.message.orEmpty()
        if (msg.contains("Stream closed", ignoreCase = true)) return true
        if (msg.contains("Broken pipe", ignoreCase = true)) return true
        if (msg.contains("app-server 未启动", ignoreCase = true)) return true
        if (msg.contains("连接已断开", ignoreCase = true)) return true
        return false
    }

    private fun rememberStderr(line: String) {
        val trimmed = line.trim()
        if (trimmed.isBlank()) return
        synchronized(stderrTail) {
            if (stderrTail.size >= 8) stderrTail.removeFirst()
            stderrTail.addLast(trimmed)
        }
    }

    private fun consumeStderrSummary(): String {
        synchronized(stderrTail) {
            return stderrTail.joinToString(" | ")
        }
    }
}
