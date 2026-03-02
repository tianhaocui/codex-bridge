package com.codexbridge.idea

import java.io.File

data class SessionOption(
    val id: String,
    val displayLabel: String,
    val cwd: String = ""
)

data class CodexOptions(
    val projects: List<String>,
    val sessions: List<SessionOption>
)

object CodexOptionsLoader {
    fun load(projectAPath: String): CodexOptions {
        val home = System.getProperty("user.home").orEmpty()
        val codexDir = File(home, ".codex")
        val configPath = File(codexDir, "config.toml")
        val historyPath = File(codexDir, "history.jsonl")

        val projects = parseProjects(configPath)
        val sessions = parseSessions(historyPath, codexDir)

        val mergedProjects = linkedSetOf<String>()
        projects.forEach { if (it.isNotBlank()) mergedProjects.add(it.trim()) }
        if (projectAPath.isNotBlank()) mergedProjects.add(projectAPath.trim())

        return CodexOptions(
            projects = mergedProjects.toList().sorted(),
            sessions = sessions
        )
    }

    private fun parseProjects(configPath: File): List<String> {
        if (!configPath.exists()) return emptyList()
        val regex = Regex("""^\s*\[projects\."(.+)"\]\s*$""")
        val projects = linkedSetOf<String>()
        configPath.forEachLine { line ->
            val match = regex.find(line) ?: return@forEachLine
            val value = match.groupValues.getOrNull(1).orEmpty().replace("\\\"", "\"").trim()
            if (value.isNotBlank()) projects.add(value)
        }
        return projects.toList().sorted()
    }

    private fun parseSessions(historyPath: File, codexDir: File): List<SessionOption> {
        if (!historyPath.exists()) return emptyList()

        val latestTsBySession = mutableMapOf<String, Long>()
        val firstTextBySession = mutableMapOf<String, String>()

        historyPath.forEachLine { line ->
            val trimmed = line.trim()
            if (trimmed.isEmpty()) return@forEachLine
            val obj = JsonUtil.parseObject(trimmed) ?: return@forEachLine
            val sessionId = obj["session_id"]?.toString().orEmpty()
            if (sessionId.isBlank()) return@forEachLine
            val ts = obj["ts"]?.toString()?.toLongOrNull() ?: 0L

            if (!firstTextBySession.containsKey(sessionId)) {
                val text = obj["text"]?.toString().orEmpty()
                firstTextBySession[sessionId] = firstLinePreview(text)
            }

            val prev = latestTsBySession[sessionId] ?: 0L
            if (ts > prev) latestTsBySession[sessionId] = ts
        }

        val sortedIds = latestTsBySession.entries
            .sortedByDescending { it.value }
            .map { it.key }
            .take(80)

        val cwdBySession = parseSessionCwds(sortedIds.toSet(), codexDir)
        return sortedIds.map { id ->
            val preview = firstTextBySession[id].orEmpty().ifBlank { "(无首句)" }
            SessionOption(
                id = id,
                displayLabel = "${id.take(8)} - $preview",
                cwd = cwdBySession[id].orEmpty()
            )
        }
    }

    private fun parseSessionCwds(sessionIds: Set<String>, codexDir: File): Map<String, String> {
        val result = mutableMapOf<String, String>()
        val remaining = sessionIds.toMutableSet()
        val roots = listOf(File(codexDir, "sessions"), File(codexDir, "archived_sessions"))

        for (root in roots) {
            if (remaining.isEmpty() || !root.exists()) break
            val files = root.walkTopDown().filter { it.isFile && it.extension == "jsonl" }
            files.forEach { file ->
                if (remaining.isEmpty()) return@forEach
                val lines = file.useLines { seq -> seq.take(8).toList() }
                for (line in lines) {
                    val meta = JsonUtil.parseObject(line.trim()) ?: continue
                    if (meta["type"]?.toString() != "session_meta") continue
                    val payload = meta["payload"] as? Map<*, *> ?: continue
                    val id = payload["id"]?.toString().orEmpty()
                    val cwd = payload["cwd"]?.toString().orEmpty()
                    if (id.isBlank() || !remaining.contains(id)) continue
                    if (cwd.isNotBlank()) result[id] = cwd
                    remaining.remove(id)
                    break
                }
            }
        }
        return result
    }

    private fun firstLinePreview(raw: String): String {
        val line = raw.lineSequence().firstOrNull().orEmpty().replace('\t', ' ').trim()
        if (line.isEmpty()) return "(无首句)"
        return if (line.length <= 40) line else line.take(40) + "..."
    }
}

