package com.codexbridge.idea

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.text.Charsets.UTF_8

data class RemoteInvokePayload(
    val text: String,
    val targetTool: BridgeCliTool?,
    val targetProjectPath: String?,
    val targetSessionId: String?,
    val onDelta: (String) -> Unit,
    val onDone: (String) -> Unit
)

class RemoteInvokeServer(
    private val onInvoke: (RemoteInvokePayload) -> CompletableFuture<Result<String>>,
    private val onInterrupt: () -> Result<Unit>
) {
    @Volatile
    private var server: HttpServer? = null

    @Volatile
    private var currentPort = 0

    @Volatile
    private var currentToken = ""

    @Synchronized
    fun start(port: Int, token: String): Int {
        if (server != null && currentPort == port && currentToken == token) {
            return currentPort
        }
        stop()

        val httpServer = HttpServer.create(InetSocketAddress("0.0.0.0", port), 0)
        httpServer.executor = Executors.newCachedThreadPool()
        currentToken = token

        httpServer.createContext("/health") { exchange ->
            sendJson(exchange, 200, mapOf("ok" to true, "port" to currentPort))
        }

        httpServer.createContext("/interrupt") { exchange ->
            if (exchange.requestMethod != "POST") {
                sendJson(exchange, 404, mapOf("ok" to false, "message" to "not found"))
                return@createContext
            }
            val auth = exchange.requestHeaders.getFirst("x-bridge-token").orEmpty()
            if (auth != currentToken) {
                sendJson(exchange, 401, mapOf("ok" to false, "message" to "invalid token"))
                return@createContext
            }
            val result = runCatching { onInterrupt() }.getOrElse { Result.failure(it) }
            if (result.isSuccess) {
                sendJson(exchange, 200, mapOf("ok" to true))
            } else {
                sendJson(exchange, 500, mapOf("ok" to false, "message" to result.exceptionOrNull()?.message.orEmpty()))
            }
        }

        httpServer.createContext("/invoke") { exchange ->
            if (exchange.requestMethod != "POST") {
                sendJson(exchange, 404, mapOf("ok" to false, "message" to "not found"))
                return@createContext
            }
            handleInvoke(exchange)
        }

        httpServer.start()
        server = httpServer
        currentPort = httpServer.address.port
        return currentPort
    }

    @Synchronized
    fun stop() {
        val active = server ?: return
        server = null
        currentPort = 0
        active.stop(0)
        (active.executor as? java.util.concurrent.ExecutorService)?.shutdownNow()
    }

    private fun handleInvoke(exchange: HttpExchange) {
        try {
            val raw = exchange.requestBody.bufferedReader(UTF_8).readText()
            val payload = JsonUtil.parseObject(raw).orEmpty()
            if (payload["token"]?.toString().orEmpty() != currentToken) {
                sendJson(exchange, 401, mapOf("ok" to false, "message" to "invalid token"))
                return
            }
            val text = payload["text"]?.toString().orEmpty()
            if (text.trim().isEmpty()) {
                sendJson(exchange, 400, mapOf("ok" to false, "message" to "text required"))
                return
            }

            exchange.responseHeaders.add("Content-Type", "application/x-ndjson; charset=utf-8")
            exchange.responseHeaders.add("Cache-Control", "no-cache, no-transform")
            exchange.responseHeaders.add("Connection", "keep-alive")
            exchange.sendResponseHeaders(200, 0)

            val finished = AtomicBoolean(false)
            val lock = Any()
            exchange.responseBody.use { output ->
                fun writeLine(body: Any) {
                    synchronized(lock) {
                        if (finished.get()) return
                        output.write((JsonUtil.stringify(body) + "\n").toByteArray(UTF_8))
                        output.flush()
                    }
                }

                val targetTool = payload["targetTool"]?.toString()?.let { BridgeCliTool.fromRemoteTarget(it) }
                val future = onInvoke(
                    RemoteInvokePayload(
                        text = text,
                        targetTool = targetTool,
                        targetProjectPath = payload["targetProjectPath"]?.toString(),
                        targetSessionId = payload["targetSessionId"]?.toString(),
                        onDelta = { delta ->
                            if (delta.isNotEmpty()) {
                                writeLine(mapOf("type" to "delta", "delta" to delta))
                            }
                        },
                        onDone = { resultText ->
                            if (finished.compareAndSet(false, true)) {
                                output.write(
                                    (JsonUtil.stringify(mapOf("type" to "done", "text" to resultText.ifBlank { "(空回复)" })) + "\n")
                                        .toByteArray(UTF_8)
                                )
                                output.flush()
                            }
                        }
                    )
                )

                val result = future.get(5, TimeUnit.MINUTES)
                if (finished.get()) return
                if (result.isSuccess) {
                    writeLine(mapOf("type" to "done", "text" to result.getOrDefault("(空回复)")))
                } else {
                    writeLine(
                        mapOf(
                            "type" to "error",
                            "message" to (result.exceptionOrNull()?.message ?: "invoke failed")
                        )
                    )
                }
                finished.set(true)
            }
        } catch (error: Exception) {
            if (!exchange.responseHeaders.containsKey("Content-Type")) {
                sendJson(exchange, 500, mapOf("ok" to false, "message" to (error.message ?: "invoke failed")))
            } else {
                runCatching {
                    exchange.responseBody.use { output ->
                        output.write(
                            (JsonUtil.stringify(mapOf("type" to "error", "message" to (error.message ?: "invoke failed"))) + "\n")
                                .toByteArray(UTF_8)
                        )
                        output.flush()
                    }
                }
            }
        } finally {
            exchange.close()
        }
    }

    private fun sendJson(exchange: HttpExchange, statusCode: Int, body: Any) {
        val bytes = JsonUtil.stringify(body).toByteArray(UTF_8)
        exchange.responseHeaders.add("Content-Type", "application/json; charset=utf-8")
        exchange.sendResponseHeaders(statusCode, bytes.size.toLong())
        exchange.responseBody.use { output ->
            output.write(bytes)
            output.flush()
        }
        exchange.close()
    }
}
