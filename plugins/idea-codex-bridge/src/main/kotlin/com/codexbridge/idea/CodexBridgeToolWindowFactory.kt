package com.codexbridge.idea

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.InputMethodEvent
import java.awt.event.InputMethodListener
import java.text.AttributedCharacterIterator
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
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

    private enum class CliTool(val value: String, val label: String) {
        CODEX("codex", "Codex"),
        CLAUDE("claude", "Claude Code");

        override fun toString(): String = label

        companion object {
            fun fromValue(value: String?): CliTool = entries.firstOrNull { it.value == value } ?: CODEX
        }
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val settings = CodexBridgeSettings.getInstance(project)
        val stored = settings.state
        val defaultProjectA = project.basePath ?: ""
        val workers = mapOf(
            "A" to mapOf<CliTool, BridgeWorker>(CliTool.CODEX to CodexWorker(), CliTool.CLAUDE to ClaudeWorker()),
            "B" to mapOf<CliTool, BridgeWorker>(CliTool.CODEX to CodexWorker(), CliTool.CLAUDE to ClaudeWorker())
        )

        val panelBackground = JBColor(Color(243, 245, 248), Color(24, 27, 32))
        val foreground = JBColor(Color(31, 35, 40), Color(232, 236, 242))
        val muted = JBColor(Color(101, 109, 122), Color(147, 161, 176))
        val accent = JBColor(Color(0, 122, 255), Color(10, 132, 255))
        val accentAlt = JBColor(Color(59, 110, 255), Color(82, 146, 255))
        val danger = JBColor(Color(255, 59, 48), Color(255, 69, 58))
        val cardBorder = JBColor(Color(214, 216, 224), Color(62, 66, 76))
        val cardBackground = JBColor(Color(250, 251, 253), Color(35, 38, 44))
        val panelStrong = JBColor(Color(255, 255, 255), Color(31, 34, 39))
        val panelStrongAlt = JBColor(Color(245, 248, 253), Color(39, 43, 50))
        val chatBackground = JBColor(Color(245, 247, 250), Color(27, 30, 35))
        val userBubble = JBColor(Color(232, 242, 255), Color(36, 54, 82))
        val assistantBubble = JBColor(Color(236, 242, 255), Color(43, 49, 68))
        val secondarySoft = JBColor(Color(236, 241, 252), Color(45, 53, 76))
        val systemBubble = JBColor(Color(242, 243, 245), Color(48, 49, 53))
        val buttonSecondary = JBColor(Color(236, 239, 244), Color(55, 59, 68))
        val buttonSecondaryFg = JBColor(Color(43, 47, 53), Color(229, 233, 240))
        val timeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")
        val panel = JPanel(BorderLayout())
        panel.background = panelBackground
        panel.isOpaque = true
        panel.border = JBUI.Borders.empty(12)
        val top = JPanel()
        top.layout = BoxLayout(top, BoxLayout.Y_AXIS)
        top.isOpaque = false

        fun createCard(title: String, subtitle: String? = null): JPanel {
            val container = JPanel(BorderLayout(0, 10))
            container.background = cardBackground
            container.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(12)
            )
            val header = JPanel()
            header.layout = BoxLayout(header, BoxLayout.Y_AXIS)
            header.isOpaque = false
            val titleLabel = JBLabel(title)
            titleLabel.foreground = foreground
            titleLabel.font = titleLabel.font.deriveFont(titleLabel.font.size2D + 2f)
            header.add(titleLabel)
            if (!subtitle.isNullOrBlank()) {
                header.add(Box.createRigidArea(Dimension(0, 4)))
                val subtitleLabel = JBLabel("<html><body style='width:100%'>$subtitle</body></html>")
                subtitleLabel.foreground = muted
                subtitleLabel.font = subtitleLabel.font.deriveFont(subtitleLabel.font.size2D - 1f)
                header.add(subtitleLabel)
            }
            container.add(header, BorderLayout.NORTH)
            return container
        }

        fun createVerticalContent(): JPanel {
            val content = JPanel()
            content.layout = BoxLayout(content, BoxLayout.Y_AXIS)
            content.isOpaque = false
            return content
        }

        fun createPillLabel(text: String, background: Color, foregroundColor: Color, borderColor: Color = background): JLabel {
            return JBLabel(text).apply {
                isOpaque = true
                this.background = background
                this.foreground = foregroundColor
                border = BorderFactory.createCompoundBorder(
                    BorderFactory.createLineBorder(borderColor, 1, true),
                    JBUI.Borders.empty(5, 10)
                )
                font = font.deriveFont(font.size2D - 1f)
            }
        }

        fun createCollapsibleCard(
            title: String,
            subtitle: String,
            body: JComponent,
            badgeText: String,
            expandedInitially: Boolean = false
        ): JPanel {
            val card = JPanel(BorderLayout(0, 10))
            card.background = cardBackground
            card.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(12)
            )

            val header = JPanel(BorderLayout(12, 0))
            header.isOpaque = false

            val copy = JPanel()
            copy.layout = BoxLayout(copy, BoxLayout.Y_AXIS)
            copy.isOpaque = false
            val titleLabel = JBLabel(title)
            titleLabel.foreground = foreground
            titleLabel.font = titleLabel.font.deriveFont(titleLabel.font.size2D + 1f)
            val subtitleLabel = JBLabel("<html><body style='width:100%'>$subtitle</body></html>")
            subtitleLabel.foreground = muted
            subtitleLabel.font = subtitleLabel.font.deriveFont(subtitleLabel.font.size2D - 1f)
            copy.add(titleLabel)
            copy.add(Box.createRigidArea(Dimension(0, 4)))
            copy.add(subtitleLabel)

            val actions = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0))
            actions.isOpaque = false
            val summaryBadge = createPillLabel(badgeText, panelStrong, muted, cardBorder)
            val toggleButton = JButton(if (expandedInitially) "收起" else "展开")
            toggleButton.background = buttonSecondary
            toggleButton.foreground = buttonSecondaryFg
            toggleButton.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(buttonSecondary.darker(), 1, true),
                JBUI.Borders.empty(8, 14)
            )
            toggleButton.isFocusPainted = false
            actions.add(summaryBadge)
            actions.add(toggleButton)

            val bodyWrapper = JPanel(BorderLayout())
            bodyWrapper.isOpaque = false
            bodyWrapper.add(body, BorderLayout.CENTER)
            bodyWrapper.isVisible = expandedInitially

            toggleButton.addActionListener {
                bodyWrapper.isVisible = !bodyWrapper.isVisible
                toggleButton.text = if (bodyWrapper.isVisible) "收起" else "展开"
                card.revalidate()
                card.repaint()
            }

            header.add(copy, BorderLayout.CENTER)
            header.add(actions, BorderLayout.EAST)
            card.add(header, BorderLayout.NORTH)
            card.add(bodyWrapper, BorderLayout.CENTER)
            return card
        }

        fun styleInput(component: JComponent, minHeight: Int = 34) {
            component.background = panelStrong
            component.foreground = foreground
            component.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(6, 10)
            )
            component.maximumSize = Dimension(Int.MAX_VALUE, minHeight)
        }

        fun styleButton(button: JButton, background: Color, foregroundColor: Color) {
            button.background = background
            button.foreground = foregroundColor
            button.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(background.darker(), 1, true),
                JBUI.Borders.empty(8, 14)
            )
            button.isFocusPainted = false
        }

        fun row(vararg components: Component): JPanel {
            val panelRow = JPanel(GridLayout(1, components.size, 8, 0))
            panelRow.isOpaque = false
            components.forEach { panelRow.add(it) }
            panelRow.alignmentX = Component.LEFT_ALIGNMENT
            panelRow.maximumSize = Dimension(Int.MAX_VALUE, panelRow.preferredSize.height)
            return panelRow
        }

        fun addSectionGap(content: JPanel) {
            if (content.componentCount > 0) {
                content.add(Box.createRigidArea(Dimension(0, 8)))
            }
        }

        fun createSectionHeader(title: String, note: String): JPanel {
            val wrapper = JPanel()
            wrapper.layout = BoxLayout(wrapper, BoxLayout.Y_AXIS)
            wrapper.isOpaque = false
            wrapper.alignmentX = Component.LEFT_ALIGNMENT
            val titleLabel = JBLabel(title)
            titleLabel.foreground = foreground
            val noteLabel = JBLabel(note)
            noteLabel.foreground = muted
            noteLabel.font = noteLabel.font.deriveFont(noteLabel.font.size2D - 1f)
            wrapper.add(titleLabel)
            wrapper.add(Box.createRigidArea(Dimension(0, 2)))
            wrapper.add(noteLabel)
            wrapper.maximumSize = Dimension(Int.MAX_VALUE, wrapper.preferredSize.height)
            return wrapper
        }

        fun createMiniCard(title: String, component: JComponent, hint: String? = null): JPanel {
            val wrapper = JPanel(BorderLayout(0, 6))
            wrapper.background = panelStrongAlt
            wrapper.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(10)
            )
            val titleBlock = JPanel()
            titleBlock.layout = BoxLayout(titleBlock, BoxLayout.Y_AXIS)
            titleBlock.isOpaque = false
            val titleLabel = JBLabel(title)
            titleLabel.foreground = foreground
            titleLabel.font = titleLabel.font.deriveFont(titleLabel.font.size2D - 1f)
            titleBlock.add(titleLabel)
            if (!hint.isNullOrBlank()) {
                titleBlock.add(Box.createRigidArea(Dimension(0, 2)))
                val hintLabel = JBLabel(hint)
                hintLabel.foreground = muted
                hintLabel.font = hintLabel.font.deriveFont(hintLabel.font.size2D - 2f)
                titleBlock.add(hintLabel)
            }
            wrapper.add(titleBlock, BorderLayout.NORTH)
            wrapper.add(component, BorderLayout.CENTER)
            return wrapper
        }

        fun createToggleCard(checkBox: JBCheckBox, hint: String): JPanel {
            checkBox.isOpaque = false
            val wrapper = JPanel(BorderLayout(0, 6))
            wrapper.background = panelStrongAlt
            wrapper.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(10)
            )
            wrapper.add(checkBox, BorderLayout.NORTH)
            val hintLabel = JBLabel("<html><body style='width:160px'>$hint</body></html>")
            hintLabel.foreground = muted
            hintLabel.font = hintLabel.font.deriveFont(hintLabel.font.size2D - 1f)
            wrapper.add(hintLabel, BorderLayout.CENTER)
            return wrapper
        }

        val projectASelect = JComboBox<String>()
        val projectAField = JBTextField()
        val toolASelect = JComboBox(CliTool.entries.toTypedArray())
        val toolBSelect = JComboBox(CliTool.entries.toTypedArray())
        toolASelect.selectedItem = CliTool.fromValue(stored.toolA)
        toolBSelect.selectedItem = CliTool.fromValue(stored.toolB)
        val projectBSelect = JComboBox<String>()
        val projectBField = JBTextField()
        projectAField.emptyText.text = "Project A 可手动输入（优先）"
        projectBField.emptyText.text = "Project B 可手动输入（优先）"

        val sessionASelect = JComboBox<SessionComboItem>()
        val sessionBSelect = JComboBox<SessionComboItem>()
        val sessionAField = JBTextField()
        val sessionBField = JBTextField()
        sessionAField.emptyText.text = "A会话ID 可手动输入（优先）"
        sessionBField.emptyText.text = "B会话ID 可手动输入（优先）"
        projectAField.text = stored.projectAPath.ifBlank { defaultProjectA }
        projectBField.text = stored.projectBPath
        sessionAField.text = stored.sessionA
        sessionBField.text = stored.sessionB

        listOf<JComponent>(
            projectASelect,
            projectAField,
            toolASelect,
            toolBSelect,
            projectBSelect,
            projectBField,
            sessionASelect,
            sessionBSelect,
            sessionAField,
            sessionBField
        ).forEach { styleInput(it) }

        val autoRelay = JBCheckBox("自动互发", stored.autoRelayEnabled)
        val stopOnDone = JBCheckBox("阶段完成自动停止", stored.stopOnStageDone)
        val statusLabel = createPillLabel("A: 空闲 | B: 空闲", panelStrong, foreground, cardBorder)
        val loadingLabel = createPillLabel("就绪", userBubble, foreground, accent)
        val conversationStatusLabel = createPillLabel("A: 空闲 | B: 空闲", panelStrong, foreground, cardBorder)
        val conversationLoadingLabel = createPillLabel("就绪", userBubble, foreground, accent)
        val inlineStatusA = createPillLabel("A 空闲", panelStrong, foreground, cardBorder)
        val inlineStatusB = createPillLabel("B 空闲", panelStrong, foreground, cardBorder)

        val heroCard = createCard(
            "桥接对话流",
            "统一管理 A / B 两个 AI 的项目、会话与回复节奏，让 IDEA 端的视觉层级与 VSCode 侧边栏保持一致。"
        )
        val heroContent = createVerticalContent()
        val eyebrow = JBLabel("CONVERSATION FLOW")
        eyebrow.foreground = muted
        eyebrow.font = eyebrow.font.deriveFont(eyebrow.font.size2D - 2f)
        val heroPills = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        heroPills.isOpaque = false
        heroPills.add(createPillLabel("A / B Bridge", userBubble, foreground, accent))
        heroPills.add(createPillLabel("Enter 发给 A", panelStrong, muted, cardBorder))
        heroPills.add(createPillLabel("中文输入法友好", panelStrong, muted, cardBorder))
        heroContent.add(eyebrow)
        heroContent.add(Box.createRigidArea(Dimension(0, 8)))
        heroContent.add(heroPills)
        heroCard.add(heroContent, BorderLayout.CENTER)
        top.add(heroCard)
        top.add(Box.createRigidArea(Dimension(0, 12)))

        val configContent = createVerticalContent()
        configContent.add(createSectionHeader("双侧工具", "A / B 可以分别切换 Codex 或 Claude Code，并按项目过滤最近会话。"))
        addSectionGap(configContent)
        configContent.add(
            row(
                createMiniCard("A 侧工具", toolASelect, "通常保留当前工作区主线任务"),
                createMiniCard("B 侧工具", toolBSelect, "适合并行验证、补充分析或交叉讨论")
            )
        )
        addSectionGap(configContent)
        configContent.add(createSectionHeader("项目与路径", "下拉走最近项目，手动输入会覆盖下拉选择。"))
        addSectionGap(configContent)
        configContent.add(
            row(
                createMiniCard("A 项目", projectASelect, "从历史项目中选择"),
                createMiniCard("B 项目", projectBSelect, "可切到另一仓库")
            )
        )
        addSectionGap(configContent)
        configContent.add(
            row(
                createMiniCard("A 项目路径覆盖", projectAField, "手动输入优先"),
                createMiniCard("B 项目路径覆盖", projectBField, "手动输入优先")
            )
        )
        addSectionGap(configContent)
        configContent.add(createSectionHeader("最近会话", "最近会话会按工具与项目路径过滤，手动输入 thread id 时优先使用。"))
        addSectionGap(configContent)
        configContent.add(
            row(
                createMiniCard("A 最近会话", sessionASelect, "留空时续用当前或创建新会话"),
                createMiniCard("B 最近会话", sessionBSelect, "适合指定已有上下文")
            )
        )
        addSectionGap(configContent)
        configContent.add(
            row(
                createMiniCard("A 会话 ID 覆盖", sessionAField, "手动输入优先"),
                createMiniCard("B 会话 ID 覆盖", sessionBField, "手动输入优先")
            )
        )
        addSectionGap(configContent)
        configContent.add(createSectionHeader("执行策略", "自动互发适合阶段推进；阶段完成自动停止可避免无界接力。"))
        addSectionGap(configContent)
        configContent.add(
            row(
                createToggleCard(autoRelay, "开启后，A/B 回复会自动接力继续讨论。"),
                createToggleCard(stopOnDone, "检测到 bridge_stage=done 时自动停下。")
            )
        )
        addSectionGap(configContent)
        val configStatusCard = JPanel(BorderLayout(0, 8))
        configStatusCard.background = panelStrongAlt
        configStatusCard.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(cardBorder, 1, true),
            JBUI.Borders.empty(10)
        )
        val chipRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        chipRow.isOpaque = false
        chipRow.add(inlineStatusA)
        chipRow.add(inlineStatusB)
        val configHint = JBLabel("发送快捷键：Enter 发给 A，Shift+Enter 换行。需要发给 B 或同时发送时，使用下方操作按钮。")
        configHint.foreground = muted
        configHint.font = configHint.font.deriveFont(configHint.font.size2D - 1f)
        configStatusCard.add(chipRow, BorderLayout.NORTH)
        configStatusCard.add(configHint, BorderLayout.CENTER)
        configContent.add(configStatusCard)

        val configCard = createCollapsibleCard(
            "桥接设置",
            "工具、项目、最近会话和执行策略都折叠在这里，主区域优先保留对话流。",
            configContent,
            "A/B 点击展开",
            false
        )
        top.add(configCard)

        val chatList = JPanel()
        chatList.layout = BoxLayout(chatList, BoxLayout.Y_AXIS)
        chatList.background = chatBackground
        chatList.border = JBUI.Borders.empty(8)
        val chatScroll = JBScrollPane(chatList)
        chatScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        chatScroll.viewport.background = chatBackground
        chatScroll.preferredSize = Dimension(0, 360)

        val messageArea = JBTextArea(4, 60)
        messageArea.lineWrap = true
        messageArea.wrapStyleWord = true
        messageArea.background = panelStrong
        messageArea.foreground = foreground
        messageArea.border = JBUI.Borders.empty(8)
        val messageScroll = JBScrollPane(messageArea)
        messageScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        messageScroll.viewport.background = panelStrong
        messageScroll.preferredSize = Dimension(0, 130)

        val buttons = JPanel(GridLayout(1, 4, 6, 6))
        buttons.isOpaque = false
        val sendA = JButton("发给A")
        val sendB = JButton("发给B")
        val sendBoth = JButton("同时发送")
        val interrupt = JButton("■")
        interrupt.toolTipText = "停止"
        styleButton(sendA, accent, Color.WHITE)
        styleButton(sendB, buttonSecondary, buttonSecondaryFg)
        styleButton(sendBoth, buttonSecondary, buttonSecondaryFg)
        styleButton(interrupt, danger, Color.WHITE)
        buttons.add(sendA)
        buttons.add(sendB)
        buttons.add(sendBoth)
        buttons.add(interrupt)

        val footerRow = JPanel(BorderLayout(8, 0))
        footerRow.isOpaque = false
        footerRow.add(buttons, BorderLayout.WEST)
        val footerStatus = JPanel(FlowLayout(FlowLayout.RIGHT, 8, 0))
        footerStatus.isOpaque = false
        footerStatus.add(statusLabel)
        footerStatus.add(loadingLabel)
        footerRow.add(footerStatus, BorderLayout.CENTER)

        val composerContent = createVerticalContent()
        composerContent.add(messageScroll)
        addSectionGap(composerContent)
        val hintRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        hintRow.isOpaque = false
        hintRow.add(createPillLabel("回车发送给 A", panelStrong, muted, cardBorder))
        hintRow.add(createPillLabel("Shift+回车换行", panelStrong, muted, cardBorder))
        hintRow.add(createPillLabel("输入法候选未确认时不发送", panelStrong, muted, cardBorder))
        composerContent.add(hintRow)
        addSectionGap(composerContent)
        composerContent.add(footerRow)

        val composerCard = createCard("输入", "主输入框只负责当前轮次，主要控制都集中在上方桥接设置。")
        composerCard.add(composerContent, BorderLayout.CENTER)

        val conversationCard = createCard("桥接对话", "统一查看 A、B 与系统消息，让主界面只保留真正的对话上下文。")
        val conversationContent = JPanel(BorderLayout(0, 10))
        conversationContent.isOpaque = false
        val conversationTop = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        conversationTop.isOpaque = false
        conversationTop.add(createPillLabel("Bridge Chat", userBubble, foreground, accent))
        conversationTop.add(conversationStatusLabel)
        conversationTop.add(conversationLoadingLabel)
        conversationContent.add(conversationTop, BorderLayout.NORTH)
        conversationContent.add(chatScroll, BorderLayout.CENTER)
        conversationCard.add(conversationContent, BorderLayout.CENTER)

        val center = JPanel(BorderLayout(0, 10))
        center.isOpaque = false
        center.add(conversationCard, BorderLayout.CENTER)
        center.add(composerCard, BorderLayout.SOUTH)

        panel.add(top, BorderLayout.NORTH)
        panel.add(center, BorderLayout.CENTER)

        val allSessions = mutableListOf<SessionOption>()
        var isSendingA = false
        var isSendingB = false
        var animFrame = 0
        val dots = listOf("·  ", "·· ", "···", " ··")
        val activeSides = linkedSetOf<String>()
        var imeComposing = false
        var compositionJustEndedAt = 0L

        fun appendCard(
            badge: String,
            meta: String,
            text: String,
            background: Color,
            accentColor: Color,
            badgeBackground: Color
        ) {
            ApplicationManager.getApplication().invokeLater {
                val wrapper = JPanel(BorderLayout(0, 6))
                wrapper.isOpaque = false
                wrapper.alignmentX = Component.LEFT_ALIGNMENT
                wrapper.border = JBUI.Borders.emptyBottom(8)

                val metaRow = JPanel(FlowLayout(FlowLayout.LEFT, 6, 0))
                metaRow.isOpaque = false
                metaRow.add(createPillLabel(badge, badgeBackground, foreground, accentColor))
                val metaLabel = JLabel(meta)
                metaLabel.foreground = muted
                metaLabel.font = metaLabel.font.deriveFont(metaLabel.font.size2D - 1f)
                metaRow.add(metaLabel)
                val timeLabel = JLabel(LocalTime.now().format(timeFormatter))
                timeLabel.foreground = muted
                timeLabel.font = timeLabel.font.deriveFont(timeLabel.font.size2D - 1f)
                metaRow.add(timeLabel)

                val body = JBTextArea(text)
                body.isEditable = false
                body.lineWrap = true
                body.wrapStyleWord = true
                body.background = background
                body.foreground = foreground
                body.border = JBUI.Borders.empty(8)
                body.alignmentX = Component.LEFT_ALIGNMENT

                val bubble = JPanel(BorderLayout())
                bubble.background = background
                bubble.border = BorderFactory.createCompoundBorder(
                    BorderFactory.createMatteBorder(0, 4, 0, 0, accentColor),
                    BorderFactory.createCompoundBorder(
                        BorderFactory.createLineBorder(cardBorder, 1, true),
                        JBUI.Borders.empty(0)
                    )
                )
                bubble.add(body, BorderLayout.CENTER)

                wrapper.add(metaRow, BorderLayout.NORTH)
                wrapper.add(bubble, BorderLayout.CENTER)
                chatList.add(wrapper)
                chatList.revalidate()
                chatList.repaint()
                val scrollBar = chatScroll.verticalScrollBar
                scrollBar.value = scrollBar.maximum
            }
        }

        fun append(text: String) {
            val trimmed = text.trim()
            when {
                trimmed.startsWith("[系统] ") -> appendCard(
                    "SYSTEM",
                    "系统消息",
                    trimmed.removePrefix("[系统] "),
                    systemBubble,
                    cardBorder,
                    panelStrong
                )
                trimmed.startsWith("[你->") && trimmed.contains("] ") -> {
                    val end = trimmed.indexOf("] ")
                    val side = trimmed.substring(4, end)
                    appendCard(
                        "YOU",
                        "发给 $side",
                        trimmed.substring(end + 2),
                        userBubble,
                        accent,
                        userBubble
                    )
                }
                trimmed.startsWith("[A] ") -> appendCard(
                    "A",
                    "Assistant",
                    trimmed.removePrefix("[A] "),
                    assistantBubble,
                    accent,
                    userBubble
                )
                trimmed.startsWith("[B] ") -> appendCard(
                    "B",
                    "Assistant",
                    trimmed.removePrefix("[B] "),
                    secondarySoft,
                    accentAlt,
                    secondarySoft
                )
                else -> appendCard("LOG", "日志", trimmed, systemBubble, cardBorder, panelStrong)
            }
        }

        fun updateButtonsAndLoading() {
            val dot = dots[animFrame % dots.size]
            sendA.text = if (isSendingA) "A 生成中$dot" else "发给A"
            sendB.text = if (isSendingB) "B 生成中$dot" else "发给B"
            sendA.isEnabled = !isSendingA
            sendB.isEnabled = !isSendingB
            sendBoth.isEnabled = !(isSendingA && isSendingB)
            val loadingText = if (activeSides.isEmpty()) {
                "就绪"
            } else {
                "生成中 ${activeSides.joinToString("/")} $dot"
            }
            if (activeSides.isEmpty()) {
                loadingLabel.text = loadingText
                conversationLoadingLabel.text = loadingText
            } else {
                loadingLabel.text = loadingText
                conversationLoadingLabel.text = loadingText
            }
        }

        fun updateStatus() {
            val statusText = "A: ${if (isSendingA) "发送中" else "空闲"} | B: ${if (isSendingB) "发送中" else "空闲"}"
            statusLabel.text = statusText
            conversationStatusLabel.text = statusText
            inlineStatusA.text = "A ${if (isSendingA) "发送中" else "空闲"}"
            inlineStatusB.text = "B ${if (isSendingB) "发送中" else "空闲"}"
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

        fun selectedProjectAPath(): String {
            val manual = projectAField.text.trim()
            if (manual.isNotBlank()) return manual
            return (projectASelect.selectedItem as? String).orEmpty().trim()
        }

        fun selectedTool(side: String): CliTool {
            return if (side == "A") {
                toolASelect.selectedItem as? CliTool ?: CliTool.CODEX
            } else {
                toolBSelect.selectedItem as? CliTool ?: CliTool.CODEX
            }
        }

        fun normalizeResumeId(tool: CliTool, rawValue: String, projectPath: String): String {
            val value = rawValue.trim()
            if (value.isBlank()) return ""
            if (value in listOf("新会话", "新对话", "new", "new session")) return ""

            val matched = allSessions.any {
                it.tool == tool.value && it.id == value && matchesProject(it.cwd, projectPath)
            }
            if (matched) return value

            return when (tool) {
                CliTool.CLAUDE -> value.takeIf { Regex("^(urn:uuid:)?[0-9a-fA-F-]{36}$").matches(it) }.orEmpty()
                CliTool.CODEX -> value.takeIf { Regex("^(urn:uuid:)?[0-9a-fA-F-]{8,}$").matches(it) }.orEmpty()
            }
        }

        fun selectedSessionId(side: String): String {
            val manual = if (side == "A") sessionAField.text.trim() else sessionBField.text.trim()
            val tool = selectedTool(side)
            val projectPath = if (side == "A") selectedProjectAPath() else selectedProjectBPath()
            val normalizedManual = normalizeResumeId(tool, manual, projectPath)
            if (normalizedManual.isNotBlank()) return normalizedManual
            val selected = if (side == "A") sessionASelect.selectedItem else sessionBSelect.selectedItem
            return normalizeResumeId(tool, (selected as? SessionComboItem)?.id.orEmpty(), projectPath)
        }

        fun updateSessionDropdowns() {
            val projectA = selectedProjectAPath()
            val projectB = selectedProjectBPath()
            val toolA = selectedTool("A")
            val toolB = selectedTool("B")
            val optionsForA = allSessions.filter { it.tool == toolA.value && matchesProject(it.cwd, projectA) }
            val optionsForB = allSessions.filter { it.tool == toolB.value && matchesProject(it.cwd, projectB) }

            val modelA = DefaultComboBoxModel<SessionComboItem>()
            modelA.addElement(
                SessionComboItem(
                    "",
                    if (toolA == CliTool.CLAUDE) "A Claude 会话（手动输入或续用当前）" else "A会话（可空）"
                )
            )
            optionsForA.forEach { modelA.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionASelect.model = modelA

            val modelB = DefaultComboBoxModel<SessionComboItem>()
            modelB.addElement(
                SessionComboItem(
                    "",
                    if (toolB == CliTool.CLAUDE) "B Claude 会话（手动输入或续用当前）" else "B会话（可空）"
                )
            )
            optionsForB.forEach { modelB.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionBSelect.model = modelB
            sessionASelect.isEnabled = true
            sessionBSelect.isEnabled = true

            val targetA = stored.sessionA.trim()
            if (targetA.isNotBlank()) {
                for (i in 0 until modelA.size) {
                    val item = modelA.getElementAt(i)
                    if (item.id == targetA) {
                        sessionASelect.selectedIndex = i
                        break
                    }
                }
            }

            val targetB = stored.sessionB.trim()
            if (targetB.isNotBlank()) {
                for (i in 0 until modelB.size) {
                    val item = modelB.getElementAt(i)
                    if (item.id == targetB) {
                        sessionBSelect.selectedIndex = i
                        break
                    }
                }
            }
        }

        fun loadOptions() {
            ApplicationManager.getApplication().executeOnPooledThread {
                val options = CodexOptionsLoader.load(defaultProjectA)
                allSessions.clear()
                allSessions.addAll(options.sessions)
                ApplicationManager.getApplication().invokeLater {
                    val projectModelA = DefaultComboBoxModel<String>()
                    projectModelA.addElement("")
                    options.projects.forEach { projectModelA.addElement(it) }
                    projectASelect.model = projectModelA
                    val targetProjectA = stored.projectAPath.trim().ifBlank { defaultProjectA }
                    if (targetProjectA.isNotBlank()) {
                        for (i in 0 until projectModelA.size) {
                            val value = projectModelA.getElementAt(i)
                            if (value == targetProjectA) {
                                projectASelect.selectedIndex = i
                                break
                            }
                        }
                    }

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

            val cwd = if (side == "A") selectedProjectAPath() else selectedProjectBPath()
            val session = selectedSessionId(side)
            val worker = workers.getValue(side).getValue(selectedTool(side))

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
            s.projectAPath = selectedProjectAPath()
            s.projectBPath = selectedProjectBPath()
            s.toolA = (toolASelect.selectedItem as? CliTool ?: CliTool.CODEX).value
            s.toolB = (toolBSelect.selectedItem as? CliTool ?: CliTool.CODEX).value
            s.sessionA = sessionAField.text.trim().ifBlank {
                (sessionASelect.selectedItem as? SessionComboItem)?.id.orEmpty()
            }
            s.sessionB = sessionBField.text.trim().ifBlank {
                (sessionBSelect.selectedItem as? SessionComboItem)?.id.orEmpty()
            }
            s.autoRelayEnabled = autoRelay.isSelected
            s.stopOnStageDone = stopOnDone.isSelected
        }

        projectASelect.addActionListener {
            updateSessionDropdowns()
            saveSettings()
        }
        projectBSelect.addActionListener {
            updateSessionDropdowns()
            saveSettings()
        }
        toolASelect.addActionListener {
            sessionAField.text = ""
            sessionASelect.selectedIndex = 0
            updateSessionDropdowns()
            saveSettings()
        }
        toolBSelect.addActionListener {
            sessionBField.text = ""
            sessionBSelect.selectedIndex = 0
            updateSessionDropdowns()
            saveSettings()
        }
        sessionASelect.addActionListener { saveSettings() }
        sessionBSelect.addActionListener { saveSettings() }
        autoRelay.addActionListener { saveSettings() }
        stopOnDone.addActionListener { saveSettings() }
        bindDocChange(projectAField) {
            updateSessionDropdowns()
            saveSettings()
        }
        bindDocChange(projectBField) {
            updateSessionDropdowns()
            saveSettings()
        }
        bindDocChange(sessionAField) { saveSettings() }
        bindDocChange(sessionBField) { saveSettings() }

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
                workers.getValue("A").values.forEach { it.interrupt() }
                setSending("A", false)
                interrupted = true
            }
            if (isSendingB) {
                workers.getValue("B").values.forEach { it.interrupt() }
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
                    if (imeComposing) return
                    if (System.currentTimeMillis() - compositionJustEndedAt < 80) return
                    e.consume()
                    sendA.doClick()
                }
            }
        })

        messageArea.addInputMethodListener(object : InputMethodListener {
            override fun inputMethodTextChanged(event: InputMethodEvent) {
                val text = event.text
                val total = countCharacters(text)
                imeComposing = total > event.committedCharacterCount
                if (!imeComposing) {
                    compositionJustEndedAt = System.currentTimeMillis()
                }
            }

            override fun caretPositionChanged(event: InputMethodEvent) = Unit
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

    private fun countCharacters(iterator: AttributedCharacterIterator?): Int {
        if (iterator == null) return 0
        var count = 0
        var current = iterator.first()
        while (current != AttributedCharacterIterator.DONE) {
            count++
            current = iterator.next()
        }
        return count
    }
}
