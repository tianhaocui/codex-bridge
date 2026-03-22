package com.codexbridge.idea

object RemoteBridgeSupportChecks {
    @JvmStatic
    fun main(args: Array<String>) {
        checkHostSnippet()
        checkSnippetParsing()
        checkStreamingPayloads()
        checkUrlNormalization()
        println("remote-bridge checks ok")
    }

    private fun checkHostSnippet() {
        val snippet = RemoteBridgeSupport.buildConnectionSnippet(
            RemoteSnippetContext(
                currentMode = RemoteMode.HOST,
                remoteUrl = "",
                remoteHubUrl = "http://hub.local:9239",
                remotePeerId = "",
                remoteToken = "bridge-token",
                targetTool = BridgeCliTool.CLAUDE,
                targetProjectPath = "/tmp/demo-project",
                targetSessionId = "urn:uuid:11111111-1111-1111-1111-111111111111",
                targetLabel = "demo-device | Claude Code | /tmp/demo-project | urn:uuid:11111111-1111-1111-1111-111111111111",
                localRemoteNodeId = "node-123",
                hostListenPort = 9238,
                hostEndpoints = listOf("http://192.168.1.8:9238")
            )
        )

        check(snippet.contains("mode=client"))
        check(snippet.contains("hubUrl=http://hub.local:9239"))
        check(snippet.contains("peerId=node-123"))
        check(snippet.contains("targetTool=claude"))
        check(snippet.contains("targetProjectPath=/tmp/demo-project"))
    }

    private fun checkSnippetParsing() {
        val parsed = RemoteBridgeSupport.parseSnippet(
            """
            # Codex Bridge Remote 连接配置
            mode=client
            remoteUrl=http://127.0.0.1:9238
            token=token-123
            targetTool=codex
            """.trimIndent()
        )

        check(parsed["mode"] == "client")
        check(parsed["remoteUrl"] == "http://127.0.0.1:9238")
        check(parsed["token"] == "token-123")
        check(parsed["targetTool"] == "codex")
    }

    private fun checkStreamingPayloads() {
        val delta = RemoteBridgeSupport.extractStreamingEvent(mapOf("type" to "delta", "delta" to "hello "))
        val done = RemoteBridgeSupport.extractStreamingEvent(mapOf("type" to "done", "text" to "hello world"))
        val chat = RemoteBridgeSupport.extractStreamingEvent(
            mapOf(
                "choices" to listOf(
                    mapOf("delta" to mapOf("content" to "stream")),
                    mapOf("delta" to mapOf("content" to "ing"))
                )
            )
        )

        check(delta.type == RemoteStreamingEvent.Type.DELTA && delta.text == "hello ")
        check(done.type == RemoteStreamingEvent.Type.DONE && done.text == "hello world")
        check(chat.type == RemoteStreamingEvent.Type.DELTA && chat.text == "streaming")
    }

    private fun checkUrlNormalization() {
        check(RemoteBridgeSupport.resolveInvokeUrl("http://127.0.0.1:9238") == "http://127.0.0.1:9238/invoke")
        check(RemoteBridgeSupport.resolveInterruptUrl("http://127.0.0.1:9238/invoke") == "http://127.0.0.1:9238/interrupt")
        check(RemoteBridgeSupport.resolveHealthUrl("http://127.0.0.1:9238/invoke") == "http://127.0.0.1:9238/health")
    }
}
