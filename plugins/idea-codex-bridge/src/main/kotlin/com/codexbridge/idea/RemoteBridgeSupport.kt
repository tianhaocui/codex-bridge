package com.codexbridge.idea

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID

enum class RemoteMode(val value: String, val label: String) {
    OFF("off", "跨设备: 关闭"),
    HOST("host", "跨设备: 对外提供本机 AI"),
    CLIENT("client", "跨设备: 连接远端 AI");

    override fun toString(): String = label

    companion object {
        fun fromValue(value: String?): RemoteMode = entries.firstOrNull { it.value == value } ?: OFF
    }
}

enum class RemoteConnectivity {
    IDLE,
    OK,
    ERROR,
    CHECKING
}

data class RemotePeerOption(
    val id: String,
    val label: String,
    val invokeUrl: String = "",
    val exportSide: String = ""
) {
    override fun toString(): String = label
}

data class RemoteWorkerConfig(
    val mode: RemoteMode,
    val url: String,
    val token: String,
    val hubUrl: String,
    val peerId: String,
    val targetTool: BridgeCliTool,
    val targetProjectPath: String,
    val targetSessionId: String
)

data class RemoteStreamingEvent(
    val type: Type,
    val text: String = ""
) {
    enum class Type {
        DELTA,
        DONE,
        ERROR,
        IGNORE
    }
}

data class RemoteSnippetContext(
    val currentMode: RemoteMode,
    val remoteUrl: String,
    val remoteHubUrl: String,
    val remotePeerId: String,
    val remoteToken: String,
    val targetTool: BridgeCliTool,
    val targetProjectPath: String,
    val targetSessionId: String,
    val targetLabel: String,
    val localRemoteNodeId: String,
    val hostListenPort: Int,
    val hostEndpoints: List<String>
)

object RemoteBridgeSupport {
    const val DEFAULT_REMOTE_PORT = 9238
    const val DEFAULT_REMOTE_TOKEN_HINT = "直连时，客户端与主机填同一个 Token；Hub 模式下，客户端、主机、Hub 都必须使用同一个 Token。"

    fun defaultRemoteToken(): String = UUID.randomUUID().toString()

    fun normalizeRemoteToken(value: String?, fallback: String = defaultRemoteToken()): String {
        val token = value.orEmpty().trim()
        return if (token.isNotBlank()) token else fallback
    }

    fun describeRemoteToken(token: String): String {
        val trimmed = token.trim()
        if (trimmed.isBlank()) return "认证 Token 缺失"
        if (trimmed.length < 8) return "认证 Token 偏短"
        return "认证 Token 已就绪 (${trimmed.length} 字符)"
    }

    fun formatHostEndpoints(port: Int): List<String> {
        val urls = linkedSetOf<String>()
        urls.add("http://127.0.0.1:$port")

        val interfaces = NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
        interfaces
            .filter { runCatching { it.isUp && !it.isLoopback }.getOrDefault(false) }
            .flatMap { it.inetAddresses.toList() }
            .filterIsInstance<Inet4Address>()
            .filter { !it.isLoopbackAddress }
            .forEach { urls.add("http://${it.hostAddress}:$port") }

        return urls.toList()
    }

    fun preferredHostEndpoint(urls: List<String>, fallbackPort: Int = DEFAULT_REMOTE_PORT): String {
        return urls.firstOrNull { !it.contains("127.0.0.1") && !it.contains("localhost") }
            ?: urls.firstOrNull()
            ?: "http://127.0.0.1:$fallbackPort"
    }

    fun parseSnippet(raw: String): Map<String, String> {
        val values = linkedMapOf<String, String>()
        raw.split(Regex("\\r?\\n"))
            .map { it.trim() }
            .filter { it.isNotBlank() && !it.startsWith("#") && it.contains('=') }
            .forEach { line ->
                val idx = line.indexOf('=')
                if (idx <= 0) return@forEach
                val key = line.substring(0, idx).trim()
                val value = line.substring(idx + 1).trim()
                if (key.isNotBlank() && value.isNotBlank()) {
                    values[key] = value
                }
            }
        return values
    }

    fun buildConnectionSnippet(context: RemoteSnippetContext): String {
        val lines = mutableListOf("# Codex Bridge Remote 连接配置")
        if (context.currentMode == RemoteMode.HOST) {
            lines += "mode=client"
            if (context.remoteHubUrl.trim().isNotBlank()) {
                lines += "hubUrl=${context.remoteHubUrl.trim()}"
                lines += "peerId=${context.localRemoteNodeId.trim()}"
            } else {
                lines += "remoteUrl=${preferredHostEndpoint(context.hostEndpoints, context.hostListenPort)}"
            }
        } else {
            lines += "mode=${context.currentMode.value}"
            if (context.remoteHubUrl.trim().isNotBlank()) lines += "hubUrl=${context.remoteHubUrl.trim()}"
            if (context.remoteUrl.trim().isNotBlank()) lines += "remoteUrl=${context.remoteUrl.trim()}"
            if (context.remotePeerId.trim().isNotBlank()) lines += "peerId=${context.remotePeerId.trim()}"
        }
        lines += "token=${context.remoteToken.trim()}"
        lines += "tool=remote"
        lines += "targetTool=${context.targetTool.value}"
        if (context.targetProjectPath.trim().isNotBlank()) {
            lines += "targetProjectPath=${context.targetProjectPath.trim()}"
        }
        if (context.targetSessionId.trim().isNotBlank()) {
            lines += "targetSessionId=${context.targetSessionId.trim()}"
        }
        if (context.targetLabel.trim().isNotBlank()) {
            lines += "targetLabel=${context.targetLabel.trim()}"
        }
        return lines.joinToString("\n")
    }

    fun resolveInvokeUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim().removeSuffix("/")
        if (trimmed.isBlank()) return "/invoke"
        if (trimmed.endsWith("/invoke")) return trimmed
        if (trimmed.endsWith("/interrupt")) return trimmed.removeSuffix("/interrupt") + "/invoke"
        return "$trimmed/invoke"
    }

    fun resolveInterruptUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim().removeSuffix("/")
        if (trimmed.isBlank()) return "/interrupt"
        if (trimmed.endsWith("/interrupt")) return trimmed
        if (trimmed.endsWith("/invoke")) return trimmed.removeSuffix("/invoke") + "/interrupt"
        return "$trimmed/interrupt"
    }

    fun resolveHealthUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim().removeSuffix("/")
        if (trimmed.isBlank()) return "/health"
        if (trimmed.endsWith("/invoke")) return trimmed.removeSuffix("/invoke") + "/health"
        if (trimmed.endsWith("/interrupt")) return trimmed.removeSuffix("/interrupt") + "/health"
        if (trimmed.endsWith("/health")) return trimmed
        return "$trimmed/health"
    }

    fun extractStreamingEvent(payload: Any?): RemoteStreamingEvent {
        val map = payload as? Map<*, *> ?: return RemoteStreamingEvent(RemoteStreamingEvent.Type.IGNORE)

        val type = map["type"]?.toString().orEmpty()
        if (type == "delta") {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DELTA, map["delta"]?.toString().orEmpty())
        }
        if (type == "done") {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DONE, map["text"]?.toString().orEmpty())
        }
        if (type == "error") {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.ERROR, map["message"]?.toString().orEmpty())
        }
        if (map["ok"] == true && map["text"] is String) {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DONE, map["text"]?.toString().orEmpty())
        }
        if (map["ok"] == false) {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.ERROR, map["message"]?.toString().orEmpty())
        }
        if (type == "response.output_text.delta" && map["delta"] is String) {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DELTA, map["delta"]?.toString().orEmpty())
        }
        if (type == "response.completed") {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DONE)
        }

        val choices = map["choices"] as? List<*> ?: emptyList<Any?>()
        if (choices.isNotEmpty()) {
            val delta = choices.joinToString("") { choice ->
                val choiceMap = choice as? Map<*, *> ?: return@joinToString ""
                val deltaMap = choiceMap["delta"] as? Map<*, *>
                deltaMap?.get("content")?.toString()
                    ?: (choiceMap["message"] as? Map<*, *>)?.get("content")?.toString()
                    ?: ""
            }
            if (delta.isNotBlank()) {
                val hasDelta = choices.any { choice ->
                    val choiceMap = choice as? Map<*, *> ?: return@any false
                    val deltaMap = choiceMap["delta"] as? Map<*, *>
                    deltaMap?.get("content") is String
                }
                return RemoteStreamingEvent(
                    if (hasDelta) RemoteStreamingEvent.Type.DELTA else RemoteStreamingEvent.Type.DONE,
                    delta
                )
            }
        }

        val content = map["content"] as? List<*> ?: emptyList<Any?>()
        if (content.isNotEmpty()) {
            val text = content.joinToString("") { item ->
                (item as? Map<*, *>)?.get("text")?.toString().orEmpty()
            }
            if (text.isNotBlank()) {
                return RemoteStreamingEvent(RemoteStreamingEvent.Type.DONE, text)
            }
        }

        val resultText = map["result"]?.toString().orEmpty()
        if (resultText.isNotBlank()) {
            return RemoteStreamingEvent(RemoteStreamingEvent.Type.DONE, resultText)
        }

        return RemoteStreamingEvent(RemoteStreamingEvent.Type.IGNORE)
    }
}
