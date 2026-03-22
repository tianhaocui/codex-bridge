package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import kotlin.text.Charsets.UTF_8

class RemoteWorker(
    private val getConfig: () -> RemoteWorkerConfig
) : BridgeWorker {
    @Volatile
    private var invokeConnection: HttpURLConnection? = null

    override fun send(
        message: String,
        cwd: String,
        resumeThreadId: String?,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    ) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val config = getConfig()
            if (config.mode != RemoteMode.CLIENT) {
                onDone(Result.failure(IllegalStateException("远端模式未切换到客户端")))
                return@executeOnPooledThread
            }

            val rawUrl = config.url.trim()
            val token = config.token.trim()
            val hubUrl = config.hubUrl.trim()
            val peerId = config.peerId.trim()
            if (rawUrl.isBlank() && !(hubUrl.isNotBlank() && peerId.isNotBlank())) {
                onDone(Result.failure(IllegalStateException("远端 URL 为空")))
                return@executeOnPooledThread
            }
            if (token.isBlank()) {
                onDone(Result.failure(IllegalStateException("远端访问 Key 为空")))
                return@executeOnPooledThread
            }

            try {
                val requestUrl = if (hubUrl.isNotBlank() && peerId.isNotBlank()) {
                    "${hubUrl.removeSuffix("/")}/relay/invoke"
                } else {
                    RemoteBridgeSupport.resolveInvokeUrl(rawUrl)
                }
                val requestBody = if (hubUrl.isNotBlank() && peerId.isNotBlank()) {
                    mapOf(
                        "token" to token,
                        "targetNodeId" to peerId,
                        "text" to message,
                        "stream" to true,
                        "targetTool" to config.targetTool.value,
                        "targetProjectPath" to config.targetProjectPath,
                        "targetSessionId" to config.targetSessionId
                    )
                } else {
                    mapOf(
                        "token" to token,
                        "text" to message,
                        "stream" to true,
                        "targetTool" to config.targetTool.value,
                        "targetProjectPath" to config.targetProjectPath,
                        "targetSessionId" to config.targetSessionId
                    )
                }

                val connection = RemoteHttpUtil.openConnection(
                    requestUrl,
                    "POST",
                    mapOf("Content-Type" to "application/json")
                )
                invokeConnection = connection
                connection.outputStream.use { output ->
                    output.write(JsonUtil.stringify(requestBody).toByteArray(UTF_8))
                    output.flush()
                }

                val status = connection.responseCode
                if (status >= 400) {
                    val errorStream = connection.errorStream?.bufferedReader(UTF_8)?.readText().orEmpty()
                    connection.disconnect()
                    invokeConnection = null
                    onDone(Result.failure(IllegalStateException(errorStream.ifBlank { "远端调用失败 ($status)" })))
                    return@executeOnPooledThread
                }

                consumeRemoteResponse(
                    contentType = connection.contentType.orEmpty(),
                    stream = connection.inputStream,
                    onDelta = onDelta,
                    onDone = onDone
                )
                connection.disconnect()
                invokeConnection = null
            } catch (error: Exception) {
                invokeConnection?.disconnect()
                invokeConnection = null
                onDone(Result.failure(error))
            }
        }
    }

    override fun interrupt() {
        val active = invokeConnection
        invokeConnection = null
        active?.disconnect()

        ApplicationManager.getApplication().executeOnPooledThread {
            val config = getConfig()
            if (config.mode != RemoteMode.CLIENT || config.token.trim().isBlank()) return@executeOnPooledThread

            val hubUrl = config.hubUrl.trim()
            val peerId = config.peerId.trim()
            val directUrl = config.url.trim()
            val requestUrl = if (hubUrl.isNotBlank() && peerId.isNotBlank()) {
                "${hubUrl.removeSuffix("/")}/relay/interrupt"
            } else {
                RemoteBridgeSupport.resolveInterruptUrl(directUrl)
            }
            val headers = if (hubUrl.isNotBlank() && peerId.isNotBlank()) {
                mapOf("Content-Type" to "application/json")
            } else {
                mapOf("x-bridge-token" to config.token.trim())
            }
            val body = if (hubUrl.isNotBlank() && peerId.isNotBlank()) {
                JsonUtil.stringify(
                    mapOf(
                        "token" to config.token.trim(),
                        "targetNodeId" to peerId
                    )
                )
            } else {
                null
            }
            runCatching { RemoteHttpUtil.post(requestUrl, body, headers) }
        }
    }

    override fun shutdown() {
        invokeConnection?.disconnect()
        invokeConnection = null
    }

    private fun consumeRemoteResponse(
        contentType: String,
        stream: InputStream,
        onDelta: (String) -> Unit,
        onDone: (Result<String>) -> Unit
    ) {
        val trimmedType = contentType.lowercase()
        var aggregate = ""

        BufferedReader(InputStreamReader(stream, UTF_8)).use { reader ->
            if (trimmedType.contains("text/event-stream")) {
                val eventLines = mutableListOf<String>()
                while (true) {
                    val line = reader.readLine() ?: break
                    if (line.isBlank()) {
                        val payloadText = eventLines
                            .filter { it.startsWith("data:") }
                            .joinToString("\n") { it.removePrefix("data:").trim() }
                        eventLines.clear()
                        if (payloadText.isBlank()) continue
                        if (payloadText == "[DONE]") {
                            onDone(Result.success(aggregate.ifBlank { "(空回复)" }))
                            return
                        }
                        val parsed = JsonUtil.parseObject(payloadText)
                        val event = RemoteBridgeSupport.extractStreamingEvent(parsed)
                        when (event.type) {
                            RemoteStreamingEvent.Type.DELTA -> {
                                aggregate += event.text
                                onDelta(event.text)
                            }
                            RemoteStreamingEvent.Type.DONE -> {
                                val finalText = event.text.ifBlank { aggregate.ifBlank { "(空回复)" } }
                                onDone(Result.success(finalText))
                                return
                            }
                            RemoteStreamingEvent.Type.ERROR -> {
                                onDone(Result.failure(IllegalStateException(event.text.ifBlank { "远端流失败" })))
                                return
                            }
                            RemoteStreamingEvent.Type.IGNORE -> Unit
                        }
                    } else {
                        eventLines += line
                    }
                }
            } else {
                while (true) {
                    val rawLine = reader.readLine() ?: break
                    val line = rawLine.trim()
                    if (line.isBlank()) continue
                    val parsed = JsonUtil.parseObject(line)
                    if (parsed == null) {
                        aggregate += line
                        onDelta(line)
                        continue
                    }
                    val event = RemoteBridgeSupport.extractStreamingEvent(parsed)
                    when (event.type) {
                        RemoteStreamingEvent.Type.DELTA -> {
                            aggregate += event.text
                            onDelta(event.text)
                        }
                        RemoteStreamingEvent.Type.DONE -> {
                            val finalText = event.text.ifBlank { aggregate.ifBlank { "(空回复)" } }
                            onDone(Result.success(finalText))
                            return
                        }
                        RemoteStreamingEvent.Type.ERROR -> {
                            onDone(Result.failure(IllegalStateException(event.text.ifBlank { "远端流失败" })))
                            return
                        }
                        RemoteStreamingEvent.Type.IGNORE -> {
                            if (line.isNotBlank()) {
                                aggregate += line
                                onDelta(line)
                            }
                        }
                    }
                }
            }
        }

        onDone(Result.success(aggregate.ifBlank { "(空回复)" }))
    }
}
