package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.text.Charsets.UTF_8

class ClaudeWorker : BridgeWorker {
    @Volatile
    private var process: Process? = null

    @Volatile
    private var interrupted = false

    private var outBuffer = ""
    private var stderrText = ""
    private var sessionId: String? = null
    private var activeDone: ((Result<String>) -> Unit)? = null

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
            resolveClaudeExecutable(),
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
            activeDone = onDone
            outBuffer = ""
            stderrText = ""
            interrupted = false

            try {
                val started = ProcessBuilder(command)
                    .directory(File(cwd))
                    .redirectErrorStream(false)
                    .start()
                process = started

                val stdoutReader = Thread {
                    outBuffer = started.inputStream.bufferedReader(UTF_8).use { it.readText() }
                }
                val stderrReader = Thread {
                    stderrText = started.errorStream.bufferedReader(UTF_8).use { it.readText() }
                }
                stdoutReader.start()
                stderrReader.start()

                val exitCode = started.waitFor()
                stdoutReader.join()
                stderrReader.join()

                if (doneOnce.get()) return@executeOnPooledThread

                if (interrupted) {
                    finishFailure(doneOnce, "Claude 请求已中断")
                    return@executeOnPooledThread
                }

                if (exitCode != 0) {
                    finishFailure(doneOnce, buildExitMessage(exitCode, stderrText))
                    return@executeOnPooledThread
                }

                val output = outBuffer.trim()
                if (output.isBlank()) {
                    finishFailure(doneOnce, stderrText.trim().ifBlank { "Claude 未返回可解析结果" })
                    return@executeOnPooledThread
                }

                handleJsonOutput(output, onDelta, doneOnce)
            } catch (error: Exception) {
                finishFailure(doneOnce, error.message ?: "Claude 执行失败")
            }
        }
    }

    override fun interrupt() {
        interrupted = true
        process?.destroy()
    }

    override fun shutdown() {
        interrupted = true
        process?.destroy()
        process = null
        val done = activeDone
        activeDone = null
        if (done != null) {
            done(Result.failure(IllegalStateException("Claude worker 已终止")))
        }
    }

    private fun handleJsonOutput(
        output: String,
        onDelta: (String) -> Unit,
        doneOnce: AtomicBoolean
    ) {
        val lines = output.split(Regex("\\r?\\n")).map { it.trim() }.filter { it.isNotBlank() }

        for (index in lines.indices.reversed()) {
            val payload = JsonUtil.parseObject(lines[index]) ?: continue

            val parsedSessionId = payload["session_id"]?.toString().orEmpty()
                .ifBlank { payload["sessionId"]?.toString().orEmpty() }
            if (parsedSessionId.isNotBlank()) {
                sessionId = parsedSessionId
            }

            if (payload["type"]?.toString() == "result") {
                val success = payload["subtype"] == "success" && payload["is_error"] != true
                val text = payload["result"]?.toString().orEmpty().trim()
                if (success) {
                    val finalText = text.ifBlank { "(空回复)" }
                    onDelta(finalText)
                    finishSuccess(doneOnce, finalText)
                } else {
                    finishFailure(doneOnce, text.ifBlank { "Claude 执行失败" })
                }
                return
            }
        }

        finishFailure(
            doneOnce,
            stderrText.trim().ifBlank { "Claude 返回内容不可解析" }
        )
    }

    private fun finishSuccess(doneOnce: AtomicBoolean, text: String) {
        if (!doneOnce.compareAndSet(false, true)) return
        val done = activeDone
        cleanupProcess()
        done?.invoke(Result.success(text))
    }

    private fun finishFailure(doneOnce: AtomicBoolean, message: String) {
        if (!doneOnce.compareAndSet(false, true)) return
        val done = activeDone
        cleanupProcess()
        done?.invoke(Result.failure(IllegalStateException(message)))
    }

    private fun cleanupProcess() {
        process?.destroy()
        process = null
        activeDone = null
        interrupted = false
        outBuffer = ""
        stderrText = ""
    }

    private fun buildExitMessage(code: Int, stderr: String): String {
        val parts = mutableListOf("Claude worker 已退出 (exit=$code)")
        val compact = stderr.replace(Regex("\\s+"), " ").trim()
        if (compact.isNotBlank()) {
            parts += if (compact.length > 220) compact.take(220) + "..." else compact
        }
        return parts.joinToString("：")
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

        val shellFound = findBinaryViaShell("claude")
        if (!shellFound.isNullOrBlank()) candidates.add(shellFound.trim())

        for (candidate in candidates) {
            if (isExecutable(candidate)) return candidate
        }

        throw IllegalStateException(
            "未找到 claude 可执行文件。请先安装 Claude Code CLI，并在 IDE 环境配置 PATH。"
        )
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
