package com.codexbridge.idea

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CodexOptionsLoaderTest {
    @Test
    fun `claude project and session options prefer real cwd from jsonl content`() {
        val root = createTempDirectory("agent-bridge-claude").toFile()
        val projectDir = File(root, "-Users-test-Desktop-item-client-web").apply { mkdirs() }

        writeJsonl(
            File(projectDir, "session-a.jsonl"),
            listOf(
                mapOf("type" to "queue-operation", "sessionId" to "session-a"),
                mapOf(
                    "type" to "user",
                    "sessionId" to "session-a",
                    "cwd" to "/Users/test/Desktop/item-client-web",
                    "timestamp" to "2026-03-22T10:00:00.000Z",
                    "message" to mapOf(
                        "content" to listOf(mapOf("type" to "text", "text" to "第一条 Claude 消息"))
                    )
                )
            )
        )
        writeJsonl(
            File(projectDir, "session-b.jsonl"),
            listOf(
                mapOf("type" to "queue-operation", "sessionId" to "session-b"),
                mapOf(
                    "type" to "user",
                    "sessionId" to "session-b",
                    "timestamp" to "2026-03-22T11:00:00.000Z",
                    "message" to mapOf(
                        "content" to listOf(mapOf("type" to "text", "text" to "第二条 Claude 消息"))
                    )
                )
            )
        )

        val projects = CodexOptionsLoader.parseClaudeProjectsForTest(root)
        val sessions = CodexOptionsLoader.parseClaudeSessionsForTest(root)

        assertEquals(listOf("/Users/test/Desktop/item-client-web"), projects)
        assertEquals(2, sessions.size)
        assertEquals("session-b", sessions[0].id)
        assertEquals("/Users/test/Desktop/item-client-web", sessions[0].cwd)
        assertTrue(sessions[0].displayLabel.contains("第二条 Claude 消息"))
        assertEquals("/Users/test/Desktop/item-client-web", sessions[1].cwd)
        assertTrue(sessions[1].displayLabel.contains("第一条 Claude 消息"))
    }

    private fun writeJsonl(file: File, rows: List<Map<String, Any>>) {
        file.writeText(rows.joinToString("\n") { JsonUtil.stringify(it) } + "\n")
    }
}
