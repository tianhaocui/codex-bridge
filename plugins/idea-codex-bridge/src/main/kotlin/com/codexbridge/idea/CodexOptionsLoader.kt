package com.codexbridge.idea

import java.io.File
import java.time.Instant

data class SessionOption(
    val id: String,
    val displayLabel: String,
    val cwd: String = "",
    val tool: String = "codex"
)

data class CodexOptions(
    val projects: List<String>,
    val sessions: List<SessionOption>
)

object CodexOptionsLoader {
    private const val MAX_SESSION_OPTIONS = 80
    private const val MAX_CLAUDE_SCAN_LINES = 96

    fun load(projectAPath: String): CodexOptions {
        val home = System.getProperty("user.home").orEmpty()
        val codexDir = File(home, ".codex")
        val claudeProjectsDir = File(home, ".claude/projects")
        val configPath = File(codexDir, "config.toml")
        val historyPath = File(codexDir, "history.jsonl")

        val projects = parseProjects(configPath) + parseClaudeProjects(claudeProjectsDir)
        val sessions = parseCodexSessions(historyPath, codexDir) + parseClaudeSessions(claudeProjectsDir)

        val mergedProjects = linkedSetOf<String>()
        projects.forEach { if (it.isNotBlank()) mergedProjects.add(it.trim()) }
        if (projectAPath.isNotBlank()) mergedProjects.add(projectAPath.trim())

        return CodexOptions(
            projects = mergedProjects.toList().sorted(),
            sessions = sessions
        )
    }

    internal fun parseClaudeProjectsForTest(claudeProjectsDir: File): List<String> = parseClaudeProjects(claudeProjectsDir)

    internal fun parseClaudeSessionsForTest(claudeProjectsDir: File): List<SessionOption> = parseClaudeSessions(claudeProjectsDir)

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

    private fun parseClaudeProjects(claudeProjectsDir: File): List<String> {
        if (!claudeProjectsDir.exists()) return emptyList()
        val projects = linkedSetOf<String>()
        claudeProjectsDir.listFiles()
            ?.filter { it.isDirectory && !it.name.startsWith(".") }
            ?.forEach { dir ->
                val resolved = resolveClaudeProjectPath(dir)
                if (resolved.isNotBlank()) projects.add(resolved)
            }
        return projects.toList().sorted()
    }

    private fun resolveClaudeProjectPath(projectDir: File): String {
        if (!projectDir.exists()) return decodeClaudeProjectName(projectDir.name)

        val jsonlFiles = projectDir.listFiles()
            ?.filter { it.isFile && it.extension == "jsonl" }
            .orEmpty()
            .sortedBy { it.name }

        for (file in jsonlFiles) {
            val lines = readHeadLines(file, 64)
            for (line in lines) {
                val obj = JsonUtil.parseObject(line) ?: continue
                val cwd = obj["cwd"]?.toString().orEmpty().trim()
                if (cwd.isNotBlank()) return cwd
            }
        }

        return decodeClaudeProjectName(projectDir.name)
    }

    private fun decodeClaudeProjectName(name: String): String {
        if (name.isBlank()) return ""
        val builder = StringBuilder()
        var index = 0
        while (index < name.length) {
            val ch = name[index]
            if (ch != '-') {
                builder.append(ch)
                index++
                continue
            }

            if (index + 1 < name.length && name[index + 1] == '-') {
                builder.append('-')
                index += 2
            } else {
                builder.append('/')
                index++
            }
        }

        val decoded = builder.toString()
        return if (decoded.startsWith('/')) decoded else "/$decoded"
    }

    private fun parseCodexSessions(historyPath: File, codexDir: File): List<SessionOption> {
        val latestTsBySession = mutableMapOf<String, Long>()
        val firstTextBySession = mutableMapOf<String, String>()

        if (historyPath.exists()) {
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
        }

        val metaEntries = parseSessionMetaEntries(codexDir)
        val topIds = mergeSessionScores(latestTsBySession, metaEntries)
            .entries
            .sortedWith(
                compareByDescending<Map.Entry<String, Long>> { it.value }
                    .thenByDescending { it.key }
            )
            .take(MAX_SESSION_OPTIONS)
            .map { it.key }
        if (topIds.isEmpty()) return emptyList()

        val cwdBySession = parseSessionCwds(topIds.toSet(), codexDir)
        val metaById = metaEntries.associateBy { it.id }
        return topIds.map { id ->
            val preview = firstTextBySession[id].orEmpty().ifBlank { "(无首句)" }
            SessionOption(
                id = id,
                displayLabel = "${id.take(8)} - $preview",
                cwd = cwdBySession[id].orEmpty().ifBlank { metaById[id]?.cwd.orEmpty() },
                tool = "codex"
            )
        }
    }

    private fun parseClaudeSessions(claudeProjectsDir: File): List<SessionOption> {
        if (!claudeProjectsDir.exists()) return emptyList()
        data class ClaudeEntry(val id: String, val cwd: String, val preview: String, val sortTs: Long)

        val byId = linkedMapOf<String, ClaudeEntry>()
        claudeProjectsDir.walkTopDown()
            .filter { it.isFile && it.extension == "jsonl" }
            .forEach { file ->
                val lines = readHeadLines(file, MAX_CLAUDE_SCAN_LINES)
                if (lines.isEmpty()) return@forEach

                var sessionId = ""
                var cwd = ""
                var preview = "(无首句)"
                var sortTs = 0L

                for (line in lines) {
                    val obj = JsonUtil.parseObject(line) ?: continue
                    val candidateId = obj["sessionId"]?.toString().orEmpty().trim()
                    if (candidateId.isNotBlank()) sessionId = candidateId

                    if (cwd.isBlank()) {
                        cwd = obj["cwd"]?.toString().orEmpty().trim()
                    }

                    if (sortTs == 0L) {
                        sortTs = parseIsoToMillis(obj["timestamp"]?.toString())
                    }

                    if (preview == "(无首句)" && obj["type"]?.toString() == "user") {
                        val content = extractClaudeMessageText((obj["message"] as? Map<*, *>)?.get("content"))
                        if (content.isNotBlank()) {
                            preview = firstLinePreview(content)
                        }
                    }
                }

                if (sessionId.isBlank()) {
                    sessionId = file.nameWithoutExtension
                }
                if (sessionId.isBlank()) return@forEach
                if (cwd.isBlank()) {
                    cwd = resolveClaudeProjectPath(file.parentFile)
                }
                if (sortTs == 0L) {
                    sortTs = file.lastModified()
                }

                val existing = byId[sessionId]
                if (existing == null || sortTs > existing.sortTs) {
                    byId[sessionId] = ClaudeEntry(sessionId, cwd, preview, sortTs)
                }
            }

        return byId.values
            .sortedByDescending { it.sortTs }
            .take(MAX_SESSION_OPTIONS)
            .map { entry ->
                SessionOption(
                    id = entry.id,
                    displayLabel = "${entry.id.take(8)} - ${entry.preview}",
                    cwd = entry.cwd,
                    tool = "claude"
                )
            }
    }

    private fun extractClaudeMessageText(content: Any?): String {
        return when (content) {
            is String -> content.trim()
            is List<*> -> content.joinToString("") { item ->
                when (item) {
                    is String -> item
                    is Map<*, *> -> item["text"]?.toString().orEmpty()
                    else -> ""
                }
            }.trim()
            else -> ""
        }
    }

    private fun readHeadLines(file: File, maxLines: Int): List<String> {
        return runCatching {
            file.useLines { seq -> seq.map { it.trim() }.filter { it.isNotEmpty() }.take(maxLines).toList() }
        }.getOrDefault(emptyList())
    }

    private data class SessionMetaEntry(
        val id: String,
        val cwd: String,
        val sortTs: Long
    )

    private fun parseSessionMetaEntries(codexDir: File): List<SessionMetaEntry> {
        val byId = mutableMapOf<String, SessionMetaEntry>()
        val roots = listOf(File(codexDir, "sessions"), File(codexDir, "archived_sessions"))

        for (root in roots) {
            if (!root.exists()) continue
            val files = root.walkTopDown().filter { it.isFile && it.extension == "jsonl" }
            files.forEach { file ->
                val lines = file.useLines { seq -> seq.take(12).toList() }
                for (line in lines) {
                    val meta = JsonUtil.parseObject(line.trim()) ?: continue
                    if (meta["type"]?.toString() != "session_meta") continue
                    val payload = meta["payload"] as? Map<*, *> ?: continue
                    val id = payload["id"]?.toString().orEmpty()
                    if (id.isBlank()) break
                    val cwd = payload["cwd"]?.toString().orEmpty()
                    val payloadTs = parseIsoToMillis(payload["timestamp"]?.toString())
                    val sortTs = maxOf(payloadTs, file.lastModified())
                    val existing = byId[id]
                    if (existing == null || sortTs > existing.sortTs) {
                        byId[id] = SessionMetaEntry(id = id, cwd = cwd, sortTs = sortTs)
                    }
                    break
                }
            }
        }

        return byId.values.sortedByDescending { it.sortTs }
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

    private fun parseIsoToMillis(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return try {
            Instant.parse(value).toEpochMilli()
        } catch (_: Exception) {
            0L
        }
    }

    private fun mergeSessionScores(
        latestTsBySession: Map<String, Long>,
        metaEntries: List<SessionMetaEntry>
    ): Map<String, Long> {
        val scores = latestTsBySession.mapValuesTo(mutableMapOf()) { it.value * 1000 }
        metaEntries.forEach { entry ->
            val prev = scores[entry.id] ?: 0L
            scores[entry.id] = maxOf(prev, entry.sortTs)
        }
        return scores
    }
}
