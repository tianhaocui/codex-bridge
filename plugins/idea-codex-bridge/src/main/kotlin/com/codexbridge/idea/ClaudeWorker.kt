package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.text.Charsets.UTF_8

class ClaudeWorker : BridgeWorker {
    private var process: Process? = null
    private var sessionId: String? = null
    private var activeDone: ((Result<String>) -> Unit)? = null
    private var streamingText = ""

    override fun send(
        message: String,
        cwd: String,
        resumeThreadId: String?,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    ) {
        if (activeDone != null) {
            onDone(Result.failure(IllegalStateException("当前已有进行中的 Claude 请求")))
            return
        }

        val resumeId = resumeThreadId?.trim()?.takeIf { it.isNotEmpty() } ?: sessionId
        val command = mutableListOf(
            "",
            "",
            "-p",
            "--output-format",
            "json",
            "--permission-mode",
            "dontAsk"
        )
        if (!resumeId.isNullOrBlank()) {
            command.add("--resume")
            command.add(resumeId)
        }
        command.add(message)

        ApplicationManager.getApplication().executeOnPooledThread {
            val doneOnce = AtomicBoolean(false)
            streamingText = ""
            activeDone = onDone

            try {
                val claudeExec = resolveClaudeExecutable()
                command[0] = resolveNodeExecutable()
                command[1] = resolveClaudeCliScript(claudeExec)
                val started = ProcessBuilder(command)
                    .directory(java.io.File(cwd))
                    .redirectErrorStream(true)
                    .start()
                process = started

                BufferedReader(InputStreamReader(started.inputStream, UTF_8)).use { reader ->
                    while (true) {
                        val line = reader.readLine() ?: break
                        if (line.isBlank()) continue
                        val payload = JsonUtil.parseObject(line) ?: continue
                        val parsedSessionId = payload["session_id"] as? String
                        if (!parsedSessionId.isNullOrBlank()) sessionId = parsedSessionId

                        when (payload["type"] as? String) {
                            "result" -> {
                                val success = payload["subtype"] == "success" && payload["is_error"] != true
                                val resultText = (payload["result"] as? String)?.trim().orEmpty()
                                if (doneOnce.compareAndSet(false, true)) {
                                    activeDone = null
                                    process = null
                                    if (success) {
                                        onDelta(resultText)
                                        onDone(Result.success(resultText.ifBlank { "(空回复)" }))
                                    } else {
                                        onDone(Result.failure(IllegalStateException(resultText.ifBlank { "Claude 执行失败" })))
                                    }
                                }
                            }
                        }
                    }
                }

                val exitCode = started.waitFor()
                if (doneOnce.compareAndSet(false, true)) {
                    activeDone = null
                    process = null
                    if (exitCode == 0) {
                        onDone(Result.success(streamingText.trim().ifBlank { "(空回复)" }))
                    } else {
                        onDone(Result.failure(IllegalStateException("Claude worker 已退出 (exit=$exitCode)")))
                    }
                }
            } catch (e: Exception) {
                if (doneOnce.compareAndSet(false, true)) {
                    activeDone = null
                    process = null
                    onDone(Result.failure(e))
                }
            }
        }
    }

    override fun interrupt() {
        process?.destroy()
        process = null
    }

    override fun shutdown() {
        interrupt()
    }

    private fun resolveClaudeExecutable(): String {
        fun isExecutable(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            val file = File(path.trim())
            return file.exists() && file.canExecute()
        }

        val candidates = linkedSetOf<String>()
        val envPath = System.getenv("PATH").orEmpty()
        if (envPath.isNotBlank()) {
            envPath.split(File.pathSeparator)
                .filter { it.isNotBlank() }
                .forEach { dir -> candidates.add(File(dir, "claude").absolutePath) }
        }

        candidates.add("/opt/homebrew/bin/claude")
        candidates.add("/usr/local/bin/claude")
        candidates.add(File(System.getProperty("user.home").orEmpty(), ".local/bin/claude").absolutePath)

        val shellFound = findClaudeViaShell()
        if (!shellFound.isNullOrBlank()) candidates.add(shellFound.trim())

        for (candidate in candidates) {
            if (isExecutable(candidate)) return candidate
        }

        throw IllegalStateException(
            "未找到 claude 可执行文件。请先安装 Claude Code CLI，并在 IDE 环境配置 PATH。"
        )
    }

    private fun resolveNodeExecutable(): String {
        fun isExecutable(path: String?): Boolean {
            if (path.isNullOrBlank()) return false
            val file = File(path.trim())
            return file.exists() && file.canExecute()
        }

        val candidates = linkedSetOf<String>()
        val envPath = System.getenv("PATH").orEmpty()
        if (envPath.isNotBlank()) {
            envPath.split(File.pathSeparator)
                .filter { it.isNotBlank() }
                .forEach { dir -> candidates.add(File(dir, "node").absolutePath) }
        }

        candidates.add("/opt/homebrew/bin/node")
        candidates.add("/usr/local/bin/node")
        candidates.add("/usr/bin/node")

        val shellFound = findBinaryViaShell("node")
        if (!shellFound.isNullOrBlank()) candidates.add(shellFound.trim())

        for (candidate in candidates) {
            if (isExecutable(candidate)) return candidate
        }

        throw IllegalStateException("未找到 node 可执行文件。Claude Code CLI 依赖 Node.js 运行。")
    }

    private fun resolveClaudeCliScript(claudeExec: String): String {
        val execFile = File(claudeExec)
        val canonical = runCatching { execFile.canonicalFile }.getOrElse { execFile.absoluteFile }
        if (canonical.isFile) return canonical.absolutePath
        throw IllegalStateException("无法解析 Claude Code CLI 脚本路径：$claudeExec")
    }

    private fun findClaudeViaShell(): String? {
        return findBinaryViaShell("claude")
    }

    private fun findBinaryViaShell(name: String): String? {
        return try {
            val process = ProcessBuilder("/bin/zsh", "-lc", "command -v $name || true")
                .redirectErrorStream(true)
                .start()
            val output = process.inputStream.bufferedReader(UTF_8).readText().trim()
            process.waitFor()
            output.lineSequence().firstOrNull()?.trim().takeIf { !it.isNullOrBlank() }
        } catch (_: Exception) {
            null
        }
    }
}
