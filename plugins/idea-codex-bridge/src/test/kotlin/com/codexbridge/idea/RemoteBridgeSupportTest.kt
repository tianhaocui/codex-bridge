package com.codexbridge.idea

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RemoteBridgeSupportTest {
    @Test
    fun `build host snippet includes hub peer and target`() {
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

        assertTrue(snippet.contains("mode=client"))
        assertTrue(snippet.contains("hubUrl=http://hub.local:9239"))
        assertTrue(snippet.contains("peerId=node-123"))
        assertTrue(snippet.contains("targetTool=claude"))
        assertTrue(snippet.contains("targetProjectPath=/tmp/demo-project"))
    }

    @Test
    fun `parse snippet ignores comments and empty lines`() {
        val parsed = RemoteBridgeSupport.parseSnippet(
            """
            # Codex Bridge Remote 连接配置
            mode=client
            remoteUrl=http://127.0.0.1:9238
            token=token-123

            targetTool=codex
            """.trimIndent()
        )

        assertEquals("client", parsed["mode"])
        assertEquals("http://127.0.0.1:9238", parsed["remoteUrl"])
        assertEquals("token-123", parsed["token"])
        assertEquals("codex", parsed["targetTool"])
    }

    @Test
    fun `extract streaming event supports delta done and chat completions`() {
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

        assertEquals(RemoteStreamingEvent.Type.DELTA, delta.type)
        assertEquals("hello ", delta.text)
        assertEquals(RemoteStreamingEvent.Type.DONE, done.type)
        assertEquals("hello world", done.text)
        assertEquals(RemoteStreamingEvent.Type.DELTA, chat.type)
        assertEquals("streaming", chat.text)
    }

    @Test
    fun `resolve remote urls normalizes invoke interrupt and health`() {
        assertEquals("http://127.0.0.1:9238/invoke", RemoteBridgeSupport.resolveInvokeUrl("http://127.0.0.1:9238"))
        assertEquals("http://127.0.0.1:9238/interrupt", RemoteBridgeSupport.resolveInterruptUrl("http://127.0.0.1:9238/invoke"))
        assertEquals("http://127.0.0.1:9238/health", RemoteBridgeSupport.resolveHealthUrl("http://127.0.0.1:9238/invoke"))
    }
}
