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
        var projectAPath: String = "",
        var projectBPath: String = "",
        var toolA: String = "codex",
        var toolB: String = "codex",
        var sessionA: String = "",
        var sessionB: String = "",
        var autoRelayEnabled: Boolean = false,
        var stopOnStageDone: Boolean = true,
        var chatControlExpanded: Boolean = false,
        var remoteControlExpanded: Boolean = false,
        var remoteMode: String = "off",
        var remoteUrl: String = "",
        var remoteToken: String = "",
        var remoteListenPort: Int = RemoteBridgeSupport.DEFAULT_REMOTE_PORT,
        var remoteExportSide: String = "A",
        var remoteHubUrl: String = "",
        var remotePeerId: String = "",
        var remoteDeviceName: String = "",
        var remoteTargetTool: String = "codex",
        var remoteTargetProjectPath: String = "",
        var remoteTargetSessionId: String = "",
        var remoteTargetLabel: String = "",
        var remoteAutoRelayEnabled: Boolean = false
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
