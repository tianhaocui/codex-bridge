package com.codexbridge.idea

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.project.Project

@Service(Service.Level.PROJECT)
@State(name = "CodexBridgeSettings", storages = [Storage("codex-bridge.xml")])
class CodexBridgeSettings : PersistentStateComponent<CodexBridgeSettings.State> {
    data class State(
        var projectBPath: String = "",
        var sessionA: String = "",
        var sessionB: String = "",
        var autoRelayEnabled: Boolean = false,
        var stopOnStageDone: Boolean = true
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        fun getInstance(project: Project): CodexBridgeSettings =
            project.getService(CodexBridgeSettings::class.java)
    }
}
