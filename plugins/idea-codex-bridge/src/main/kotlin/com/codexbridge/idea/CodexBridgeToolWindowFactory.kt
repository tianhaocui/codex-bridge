package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Color
import java.awt.FlowLayout
import java.awt.GridLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingUtilities
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class CodexBridgeToolWindowFactory : ToolWindowFactory {
    data class SessionComboItem(val id: String, val label: String) {
        override fun toString(): String = label
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val settings = CodexBridgeSettings.getInstance(project)
        val stored = settings.state
        val projectA = project.basePath ?: ""
        val workerA = CodexWorker()
        val workerB = CodexWorker()

        val panel = JPanel(BorderLayout())
        panel.border = JBUI.Borders.empty(8)
        val top = JPanel(GridLayout(0, 1, 6, 6))
        val accent = JBColor(Color(0, 122, 255), Color(10, 132, 255))
        val danger = JBColor(Color(255, 59, 48), Color(255, 69, 58))

        val titleLabel = JLabel("Codex Bridge")

        val projectALabel = JLabel("Project A: $projectA")
        val projectBSelect = JComboBox<String>()
        val projectBField = JBTextField()
        projectBField.emptyText.text = "Project B 可手动输入（优先）"

        val sessionASelect = JComboBox<SessionComboItem>()
        val sessionBSelect = JComboBox<SessionComboItem>()
        sessionASelect.isEditable = true
        sessionBSelect.isEditable = true
        projectBField.text = stored.projectBPath

        val autoRelay = JBCheckBox("自动互发", stored.autoRelayEnabled)
        val stopOnDone = JBCheckBox("阶段完成自动停止", stored.stopOnStageDone)
        val statusLabel = JLabel("A: 空闲 | B: 空闲")
        val loadingLabel = JLabel("就绪")
        loadingLabel.foreground = JBColor(Color(106, 115, 125), Color(147, 161, 176))

        val projectBRow = JPanel(BorderLayout(6, 0))
        projectBRow.add(JLabel("Project B"), BorderLayout.WEST)
        projectBRow.add(projectBSelect, BorderLayout.CENTER)

        val sessionSelectRow = JPanel(GridLayout(1, 2, 6, 0))
        sessionSelectRow.add(wrapField("Session A（候选）", sessionASelect))
        sessionSelectRow.add(wrapField("Session B（候选）", sessionBSelect))

        val optionsRow = JPanel(FlowLayout(FlowLayout.LEFT, 10, 0))
        optionsRow.add(autoRelay)
        optionsRow.add(stopOnDone)
        optionsRow.add(statusLabel)
        optionsRow.add(loadingLabel)

        top.add(titleLabel)
        top.add(projectALabel)
        top.add(projectBRow)
        top.add(projectBField)
        top.add(sessionSelectRow)
        top.add(optionsRow)

        val chatArea = JBTextArea()
        chatArea.isEditable = false
        chatArea.lineWrap = true
        chatArea.wrapStyleWord = true
        chatArea.border = JBUI.Borders.empty(8)
        val chatScroll = JBScrollPane(chatArea)

        val messageArea = JBTextArea(4, 60)
        messageArea.lineWrap = true
        messageArea.wrapStyleWord = true
        messageArea.border = JBUI.Borders.empty(8)
        val messageScroll = JBScrollPane(messageArea)

        val buttons = JPanel(GridLayout(1, 4, 6, 6))
        val sendA = JButton("发给A")
        val sendB = JButton("发给B")
        val sendBoth = JButton("同时发送")
        val interrupt = JButton("■")
        interrupt.toolTipText = "停止"
        val unifiedTextColor = sendBoth.foreground
        sendA.background = accent
        sendA.foreground = unifiedTextColor
        sendB.background = accent
        sendB.foreground = unifiedTextColor
        interrupt.background = danger
        interrupt.foreground = unifiedTextColor
        buttons.add(sendA)
        buttons.add(sendB)
        buttons.add(sendBoth)
        buttons.add(interrupt)

        val bottom = JPanel(BorderLayout(0, 6))
        bottom.add(messageScroll, BorderLayout.CENTER)
        bottom.add(buttons, BorderLayout.SOUTH)

        panel.add(top, BorderLayout.NORTH)
        panel.add(chatScroll, BorderLayout.CENTER)
        panel.add(bottom, BorderLayout.SOUTH)

        val allSessions = mutableListOf<SessionOption>()
        var isSendingA = false
        var isSendingB = false
        var animFrame = 0
        val dots = listOf("·  ", "·· ", "···", " ··")
        val activeSides = linkedSetOf<String>()

        fun append(text: String) {
            ApplicationManager.getApplication().invokeLater {
                chatArea.append(text + "\n")
                chatArea.caretPosition = chatArea.document.length
            }
        }

        fun updateButtonsAndLoading() {
            val dot = dots[animFrame % dots.size]
            sendA.text = if (isSendingA) "A 生成中$dot" else "发给A"
            sendB.text = if (isSendingB) "B 生成中$dot" else "发给B"
            sendA.isEnabled = !isSendingA
            sendB.isEnabled = !isSendingB
            sendBoth.isEnabled = !(isSendingA && isSendingB)
            if (activeSides.isEmpty()) {
                loadingLabel.text = "就绪"
            } else {
                loadingLabel.text = "生成中 ${activeSides.joinToString("/")} $dot"
            }
        }

        fun updateStatus() {
            statusLabel.text = "A: ${if (isSendingA) "发送中" else "空闲"} | B: ${if (isSendingB) "发送中" else "空闲"}"
            updateButtonsAndLoading()
        }

        fun stageDone(text: String): Boolean {
            val lines = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
            val last = lines.lastOrNull() ?: return false
            return Regex(
                "^\\s*\\{\\s*\\\"bridge_stage\\\"\\s*:\\s*\\\"done\\\"\\s*}\\s*$",
                RegexOption.IGNORE_CASE
            ).matches(last)
        }

        fun relayPayload(text: String): String {
            val lines = text.split("\n")
            if (lines.isEmpty()) return text
            val last = lines.last().trim()
            val isSignal = Regex(
                "^\\s*\\{\\s*\\\"bridge_stage\\\"\\s*:\\s*\\\"(done|continue)\\\"\\s*}\\s*$",
                RegexOption.IGNORE_CASE
            ).matches(last)
            return if (isSignal) lines.dropLast(1).joinToString("\n").trim() else text
        }

        fun composeMessage(base: String): String {
            if (!(autoRelay.isSelected && stopOnDone.isSelected)) return base
            return "$base\n\n[Bridge 控制协议]\n- 回复最后一行必须是单行 JSON：{\"bridge_stage\":\"continue\"} 或 {\"bridge_stage\":\"done\"}"
        }

        fun matchesProject(sessionCwd: String, projectPath: String): Boolean {
            val normalizedProject = projectPath.trim()
            val normalizedCwd = sessionCwd.trim()
            if (normalizedProject.isBlank() || normalizedCwd.isBlank()) return false
            if (normalizedCwd.startsWith(normalizedProject)) return true

            val projectName = normalizedProject.split('/').filter { it.isNotBlank() }.lastOrNull().orEmpty()
            if (projectName.isBlank()) return false
            val cwdName = normalizedCwd.split('/').filter { it.isNotBlank() }.lastOrNull().orEmpty()
            if (cwdName == projectName) return true

            val parts = normalizedCwd.split('/').filter { it.isNotBlank() }
            val codexIndex = parts.indexOf(".codex")
            if (codexIndex >= 0 && codexIndex + 2 < parts.size && parts[codexIndex + 1] == "worktrees") {
                return parts[codexIndex + 2] == projectName
            }
            return false
        }

        fun selectedProjectBPath(): String {
            val manual = projectBField.text.trim()
            if (manual.isNotBlank()) return manual
            return (projectBSelect.selectedItem as? String).orEmpty().trim()
        }

        fun sessionComboValue(combo: JComboBox<SessionComboItem>): String {
            val selected = combo.selectedItem
            return when (selected) {
                is SessionComboItem -> selected.id.ifBlank { selected.label }.trim()
                is String -> selected.trim()
                else -> combo.editor.item?.toString()?.trim().orEmpty()
            }
        }

        fun selectedSessionId(side: String): String {
            val combo = if (side == "A") sessionASelect else sessionBSelect
            return sessionComboValue(combo)
        }

        fun applySessionSelection(combo: JComboBox<SessionComboItem>, model: DefaultComboBoxModel<SessionComboItem>, target: String) {
            val trimmed = target.trim()
            if (trimmed.isBlank()) {
                combo.selectedIndex = 0
                combo.editor.item = ""
                return
            }
            for (i in 0 until model.size) {
                val item = model.getElementAt(i)
                if (item.id == trimmed) {
                    combo.selectedIndex = i
                    return
                }
            }
            combo.selectedItem = trimmed
            combo.editor.item = trimmed
        }

        fun updateSessionDropdowns() {
            val projectB = selectedProjectBPath()
            val currentA = sessionComboValue(sessionASelect).ifBlank { stored.sessionA.trim() }
            val currentB = sessionComboValue(sessionBSelect).ifBlank { stored.sessionB.trim() }
            val optionsForA = allSessions.filter { matchesProject(it.cwd, projectA) }
            val optionsForB = allSessions.filter { matchesProject(it.cwd, projectB) }

            val modelA = DefaultComboBoxModel<SessionComboItem>()
            modelA.addElement(SessionComboItem("", "新会话（留空）"))
            optionsForA.forEach { modelA.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionASelect.model = modelA

            val modelB = DefaultComboBoxModel<SessionComboItem>()
            modelB.addElement(SessionComboItem("", "新会话（留空）"))
            optionsForB.forEach { modelB.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionBSelect.model = modelB

            applySessionSelection(sessionASelect, modelA, currentA)
            applySessionSelection(sessionBSelect, modelB, currentB)
        }

        fun loadOptions() {
            ApplicationManager.getApplication().executeOnPooledThread {
                val options = CodexOptionsLoader.load(projectA)
                allSessions.clear()
                allSessions.addAll(options.sessions)
                ApplicationManager.getApplication().invokeLater {
                    val projectModel = DefaultComboBoxModel<String>()
                    projectModel.addElement("")
                    options.projects.forEach { projectModel.addElement(it) }
                    projectBSelect.model = projectModel
                    val targetProjectB = stored.projectBPath.trim()
                    if (targetProjectB.isNotBlank()) {
                        for (i in 0 until projectModel.size) {
                            val value = projectModel.getElementAt(i)
                            if (value == targetProjectB) {
                                projectBSelect.selectedIndex = i
                                break
                            }
                        }
                    }
                    updateSessionDropdowns()
                }
            }
        }

        fun setSending(side: String, value: Boolean) {
            ApplicationManager.getApplication().invokeLater {
                if (side == "A") isSendingA = value else isSendingB = value
                if (value) activeSides.add(side) else activeSides.remove(side)
                updateStatus()
            }
        }

        fun send(side: String, text: String, relay: Boolean = false) {
            val trimmed = text.trim()
            if (trimmed.isEmpty()) return

            if ((side == "A" && isSendingA) || (side == "B" && isSendingB)) {
                append("[系统] $side 忙碌中，稍后再试")
                return
            }

            val cwd = if (side == "A") projectA else selectedProjectBPath()
            val session = selectedSessionId(side)
            val worker = if (side == "A") workerA else workerB

            if (cwd.isBlank()) {
                append("[系统] $side 发送失败：项目路径为空")
                return
            }

            if (!relay) append("[你->$side] $trimmed") else append("[系统] 自动转发到 $side")

            val outbound = composeMessage(trimmed)
            setSending(side, true)

            worker.send(
                message = outbound,
                cwd = cwd,
                resumeThreadId = session.ifBlank { null },
                onDelta = { _ -> },
                onDone = { result ->
                    setSending(side, false)
                    result
                        .onSuccess { reply ->
                            append("[$side] $reply")
                            if (autoRelay.isSelected) {
                                if (stopOnDone.isSelected && stageDone(reply)) {
                                    autoRelay.isSelected = false
                                    append("[系统] 检测到阶段完成，停止自动互发")
                                } else {
                                    val payload = relayPayload(reply)
                                    if (payload.isNotBlank()) {
                                        send(if (side == "A") "B" else "A", payload, true)
                                    }
                                }
                            }
                        }
                        .onFailure { err ->
                            append("[系统] $side 执行失败：${err.message}")
                        }
                }
            )
        }

        fun bindDocChange(field: JBTextField, onChange: () -> Unit) {
            field.document.addDocumentListener(object : DocumentListener {
                override fun insertUpdate(e: DocumentEvent?) = onChange()
                override fun removeUpdate(e: DocumentEvent?) = onChange()
                override fun changedUpdate(e: DocumentEvent?) = onChange()
            })
        }

        fun saveSettings() {
            val s = settings.state
            s.projectBPath = projectBField.text.trim()
            s.sessionA = sessionComboValue(sessionASelect)
            s.sessionB = sessionComboValue(sessionBSelect)
            s.autoRelayEnabled = autoRelay.isSelected
            s.stopOnStageDone = stopOnDone.isSelected
        }

        projectBSelect.addActionListener {
            updateSessionDropdowns()
            saveSettings()
        }
        sessionASelect.addActionListener { saveSettings() }
        sessionBSelect.addActionListener { saveSettings() }
        autoRelay.addActionListener { saveSettings() }
        stopOnDone.addActionListener { saveSettings() }
        bindDocChange(projectBField) {
            updateSessionDropdowns()
            saveSettings()
        }

        sendA.addActionListener {
            val text = messageArea.text
            messageArea.text = ""
            send("A", text)
            saveSettings()
        }

        sendB.addActionListener {
            val text = messageArea.text
            messageArea.text = ""
            send("B", text)
            saveSettings()
        }

        sendBoth.addActionListener {
            val text = messageArea.text
            messageArea.text = ""
            send("A", text)
            send("B", text)
            saveSettings()
        }

        interrupt.addActionListener {
            var interrupted = false
            if (isSendingA) {
                workerA.interrupt()
                setSending("A", false)
                interrupted = true
            }
            if (isSendingB) {
                workerB.interrupt()
                setSending("B", false)
                interrupted = true
            }
            if (interrupted) {
                autoRelay.isSelected = false
                append("[系统] 已打断 A/B，并停止自动互发")
            } else {
                append("[系统] 当前无进行中的任务可打断")
            }
        }

        messageArea.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                    e.consume()
                    sendA.doClick()
                }
            }
        })

        Timer(350) {
            animFrame++
            if (isSendingA || isSendingB) {
                updateButtonsAndLoading()
            }
        }.start()

        updateStatus()
        loadOptions()
        saveSettings()

        val content = ContentFactory.getInstance().createContent(panel, "", false)
        toolWindow.contentManager.addContent(content)
        SwingUtilities.invokeLater { messageArea.requestFocusInWindow() }
    }

    private fun wrapField(label: String, component: JComboBox<SessionComboItem>): JPanel {
        val panel = JPanel(BorderLayout(0, 4))
        panel.add(JLabel(label), BorderLayout.NORTH)
        panel.add(component, BorderLayout.CENTER)
        return panel
    }
}
