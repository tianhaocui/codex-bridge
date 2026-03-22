package com.codexbridge.idea

enum class BridgeCliTool(val value: String, val label: String) {
    CODEX("codex", "Codex"),
    CLAUDE("claude", "Claude Code"),
    REMOTE("remote", "Remote");

    override fun toString(): String = label

    companion object {
        fun fromValue(value: String?): BridgeCliTool = entries.firstOrNull { it.value == value } ?: CODEX

        fun fromRemoteTarget(value: String?): BridgeCliTool = when (value) {
            CLAUDE.value -> CLAUDE
            else -> CODEX
        }
    }
}
