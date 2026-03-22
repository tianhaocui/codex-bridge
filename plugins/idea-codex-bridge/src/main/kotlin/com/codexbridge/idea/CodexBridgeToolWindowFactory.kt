package com.codexbridge.idea

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.GridLayout
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.InputMethodEvent
import java.awt.event.InputMethodListener
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CompletableFuture
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.ScrollPaneConstants
import javax.swing.SwingUtilities
import javax.swing.SwingConstants
import javax.swing.Timer
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener
import javax.swing.text.JTextComponent

class CodexBridgeToolWindowFactory : ToolWindowFactory {
    data class SessionComboItem(val id: String, val label: String) {
        override fun toString(): String = label
    }

    private enum class ChatChannel {
        BRIDGE,
        REMOTE
    }

    private enum class ChatPeer {
        LOCAL,
        REMOTE
    }

    private data class ChatBubbleHandle(
        val textArea: JBTextArea,
        var hasDelta: Boolean = false
    )

    private data class ChatSurface(
        val container: JPanel,
        val chatList: JPanel,
        val scrollPane: JBScrollPane,
        val emptyState: JBLabel?,
        var messageCount: Int = 0
    )

    private data class RemoteRelayTarget(
        val side: String,
        val userPeer: ChatPeer,
        val assistantPeer: ChatPeer
    )

    private data class RemoteSendTarget(
        val side: String,
        val label: String
    )

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val settings = CodexBridgeSettings.getInstance(project)
        val stored = settings.state
        val defaultProjectA = project.basePath ?: ""
        if (stored.remoteToken.isBlank()) stored.remoteToken = RemoteBridgeSupport.defaultRemoteToken()
        if (stored.remoteDeviceName.isBlank()) stored.remoteDeviceName = localDeviceName()

        val localRemoteNodeId = UUID.randomUUID().toString()

        val panelBackground = JBColor(Color(243, 245, 248), Color(24, 27, 32))
        val foreground = JBColor(Color(31, 35, 40), Color(232, 236, 242))
        val muted = JBColor(Color(101, 109, 122), Color(147, 161, 176))
        val accent = JBColor(Color(0, 122, 255), Color(10, 132, 255))
        val accentAlt = JBColor(Color(59, 110, 255), Color(82, 146, 255))
        val danger = JBColor(Color(255, 59, 48), Color(255, 69, 58))
        val warning = JBColor(Color(210, 153, 34), Color(214, 170, 77))
        val success = JBColor(Color(46, 160, 67), Color(61, 196, 108))
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
            titleLabel.font = titleLabel.font.deriveFont(Font.BOLD, titleLabel.font.size2D + 2f)
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
            val noteLabel = JBLabel("<html><body style='width:100%'>$note</body></html>")
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
                val hintLabel = JBLabel("<html><body style='width:100%'>$hint</body></html>")
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
            val hintLabel = JBLabel("<html><body style='width:100%'>$hint</body></html>")
            hintLabel.foreground = muted
            hintLabel.font = hintLabel.font.deriveFont(hintLabel.font.size2D - 1f)
            wrapper.add(hintLabel, BorderLayout.CENTER)
            return wrapper
        }

        fun createCollapsibleCard(
            title: String,
            subtitle: String,
            body: JComponent,
            badgeText: String,
            expandedInitially: Boolean,
            onToggle: (Boolean) -> Unit = {}
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
            titleLabel.font = titleLabel.font.deriveFont(Font.BOLD, titleLabel.font.size2D + 1f)
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
            styleButton(toggleButton, buttonSecondary, buttonSecondaryFg)
            actions.add(summaryBadge)
            actions.add(toggleButton)

            val bodyWrapper = JPanel(BorderLayout())
            bodyWrapper.isOpaque = false
            bodyWrapper.add(body, BorderLayout.CENTER)
            bodyWrapper.isVisible = expandedInitially

            toggleButton.addActionListener {
                bodyWrapper.isVisible = !bodyWrapper.isVisible
                toggleButton.text = if (bodyWrapper.isVisible) "收起" else "展开"
                onToggle(bodyWrapper.isVisible)
                card.revalidate()
                card.repaint()
            }

            header.add(copy, BorderLayout.CENTER)
            header.add(actions, BorderLayout.EAST)
            card.add(header, BorderLayout.NORTH)
            card.add(bodyWrapper, BorderLayout.CENTER)
            return card
        }

        fun createStatusDot(): JLabel = JBLabel("●").apply {
            font = font.deriveFont(font.size2D + 1f)
        }

        fun applyConnectivityDot(dot: JLabel, connectivity: RemoteConnectivity) {
            dot.foreground = when (connectivity) {
                RemoteConnectivity.OK -> success
                RemoteConnectivity.ERROR -> danger
                RemoteConnectivity.CHECKING -> warning
                RemoteConnectivity.IDLE -> muted
            }
        }

        fun createChatSurface(emptyStateText: String? = null): ChatSurface {
            val list = JPanel()
            list.layout = BoxLayout(list, BoxLayout.Y_AXIS)
            list.background = chatBackground
            list.border = JBUI.Borders.empty(8)

            val scroll = JBScrollPane(list)
            scroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
            scroll.viewport.background = chatBackground
            scroll.preferredSize = Dimension(0, 360)

            val container = JPanel(BorderLayout(0, 8))
            container.isOpaque = false
            val empty = emptyStateText?.let {
                JBLabel("<html><body style='width:100%'>$it</body></html>").apply {
                    this.foreground = muted
                    border = BorderFactory.createCompoundBorder(
                        BorderFactory.createDashedBorder(cardBorder, 3f, 3f),
                        JBUI.Borders.empty(12)
                    )
                    this.background = panelStrongAlt
                    isOpaque = true
                }
            }
            if (empty != null) {
                container.add(empty, BorderLayout.NORTH)
            }
            container.add(scroll, BorderLayout.CENTER)
            return ChatSurface(container, list, scroll, empty)
        }

        fun createPageHero(eyebrowText: String, title: String, subtitle: String, vararg pills: JLabel): JPanel {
            val heroCard = createCard(title, subtitle)
            val heroContent = createVerticalContent()
            val eyebrow = JBLabel(eyebrowText)
            eyebrow.foreground = muted
            eyebrow.font = eyebrow.font.deriveFont(eyebrow.font.size2D - 2f)
            val heroPills = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
            heroPills.isOpaque = false
            pills.forEach { heroPills.add(it) }
            heroContent.add(eyebrow)
            heroContent.add(Box.createRigidArea(Dimension(0, 8)))
            heroContent.add(heroPills)
            heroCard.add(heroContent, BorderLayout.CENTER)
            return heroCard
        }

        fun createTabButton(label: String): JButton = JButton(label).apply {
            styleButton(this, buttonSecondary, buttonSecondaryFg)
            horizontalAlignment = SwingConstants.LEFT
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
        }

        val projectASelect = JComboBox<String>()
        val projectAField = JBTextField(stored.projectAPath.ifBlank { defaultProjectA })
        val toolASelect = JComboBox(BridgeCliTool.entries.toTypedArray())
        val toolBSelect = JComboBox(BridgeCliTool.entries.toTypedArray())
        toolASelect.selectedItem = BridgeCliTool.fromValue(stored.toolA)
        toolBSelect.selectedItem = BridgeCliTool.fromValue(stored.toolB)
        val projectBSelect = JComboBox<String>()
        val projectBField = JBTextField(stored.projectBPath)
        val sessionASelect = JComboBox<SessionComboItem>()
        val sessionBSelect = JComboBox<SessionComboItem>()
        val sessionAField = JBTextField(stored.sessionA)
        val sessionBField = JBTextField(stored.sessionB)
        projectAField.emptyText.text = "Project A 可手动输入（优先）"
        projectBField.emptyText.text = "Project B 可手动输入（优先）"
        sessionAField.emptyText.text = "A 会话 ID 可手动输入（优先）"
        sessionBField.emptyText.text = "B 会话 ID 可手动输入（优先）"

        val autoRelay = JBCheckBox("自动互发", stored.autoRelayEnabled)
        val stopOnDone = JBCheckBox("阶段完成自动停止", stored.stopOnStageDone)
        val bridgeStatusLabel = createPillLabel("A: 空闲 | B: 空闲", panelStrong, foreground, cardBorder)
        val bridgeLoadingLabel = createPillLabel("就绪", userBubble, foreground, accent)
        val bridgeInlineStatusA = createPillLabel("A 空闲", panelStrong, foreground, cardBorder)
        val bridgeInlineStatusB = createPillLabel("B 空闲", panelStrong, foreground, cardBorder)

        val remoteModeSelect = JComboBox(RemoteMode.entries.toTypedArray())
        remoteModeSelect.selectedItem = RemoteMode.fromValue(stored.remoteMode)
        val remoteUrlField = JBTextField(stored.remoteUrl)
        val remoteHubUrlField = JBTextField(stored.remoteHubUrl)
        val remotePeerSelect = JComboBox<RemotePeerOption>()
        val remotePeerIdField = JBTextField(stored.remotePeerId)
        val remoteDeviceNameField = JBTextField(stored.remoteDeviceName)
        val remoteTokenField = JBTextField(RemoteBridgeSupport.normalizeRemoteToken(stored.remoteToken))
        val remoteListenPortField = JBTextField(stored.remoteListenPort.toString())
        val remoteExportSideSelect = JComboBox(arrayOf("A", "B"))
        remoteExportSideSelect.selectedItem = if (stored.remoteExportSide == "B") "B" else "A"
        val remoteTargetToolSelect = JComboBox(arrayOf(BridgeCliTool.CODEX, BridgeCliTool.CLAUDE))
        remoteTargetToolSelect.selectedItem = BridgeCliTool.fromRemoteTarget(stored.remoteTargetTool)
        val remoteTargetProjectField = JBTextField(stored.remoteTargetProjectPath)
        val remoteTargetSessionField = JBTextField(stored.remoteTargetSessionId)
        val remoteShareSessionSelect = JComboBox<SessionComboItem>()
        val remoteShareSessionField = JBTextField()
        val remoteShareSummaryLabel = JBLabel("")
        remoteShareSummaryLabel.foreground = muted
        val remoteAutoRelay = JBCheckBox("跨设备自动接力", stored.remoteAutoRelayEnabled)
        val remoteSnippetArea = JBTextArea(stored.remoteTargetLabel, 6, 60)
        remoteSnippetArea.isEditable = false
        remoteSnippetArea.lineWrap = true
        remoteSnippetArea.wrapStyleWord = true
        val remotePasteArea = JBTextArea(6, 60)
        remotePasteArea.lineWrap = true
        remotePasteArea.wrapStyleWord = true
        remoteUrlField.emptyText.text = "远端 URL，例如 http://192.168.3.110:9238"
        remoteHubUrlField.emptyText.text = "Hub URL，例如 http://bridge-hub.local:9239"
        remotePeerIdField.emptyText.text = "Remote 要连接的目标节点 ID，可手填覆盖下拉"
        remoteTokenField.emptyText.text = "认证 Token，用于远端 / Hub 鉴权"
        remoteDeviceNameField.emptyText.text = "当前设备名（主机注册到 Hub 时展示）"
        remoteListenPortField.emptyText.text = RemoteBridgeSupport.DEFAULT_REMOTE_PORT.toString()
        remoteTargetProjectField.emptyText.text = "转发到远端时要使用的项目路径"
        remoteTargetSessionField.emptyText.text = "转发到远端时要使用的线程 ID"
        remoteShareSessionField.emptyText.text = "留空时使用左侧选择；都留空则 new-session"
        remotePasteArea.emptyText.text = "把对方复制的 Remote 连接配置粘贴到这里，然后点击“应用配置”"

        val copyRemoteConfigButton = JButton("复制连接配置")
        val applyRemoteConfigButton = JButton("应用配置")
        val refreshRemotePeersButton = JButton("刷新节点")
        val remoteConversationStatusLabel = createPillLabel("远程未启用", panelStrong, foreground, cardBorder)
        val remoteConversationLoadingLabel = createPillLabel("就绪", userBubble, foreground, accent)
        val remoteConnectivityDot = createStatusDot()
        val remoteConnectivityLabel = JBLabel("链路状态")
        remoteConnectivityLabel.foreground = foreground
        val remoteStatusTextLabel = JBLabel("未启用")
        remoteStatusTextLabel.foreground = muted
        val remoteTokenHintLabel = JBLabel(RemoteBridgeSupport.DEFAULT_REMOTE_TOKEN_HINT)
        remoteTokenHintLabel.foreground = muted
        val remoteTargetLabelValue = JBLabel("")
        remoteTargetLabelValue.foreground = muted
        val remoteCopyStatusLabel = JBLabel("")
        remoteCopyStatusLabel.foreground = muted
        val remoteShareStatusLabel = JBLabel("")
        remoteShareStatusLabel.foreground = muted

        val bridgeMessageArea = JBTextArea(4, 60)
        bridgeMessageArea.lineWrap = true
        bridgeMessageArea.wrapStyleWord = true
        val bridgeMessageScroll = JBScrollPane(bridgeMessageArea)
        val sendAButton = JButton("发给A")
        val sendBButton = JButton("发给B")
        val sendBothButton = JButton("同时发送")
        val interruptBridgeButton = JButton("■")

        val remoteMessageArea = JBTextArea(4, 60)
        remoteMessageArea.lineWrap = true
        remoteMessageArea.wrapStyleWord = true
        val remoteMessageScroll = JBScrollPane(remoteMessageArea)
        val remoteSendAButton = JButton("发到 Remote A")
        val remoteSendBButton = JButton("发到 Remote B")
        val remoteSendBothButton = JButton("发到全部 Remote")
        val interruptRemoteButton = JButton("■")
        val remoteSendHintLabel = JBLabel("")
        remoteSendHintLabel.foreground = muted
        remoteSendHintLabel.font = remoteSendHintLabel.font.deriveFont(remoteSendHintLabel.font.size2D - 1f)

        val bridgeSurface = createChatSurface()
        val remoteSurface = createChatSurface(
            "先把 A 或 B 的工具切到 Remote，或先粘贴连接配置。配置完成后，就可以直接在这里继续跨设备会话。"
        )

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
            sessionBField,
            remoteModeSelect,
            remoteUrlField,
            remoteHubUrlField,
            remotePeerSelect,
            remotePeerIdField,
            remoteDeviceNameField,
            remoteTokenField,
            remoteListenPortField,
            remoteExportSideSelect,
            remoteTargetToolSelect,
            remoteTargetProjectField,
            remoteTargetSessionField,
            remoteShareSessionSelect,
            remoteShareSessionField
        ).forEach { styleInput(it) }
        styleInput(bridgeMessageArea, 120)
        styleInput(remoteMessageArea, 120)
        bridgeMessageScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        bridgeMessageScroll.viewport.background = panelStrong
        bridgeMessageScroll.preferredSize = Dimension(0, 128)
        remoteMessageScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        remoteMessageScroll.viewport.background = panelStrong
        remoteMessageScroll.preferredSize = Dimension(0, 128)
        remoteSnippetArea.background = panelStrongAlt
        remoteSnippetArea.foreground = foreground
        remoteSnippetArea.border = JBUI.Borders.empty(8)
        remotePasteArea.background = panelStrong
        remotePasteArea.foreground = foreground
        remotePasteArea.border = JBUI.Borders.empty(8)

        styleButton(sendAButton, accent, Color.WHITE)
        styleButton(sendBButton, buttonSecondary, buttonSecondaryFg)
        styleButton(sendBothButton, buttonSecondary, buttonSecondaryFg)
        styleButton(interruptBridgeButton, danger, Color.WHITE)
        styleButton(remoteSendAButton, accent, Color.WHITE)
        styleButton(remoteSendBButton, buttonSecondary, buttonSecondaryFg)
        styleButton(remoteSendBothButton, buttonSecondary, buttonSecondaryFg)
        styleButton(interruptRemoteButton, danger, Color.WHITE)
        styleButton(copyRemoteConfigButton, accent, Color.WHITE)
        styleButton(applyRemoteConfigButton, buttonSecondary, buttonSecondaryFg)
        styleButton(refreshRemotePeersButton, buttonSecondary, buttonSecondaryFg)

        val bridgeChatTabButton = createTabButton("桥接对话")
        val remoteTabButton = createTabButton("远程对接")

        fun createNavRail(): JPanel {
            val title = JBLabel("Codex Bridge")
            title.foreground = foreground
            title.font = title.font.deriveFont(Font.BOLD, title.font.size2D + 2f)

            val subtitle = JBLabel("<html><body style='width:100%'>Bridge 与 Remote 共用一个左侧导航，主区域只展示当前页内容。</body></html>")
            subtitle.foreground = muted
            subtitle.font = subtitle.font.deriveFont(subtitle.font.size2D - 1f)

            val navButtons = JPanel(GridLayout(0, 1, 0, 8))
            navButtons.isOpaque = false
            navButtons.add(bridgeChatTabButton)
            navButtons.add(remoteTabButton)

            val nav = JPanel()
            nav.layout = BoxLayout(nav, BoxLayout.Y_AXIS)
            nav.background = panelStrongAlt
            nav.border = BorderFactory.createCompoundBorder(
                BorderFactory.createLineBorder(cardBorder, 1, true),
                JBUI.Borders.empty(12)
            )
            nav.preferredSize = Dimension(180, 0)
            nav.add(title)
            nav.add(Box.createRigidArea(Dimension(0, 6)))
            nav.add(subtitle)
            nav.add(Box.createRigidArea(Dimension(0, 12)))
            nav.add(navButtons)
            nav.add(Box.createVerticalGlue())
            return nav
        }

        val hostOnlySections = mutableListOf<JComponent>()
        val clientOnlySections = mutableListOf<JComponent>()

        fun currentRemoteMode(): RemoteMode = remoteModeSelect.selectedItem as? RemoteMode ?: RemoteMode.OFF
        fun selectedTool(side: String): BridgeCliTool =
            if (side == "A") (toolASelect.selectedItem as? BridgeCliTool ?: BridgeCliTool.CODEX)
            else (toolBSelect.selectedItem as? BridgeCliTool ?: BridgeCliTool.CODEX)

        fun selectedProjectAPath(): String {
            val manual = projectAField.text.trim()
            if (manual.isNotBlank()) return manual
            return (projectASelect.selectedItem as? String).orEmpty().trim()
        }

        fun selectedProjectBPath(): String {
            val manual = projectBField.text.trim()
            if (manual.isNotBlank()) return manual
            return (projectBSelect.selectedItem as? String).orEmpty().trim()
        }

        var remotePeerOptions: List<RemotePeerOption> = emptyList()
        var remoteConnectivity = RemoteConnectivity.IDLE
        var remoteStatusText = "未启用"
        var remoteTargetLabelText = stored.remoteTargetLabel

        fun selectedRemotePeerId(): String {
            val manual = remotePeerIdField.text.trim()
            if (manual.isNotBlank()) return manual
            return (remotePeerSelect.selectedItem as? RemotePeerOption)?.id.orEmpty()
        }

        fun selectedRemoteExportSide(): String = if (remoteExportSideSelect.selectedItem == "B") "B" else "A"
        fun selectedRemoteTargetTool(): BridgeCliTool =
            (remoteTargetToolSelect.selectedItem as? BridgeCliTool ?: BridgeCliTool.CODEX)
                .takeUnless { it == BridgeCliTool.REMOTE } ?: BridgeCliTool.CODEX

        fun currentRemoteConfig(): RemoteWorkerConfig {
            val listenPort = remoteListenPortField.text.trim().toIntOrNull() ?: stored.remoteListenPort
            return RemoteWorkerConfig(
                mode = currentRemoteMode(),
                url = remoteUrlField.text.trim(),
                token = RemoteBridgeSupport.normalizeRemoteToken(remoteTokenField.text.trim(), stored.remoteToken),
                hubUrl = remoteHubUrlField.text.trim(),
                peerId = selectedRemotePeerId(),
                targetTool = selectedRemoteTargetTool(),
                targetProjectPath = remoteTargetProjectField.text.trim(),
                targetSessionId = remoteTargetSessionField.text.trim()
            ).also {
                if (listenPort in 1..65535) {
                    stored.remoteListenPort = listenPort
                }
            }
        }

        val remoteWorkers = mapOf(
            "A" to RemoteWorker { currentRemoteConfig() },
            "B" to RemoteWorker { currentRemoteConfig() }
        )
        val workers = mapOf(
            "A" to mapOf(
                BridgeCliTool.CODEX to CodexWorker() as BridgeWorker,
                BridgeCliTool.CLAUDE to ClaudeWorker() as BridgeWorker,
                BridgeCliTool.REMOTE to remoteWorkers.getValue("A") as BridgeWorker
            ),
            "B" to mapOf(
                BridgeCliTool.CODEX to CodexWorker() as BridgeWorker,
                BridgeCliTool.CLAUDE to ClaudeWorker() as BridgeWorker,
                BridgeCliTool.REMOTE to remoteWorkers.getValue("B") as BridgeWorker
            )
        )

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

        val allSessions = mutableListOf<SessionOption>()

        fun normalizeResumeId(tool: BridgeCliTool, rawValue: String, projectPath: String): String {
            if (tool == BridgeCliTool.REMOTE) return ""
            val value = rawValue.trim()
            if (value.isBlank()) return ""
            if (value.lowercase() in setOf("新会话", "新对话", "new", "new session")) return ""

            val matched = allSessions.any {
                it.tool == tool.value && it.id == value && matchesProject(it.cwd, projectPath)
            }
            if (matched) return value

            return when (tool) {
                BridgeCliTool.CLAUDE -> value.takeIf { Regex("^(urn:uuid:)?[0-9a-fA-F-]{36}$").matches(it) }.orEmpty()
                BridgeCliTool.CODEX -> value.takeIf { Regex("^(urn:uuid:)?[0-9a-fA-F-]{8,}$").matches(it) }.orEmpty()
                BridgeCliTool.REMOTE -> ""
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

        fun remoteConversationSides(): List<String> {
            if (currentRemoteMode() == RemoteMode.HOST) return listOf(selectedRemoteExportSide())
            val sides = mutableListOf<String>()
            if (selectedTool("A") == BridgeCliTool.REMOTE) sides += "A"
            if (selectedTool("B") == BridgeCliTool.REMOTE) sides += "B"
            return sides
        }

        fun remoteConversationSendSides(): List<String> {
            if (currentRemoteMode() == RemoteMode.HOST) return listOf(selectedRemoteExportSide())
            val remoteSides = remoteConversationSides()
            if (remoteSides.size == 1) {
                val remoteSide = remoteSides.first()
                val localSide = if (remoteSide == "A") "B" else "A"
                if (selectedTool(localSide) != BridgeCliTool.REMOTE) {
                    return listOf(localSide, remoteSide)
                }
            }
            return remoteSides
        }

        fun nextRemoteRelayTarget(fromSide: String): RemoteRelayTarget? {
            if (currentRemoteMode() != RemoteMode.CLIENT) return null
            val remoteSides = remoteConversationSides()
            if (remoteSides.size != 1) return null
            val remoteSide = remoteSides.first()
            val localSide = if (remoteSide == "A") "B" else "A"
            if (selectedTool(localSide) == BridgeCliTool.REMOTE) return null
            return when (fromSide) {
                remoteSide -> RemoteRelayTarget(localSide, ChatPeer.REMOTE, ChatPeer.LOCAL)
                localSide -> RemoteRelayTarget(remoteSide, ChatPeer.LOCAL, ChatPeer.REMOTE)
                else -> null
            }
        }

        fun remoteSendTargets(): List<RemoteSendTarget> {
            if (currentRemoteMode() == RemoteMode.HOST) {
                return listOf(RemoteSendTarget(selectedRemoteExportSide(), "发给本机 AI"))
            }

            val remoteSides = remoteConversationSides()
            if (remoteSides.size == 1) {
                val remoteSide = remoteSides.first()
                val localSide = if (remoteSide == "A") "B" else "A"
                if (selectedTool(localSide) != BridgeCliTool.REMOTE) {
                    return listOf(
                        RemoteSendTarget(localSide, "发给本机 AI"),
                        RemoteSendTarget(remoteSide, "发给远端 AI")
                    )
                }
            }

            return remoteSides.map { side -> RemoteSendTarget(side, "发给 Remote $side") }
        }

        fun pickRemoteImportSide(): String {
            if (selectedTool("A") == BridgeCliTool.REMOTE) return "A"
            if (selectedTool("B") == BridgeCliTool.REMOTE) return "B"

            fun score(side: String): Int {
                val projectPath = if (side == "A") selectedProjectAPath() else selectedProjectBPath()
                val sessionId = if (side == "A") sessionAField.text.trim() else sessionBField.text.trim()
                var points = 0
                if (projectPath.isBlank()) points += 4
                if (sessionId.isBlank()) points += 2
                if (selectedTool(side) != BridgeCliTool.CODEX) points += 1
                return points
            }

            val scoreA = score("A")
            val scoreB = score("B")
            return if (scoreA == scoreB) "B" else if (scoreA > scoreB) "A" else "B"
        }

        var isSendingA = false
        var isSendingB = false
        var animFrame = 0
        val dots = listOf("·  ", "·· ", "···", " ··")
        val activeSides = linkedSetOf<String>()
        var imeComposing = false
        var compositionJustEndedAt = 0L

        fun updateSurfaceEmptyState(surface: ChatSurface) {
            surface.emptyState?.isVisible = surface.messageCount == 0
        }

        fun scrollSurfaceToBottom(surface: ChatSurface) {
            SwingUtilities.invokeLater {
                val scrollBar = surface.scrollPane.verticalScrollBar
                scrollBar.value = scrollBar.maximum
            }
        }

        fun appendBubble(
            surface: ChatSurface,
            badge: String,
            meta: String,
            initialText: String,
            background: Color,
            accentColor: Color,
            badgeBackground: Color
        ): ChatBubbleHandle {
            val textArea = JBTextArea(initialText.ifBlank { "生成中..." })
            textArea.isEditable = false
            textArea.lineWrap = true
            textArea.wrapStyleWord = true
            textArea.background = background
            textArea.foreground = foreground
            textArea.border = JBUI.Borders.empty(8)

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
            val timeLabel = JLabel(java.time.LocalTime.now().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss")))
            timeLabel.foreground = muted
            timeLabel.font = timeLabel.font.deriveFont(timeLabel.font.size2D - 1f)
            metaRow.add(timeLabel)

            val bubble = JPanel(BorderLayout())
            bubble.background = background
            bubble.border = BorderFactory.createCompoundBorder(
                BorderFactory.createMatteBorder(0, 4, 0, 0, accentColor),
                BorderFactory.createCompoundBorder(
                    BorderFactory.createLineBorder(cardBorder, 1, true),
                    JBUI.Borders.empty(0)
                )
            )
            bubble.add(textArea, BorderLayout.CENTER)

            wrapper.add(metaRow, BorderLayout.NORTH)
            wrapper.add(bubble, BorderLayout.CENTER)

            ApplicationManager.getApplication().invokeLater {
                surface.chatList.add(wrapper)
                surface.messageCount += 1
                updateSurfaceEmptyState(surface)
                surface.chatList.revalidate()
                surface.chatList.repaint()
                scrollSurfaceToBottom(surface)
            }
            return ChatBubbleHandle(textArea)
        }

        fun updateBubble(handle: ChatBubbleHandle, delta: String, finalText: String? = null) {
            ApplicationManager.getApplication().invokeLater {
                if (finalText != null) {
                    handle.textArea.text = finalText.ifBlank { "(空回复)" }
                    handle.textArea.revalidate()
                    handle.textArea.repaint()
                    return@invokeLater
                }
                if (delta.isEmpty()) return@invokeLater
                if (!handle.hasDelta && handle.textArea.text == "生成中...") {
                    handle.textArea.text = delta
                } else {
                    handle.textArea.append(delta)
                }
                handle.hasDelta = true
                handle.textArea.revalidate()
                handle.textArea.repaint()
            }
        }

        fun surfaceFor(channel: ChatChannel): ChatSurface = if (channel == ChatChannel.REMOTE) remoteSurface else bridgeSurface

        fun appendSystem(text: String, side: String? = null, channel: ChatChannel = ChatChannel.BRIDGE) {
            val meta = when {
                channel == ChatChannel.REMOTE && side != null -> "系统消息 · $side"
                channel == ChatChannel.REMOTE -> "Remote 系统消息"
                side != null -> "系统消息 · $side"
                else -> "系统消息"
            }
            appendBubble(surfaceFor(channel), "SYSTEM", meta, text, systemBubble, cardBorder, panelStrong)
        }

        fun appendUser(side: String, text: String, channel: ChatChannel, peer: ChatPeer?) {
            if (channel == ChatChannel.REMOTE) {
                val sourcePeer = peer ?: ChatPeer.LOCAL
                val badge = if (sourcePeer == ChatPeer.REMOTE) "REMOTE" else "LOCAL"
                val meta = if (sourcePeer == ChatPeer.REMOTE) "远端发起 -> $side" else "本机发起 -> $side"
                appendBubble(remoteSurface, badge, meta, text, userBubble, accent, userBubble)
            } else {
                appendBubble(bridgeSurface, "YOU", "发给 $side", text, userBubble, accent, userBubble)
            }
        }

        fun appendAssistant(side: String, channel: ChatChannel, peer: ChatPeer?): ChatBubbleHandle {
            return if (channel == ChatChannel.REMOTE) {
                val actualPeer = peer ?: ChatPeer.REMOTE
                val badge = if (actualPeer == ChatPeer.REMOTE) "REMOTE" else "LOCAL"
                val meta = if (actualPeer == ChatPeer.REMOTE) "远端 AI · $side" else "本机 AI · $side"
                val background = if (actualPeer == ChatPeer.REMOTE) secondarySoft else assistantBubble
                val accentColor = if (actualPeer == ChatPeer.REMOTE) accentAlt else accent
                appendBubble(remoteSurface, badge, meta, "", background, accentColor, background)
            } else {
                val bubbleColor = if (side == "B") secondarySoft else assistantBubble
                val accentColor = if (side == "B") accentAlt else accent
                appendBubble(bridgeSurface, side, "Assistant", "", bubbleColor, accentColor, bubbleColor)
            }
        }

        fun currentRemoteHint(): String {
            val sides = remoteConversationSides()
            if (sides.isEmpty() && currentRemoteMode() != RemoteMode.HOST) {
                return "当前没有可用的跨设备对话流。先把 A 或 B 切到 Remote，或先粘贴连接配置。"
            }
            if (currentRemoteMode() == RemoteMode.HOST) {
                return "当前作为主机导出本机 ${selectedRemoteExportSide()}，远端发来的消息和本机插话都会落在这条共享线程里。"
            }
            if (remoteAutoRelay.isSelected) {
                return "已开启自动接力，本机 AI 和远端 AI 会按回复继续对话，直到你手动停止或命中阶段完成标记。"
            }
            return when (sides.size) {
                1 -> "当前将把消息注入 Remote ${sides.first()} 对应的远端 AI 线程。"
                else -> "当前可同时向 Remote A/B 注入消息。"
            }
        }

        fun currentRemoteConversationStatus(): String {
            val mode = currentRemoteMode()
            val connectivityText = when (remoteConnectivity) {
                RemoteConnectivity.OK -> "已连接"
                RemoteConnectivity.ERROR -> "连接异常"
                RemoteConnectivity.CHECKING -> "检查中"
                RemoteConnectivity.IDLE -> "未启用"
            }
            if (mode == RemoteMode.OFF) return "远程未启用"
            if (mode == RemoteMode.HOST) {
                return "Host 导出 ${selectedRemoteExportSide()} · $connectivityText" +
                    if (remoteAutoRelay.isSelected) " · 自动接力开" else ""
            }
            val sides = remoteConversationSides()
            val sideText = when (sides.size) {
                0 -> "Remote 未接入"
                1 -> "Remote ${sides.first()}"
                else -> "Remote A/B"
            }
            return "$sideText · $connectivityText" + if (remoteAutoRelay.isSelected) " · 自动接力开" else ""
        }

        fun currentRemoteEmptyStateText(): String {
            return when (currentRemoteMode()) {
                RemoteMode.OFF -> "启用远程主机或客户端模式后，这里会显示跨设备对话流。"
                RemoteMode.HOST -> "主机模式已启用，等待远端接入或直接向共享线程注入本机消息。"
                RemoteMode.CLIENT -> "先把 A 或 B 的工具切到 Remote，或者先粘贴连接配置。配置完成后，就可以直接在这里继续跨设备会话。"
            }
        }

        fun updateSessionDropdowns() {
            val projectA = selectedProjectAPath()
            val projectB = selectedProjectBPath()
            val toolA = selectedTool("A")
            val toolB = selectedTool("B")
            val optionsForA = if (toolA == BridgeCliTool.REMOTE) emptyList() else allSessions.filter {
                it.tool == toolA.value && matchesProject(it.cwd, projectA)
            }
            val optionsForB = if (toolB == BridgeCliTool.REMOTE) emptyList() else allSessions.filter {
                it.tool == toolB.value && matchesProject(it.cwd, projectB)
            }

            val modelA = DefaultComboBoxModel<SessionComboItem>()
            val defaultTextA = when (toolA) {
                BridgeCliTool.CLAUDE -> "A Claude 会话（手动输入或续用当前）"
                BridgeCliTool.REMOTE -> "A Remote（不使用本地会话）"
                else -> "A 会话（可空）"
            }
            modelA.addElement(SessionComboItem("", defaultTextA))
            optionsForA.forEach { modelA.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionASelect.model = modelA

            val modelB = DefaultComboBoxModel<SessionComboItem>()
            val defaultTextB = when (toolB) {
                BridgeCliTool.CLAUDE -> "B Claude 会话（手动输入或续用当前）"
                BridgeCliTool.REMOTE -> "B Remote（不使用本地会话）"
                else -> "B 会话（可空）"
            }
            modelB.addElement(SessionComboItem("", defaultTextB))
            optionsForB.forEach { modelB.addElement(SessionComboItem(it.id, it.displayLabel)) }
            sessionBSelect.model = modelB
            sessionASelect.isEnabled = toolA != BridgeCliTool.REMOTE
            sessionBSelect.isEnabled = toolB != BridgeCliTool.REMOTE

            val targetA = stored.sessionA.trim()
            if (targetA.isNotBlank()) {
                for (index in 0 until modelA.size) {
                    if (modelA.getElementAt(index).id == targetA) {
                        sessionASelect.selectedIndex = index
                        break
                    }
                }
            }
            val targetB = stored.sessionB.trim()
            if (targetB.isNotBlank()) {
                for (index in 0 until modelB.size) {
                    if (modelB.getElementAt(index).id == targetB) {
                        sessionBSelect.selectedIndex = index
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

                    val projectModelB = DefaultComboBoxModel<String>()
                    projectModelB.addElement("")
                    options.projects.forEach { projectModelB.addElement(it) }
                    projectBSelect.model = projectModelB

                    val targetProjectA = stored.projectAPath.trim().ifBlank { defaultProjectA }
                    if (targetProjectA.isNotBlank()) {
                        for (index in 0 until projectModelA.size) {
                            if (projectModelA.getElementAt(index) == targetProjectA) {
                                projectASelect.selectedIndex = index
                                break
                            }
                        }
                    }

                    val targetProjectB = stored.projectBPath.trim()
                    if (targetProjectB.isNotBlank()) {
                        for (index in 0 until projectModelB.size) {
                            if (projectModelB.getElementAt(index) == targetProjectB) {
                                projectBSelect.selectedIndex = index
                                break
                            }
                        }
                    }
                    updateSessionDropdowns()
                }
            }
        }

        fun updatePeerSelectModel() {
            ApplicationManager.getApplication().invokeLater {
                val model = DefaultComboBoxModel<RemotePeerOption>()
                model.addElement(RemotePeerOption("", "选择 Remote 要连接的 Hub 节点（可空）"))
                remotePeerOptions.forEach { model.addElement(it) }
                remotePeerSelect.model = model
                val selectedPeerId = selectedRemotePeerId().ifBlank {
                    if (remotePeerOptions.size == 1) remotePeerOptions.first().id else ""
                }
                if (selectedPeerId.isNotBlank()) {
                    if (remotePeerOptions.none { it.id == selectedPeerId } && remotePeerIdField.text.trim() == selectedPeerId) {
                        remotePeerIdField.text = ""
                    }
                    for (index in 0 until model.size) {
                        if (model.getElementAt(index).id == selectedPeerId) {
                            remotePeerSelect.selectedIndex = index
                            break
                        }
                    }
                }
            }
        }

        var syncingRemoteShareMirror = false

        fun selectedRemoteShareSessionId(): String {
            val side = selectedRemoteExportSide()
            val tool = selectedTool(side).takeUnless { it == BridgeCliTool.REMOTE } ?: selectedRemoteTargetTool()
            val projectPath = if (side == "A") selectedProjectAPath() else selectedProjectBPath()
            val manual = remoteShareSessionField.text.trim()
            val normalizedManual = normalizeResumeId(tool, manual, projectPath)
            if (normalizedManual.isNotBlank()) return normalizedManual
            return normalizeResumeId(
                tool,
                (remoteShareSessionSelect.selectedItem as? SessionComboItem)?.id.orEmpty(),
                projectPath
            )
        }

        fun updateRemoteShareMirror() {
            val side = selectedRemoteExportSide()
            val sourceSelect = if (side == "A") sessionASelect else sessionBSelect
            val sourceField = if (side == "A") sessionAField else sessionBField
            val exportTool = selectedTool(side).takeUnless { it == BridgeCliTool.REMOTE } ?: selectedRemoteTargetTool()
            val exportProjectPath = if (side == "A") selectedProjectAPath() else selectedProjectBPath()

            val model = DefaultComboBoxModel<SessionComboItem>()
            for (index in 0 until sourceSelect.itemCount) {
                model.addElement(sourceSelect.getItemAt(index))
            }
            if (model.size == 0) {
                model.addElement(SessionComboItem("", "新会话（留空）"))
            }
            remoteShareSessionSelect.model = model

            syncingRemoteShareMirror = true
            remoteShareSessionField.text = sourceField.text.trim()
            if (sourceField.text.trim().isBlank()) {
                remoteShareSessionSelect.selectedIndex = sourceSelect.selectedIndex.coerceAtLeast(0)
            } else {
                remoteShareSessionSelect.selectedIndex = 0
            }
            syncingRemoteShareMirror = false

            val enabled = selectedTool(side) != BridgeCliTool.REMOTE
            remoteShareSessionSelect.isEnabled = enabled
            remoteShareSessionField.isEnabled = enabled
            remoteShareSummaryLabel.text =
                "当前复制将导出 $side · ${exportTool.label} · ${exportProjectPath.ifBlank { "未指定项目" }} · ${selectedRemoteShareSessionId().ifBlank { "new-session" }}"
        }

        fun buildRemoteConnectionSnippet(): String {
            val exportSide = selectedRemoteExportSide()
            val isHost = currentRemoteMode() == RemoteMode.HOST
            val exportTool = selectedTool(exportSide).takeUnless { it == BridgeCliTool.REMOTE } ?: selectedRemoteTargetTool()
            val exportProjectPath = if (exportSide == "A") selectedProjectAPath() else selectedProjectBPath()
            val exportSessionId = selectedRemoteShareSessionId()
            val targetTool = if (isHost) exportTool else selectedRemoteTargetTool()
            val targetProjectPath = if (isHost) exportProjectPath else remoteTargetProjectField.text.trim()
            val targetSessionId = if (isHost) exportSessionId else remoteTargetSessionField.text.trim()
            val targetLabel = if (isHost) {
                listOf(
                    remoteDeviceNameField.text.trim().ifBlank { localDeviceName() },
                    targetTool.label,
                    targetProjectPath.ifBlank { "(未指定项目)" },
                    targetSessionId.ifBlank { "new-session" }
                ).joinToString(" | ")
            } else {
                remoteTargetLabelText.takeIf { it.isNotBlank() }
                    ?: listOf(
                        targetTool.label,
                        targetProjectPath.ifBlank { "(未指定项目)" },
                        targetSessionId.ifBlank { "new-session" }
                    ).joinToString(" | ")
            }
            return RemoteBridgeSupport.buildConnectionSnippet(
                RemoteSnippetContext(
                    currentMode = currentRemoteMode(),
                    remoteUrl = remoteUrlField.text.trim(),
                    remoteHubUrl = remoteHubUrlField.text.trim(),
                    remotePeerId = selectedRemotePeerId(),
                    remoteToken = RemoteBridgeSupport.normalizeRemoteToken(remoteTokenField.text.trim(), stored.remoteToken),
                    targetTool = targetTool,
                    targetProjectPath = targetProjectPath,
                    targetSessionId = targetSessionId,
                    targetLabel = targetLabel,
                    localRemoteNodeId = localRemoteNodeId,
                    hostListenPort = remoteListenPortField.text.trim().toIntOrNull() ?: RemoteBridgeSupport.DEFAULT_REMOTE_PORT,
                    hostEndpoints = RemoteBridgeSupport.formatHostEndpoints(
                        remoteListenPortField.text.trim().toIntOrNull() ?: RemoteBridgeSupport.DEFAULT_REMOTE_PORT
                    )
                )
            )
        }

        fun currentRemoteTargetLabel(): String {
            if (remoteTargetLabelText.isNotBlank()) return remoteTargetLabelText
            val tool = selectedRemoteTargetTool().label
            val projectPath = remoteTargetProjectField.text.trim().ifBlank { "(未指定项目)" }
            val sessionId = remoteTargetSessionField.text.trim().ifBlank { "new-session" }
            return listOf(tool, projectPath, sessionId).joinToString(" | ")
        }

        var updateStatus: () -> Unit = {}
        var saveSettings: () -> Unit = {}
        var scheduleRemoteRefresh: (Int) -> Unit = { _ -> }

        fun setSending(side: String, value: Boolean) {
            ApplicationManager.getApplication().invokeLater {
                if (side == "A") isSendingA = value else isSendingB = value
                if (value) activeSides.add(side) else activeSides.remove(side)
                updateStatus()
            }
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

        fun composeMessage(base: String, channel: ChatChannel): String {
            val auto = if (channel == ChatChannel.REMOTE) remoteAutoRelay.isSelected else autoRelay.isSelected
            return if (!(auto && stopOnDone.isSelected)) {
                base
            } else {
                "$base\n\n[Bridge 控制协议]\n- 回复最后一行必须是单行 JSON：{\"bridge_stage\":\"continue\"} 或 {\"bridge_stage\":\"done\"}"
            }
        }

        fun defaultRemoteSendTarget(): String {
            val targets = remoteSendTargets()
            if (targets.isEmpty()) return ""
            return targets.firstOrNull { it.label.contains("远端") || it.label.contains("Remote") }?.side
                ?: targets.first().side
        }

        fun updateRemoteModeVisibility() {
            val mode = currentRemoteMode()
            hostOnlySections.forEach { it.isVisible = mode == RemoteMode.HOST }
            clientOnlySections.forEach { it.isVisible = mode == RemoteMode.CLIENT }
        }

        fun updateButtonsAndLoading() {
            val dot = dots[animFrame % dots.size]
            sendAButton.text = if (isSendingA) "A 生成中$dot" else "发给A"
            sendBButton.text = if (isSendingB) "B 生成中$dot" else "发给B"
            sendAButton.isEnabled = !isSendingA
            sendBButton.isEnabled = !isSendingB
            sendBothButton.isEnabled = !(isSendingA && isSendingB)
            val loadingText = if (activeSides.isEmpty()) "就绪" else "生成中 ${activeSides.joinToString("/")} $dot"
            bridgeLoadingLabel.text = loadingText
            remoteConversationLoadingLabel.text = loadingText

            val remoteTargets = remoteSendTargets()
            val firstRemoteTarget = remoteTargets.getOrNull(0)
            val secondRemoteTarget = remoteTargets.getOrNull(1)
            remoteSendAButton.text = firstRemoteTarget?.label ?: "发给对话方"
            remoteSendBButton.text = secondRemoteTarget?.label ?: "发给第二对话方"
            remoteSendBothButton.text = "同时发给双方"
            remoteSendAButton.isVisible = firstRemoteTarget != null
            remoteSendBButton.isVisible = secondRemoteTarget != null
            remoteSendBothButton.isVisible = remoteTargets.size >= 2
            remoteSendAButton.putClientProperty("remoteTargetSide", firstRemoteTarget?.side.orEmpty())
            remoteSendBButton.putClientProperty("remoteTargetSide", secondRemoteTarget?.side.orEmpty())
            remoteSendAButton.isEnabled = firstRemoteTarget != null && !(firstRemoteTarget.side == "A" && isSendingA || firstRemoteTarget.side == "B" && isSendingB)
            remoteSendBButton.isEnabled = secondRemoteTarget != null && !(secondRemoteTarget.side == "A" && isSendingA || secondRemoteTarget.side == "B" && isSendingB)
            remoteSendBothButton.isEnabled = remoteTargets.size >= 2
            remoteSendHintLabel.text = currentRemoteHint()
        }

        updateStatus = {
            val statusText = "A: ${if (isSendingA) "发送中" else "空闲"} | B: ${if (isSendingB) "发送中" else "空闲"}"
            bridgeStatusLabel.text = statusText
            bridgeInlineStatusA.text = "A ${if (isSendingA) "发送中" else "空闲"}"
            bridgeInlineStatusB.text = "B ${if (isSendingB) "发送中" else "空闲"}"
            remoteConversationStatusLabel.text = currentRemoteConversationStatus()
            applyConnectivityDot(remoteConnectivityDot, remoteConnectivity)
            remoteStatusTextLabel.text = remoteStatusText
            remoteTokenHintLabel.text = RemoteBridgeSupport.DEFAULT_REMOTE_TOKEN_HINT
            remoteTargetLabelValue.text = when (currentRemoteMode()) {
                RemoteMode.HOST -> "当前对外导出: ${selectedRemoteExportSide()} · ${(selectedTool(selectedRemoteExportSide()).takeUnless { it == BridgeCliTool.REMOTE } ?: selectedRemoteTargetTool()).label} · ${(if (selectedRemoteExportSide() == "A") selectedProjectAPath() else selectedProjectBPath()).ifBlank { "(未指定项目)" }} · ${selectedRemoteShareSessionId().ifBlank { "new-session" }}"
                RemoteMode.CLIENT -> if (currentRemoteTargetLabel().isNotBlank()) "当前 Remote 目标: ${currentRemoteTargetLabel()}" else ""
                RemoteMode.OFF -> ""
            }
            remoteSnippetArea.text = buildRemoteConnectionSnippet()
            remoteSurface.emptyState?.text = "<html><body style='width:100%'>${currentRemoteEmptyStateText()}</body></html>"
            updateButtonsAndLoading()
        }

        val remoteServer = RemoteInvokeServer(
            onInvoke = { payload ->
                val future = CompletableFuture<Result<String>>()
                val side = selectedRemoteExportSide()
                val targetTool = payload.targetTool ?: selectedTool(side).takeUnless { it == BridgeCliTool.REMOTE } ?: BridgeCliTool.CODEX
                val projectPath = payload.targetProjectPath?.takeIf { it.isNotBlank() }
                    ?: if (side == "A") selectedProjectAPath() else selectedProjectBPath()
                val sessionId = normalizeResumeId(
                    targetTool,
                    payload.targetSessionId ?: selectedSessionId(side),
                    projectPath
                )
                val worker = workers.getValue(side).getValue(targetTool)

                if (targetTool == BridgeCliTool.REMOTE) {
                    future.complete(Result.failure(IllegalStateException("导出侧 $side 不能再指向 Remote")))
                    future
                } else if (projectPath.isBlank()) {
                    future.complete(Result.failure(IllegalStateException("$side 项目路径为空")))
                    future
                } else if ((side == "A" && isSendingA) || (side == "B" && isSendingB)) {
                    future.complete(Result.failure(IllegalStateException("$side 当前忙碌中")))
                    future
                } else {
                    appendUser(side, payload.text, ChatChannel.REMOTE, ChatPeer.REMOTE)
                    appendSystem(
                        "收到远端请求，转发到 $side · ${listOf(targetTool.label, projectPath, sessionId.ifBlank { "new-session" }).joinToString(" / ")}",
                        side,
                        ChatChannel.REMOTE
                    )
                    setSending(side, true)
                    val handle = appendAssistant(side, ChatChannel.REMOTE, ChatPeer.LOCAL)
                    worker.send(
                        composeMessage(payload.text, ChatChannel.REMOTE),
                        projectPath,
                        sessionId.ifBlank { null },
                        onDelta = { delta ->
                            updateBubble(handle, delta)
                            payload.onDelta(delta)
                        },
                        onDone = { result ->
                            setSending(side, false)
                            result
                                .onSuccess { reply ->
                                    updateBubble(handle, "", reply)
                                    payload.onDone(reply)
                                    future.complete(Result.success(reply))
                                }
                                .onFailure { error ->
                                    updateBubble(handle, "", error.message ?: "(空回复)")
                                    appendSystem("远端请求执行失败：${error.message}", side, ChatChannel.REMOTE)
                                    future.complete(Result.failure(error))
                                }
                        }
                    )
                    future
                }
            },
            onInterrupt = {
                val side = selectedRemoteExportSide()
                workers.getValue(side).values.forEach { it.interrupt() }
                setSending(side, false)
                appendSystem("远端请求已打断 $side", side, ChatChannel.REMOTE)
                Result.success(Unit)
            }
        )

        fun registerWithHub(invokeBaseUrl: String): Boolean {
            val hubUrl = remoteHubUrlField.text.trim()
            val token = RemoteBridgeSupport.normalizeRemoteToken(remoteTokenField.text.trim(), stored.remoteToken)
            if (hubUrl.isBlank() || token.isBlank()) return false
            val response = runCatching {
                RemoteHttpUtil.post(
                    "${hubUrl.removeSuffix("/")}/register",
                    JsonUtil.stringify(
                        mapOf(
                            "token" to token,
                            "nodeId" to localRemoteNodeId,
                            "deviceName" to remoteDeviceNameField.text.trim().ifBlank { localDeviceName() },
                            "invokeUrl" to "${invokeBaseUrl.removeSuffix("/")}/invoke",
                            "exportSide" to selectedRemoteExportSide()
                        )
                    ),
                    mapOf("Content-Type" to "application/json")
                )
            }.getOrElse { return false }
            return response.statusCode in 200..299
        }

        fun unregisterFromHub() {
            val hubUrl = remoteHubUrlField.text.trim()
            val token = remoteTokenField.text.trim()
            if (hubUrl.isBlank() || token.isBlank()) return
            runCatching {
                RemoteHttpUtil.post(
                    "${hubUrl.removeSuffix("/")}/unregister",
                    JsonUtil.stringify(mapOf("token" to token, "nodeId" to localRemoteNodeId)),
                    mapOf("Content-Type" to "application/json")
                )
            }
        }

        fun refreshHubPeers() {
            val hubUrl = remoteHubUrlField.text.trim()
            val token = remoteTokenField.text.trim()
            if (hubUrl.isBlank() || token.isBlank()) {
                remotePeerOptions = emptyList()
                return
            }
            val response = runCatching {
                RemoteHttpUtil.get(
                    "${hubUrl.removeSuffix("/")}/peers?token=${java.net.URLEncoder.encode(token, "UTF-8")}&selfId=${java.net.URLEncoder.encode(localRemoteNodeId, "UTF-8")}"
                )
            }.getOrElse {
                remotePeerOptions = emptyList()
                return
            }
            if (response.statusCode !in 200..299) {
                remotePeerOptions = emptyList()
                return
            }
            val payload = JsonUtil.parseObject(response.body).orEmpty()
            val peers = payload["peers"] as? List<*> ?: emptyList<Any?>()
            remotePeerOptions = peers.mapNotNull { peer ->
                val map = peer as? Map<*, *> ?: return@mapNotNull null
                val id = map["nodeId"]?.toString().orEmpty()
                if (id.isBlank()) return@mapNotNull null
                val label = listOf(
                    map["deviceName"]?.toString().orEmpty().ifBlank { id },
                    map["exportSide"]?.toString()?.takeIf { it.isNotBlank() }?.let { "导出$it" }.orEmpty(),
                    map["invokeUrl"]?.toString().orEmpty()
                ).filter { it.isNotBlank() }.joinToString(" · ")
                RemotePeerOption(
                    id = id,
                    label = label,
                    invokeUrl = map["invokeUrl"]?.toString().orEmpty(),
                    exportSide = map["exportSide"]?.toString().orEmpty()
                )
            }
            updatePeerSelectModel()
        }

        fun checkRemoteConnectivity() {
            val mode = currentRemoteMode()
            if (mode == RemoteMode.HOST) {
                remoteConnectivity = RemoteConnectivity.OK
                return
            }
            if (mode != RemoteMode.CLIENT) {
                remoteConnectivity = RemoteConnectivity.IDLE
                return
            }

            remoteConnectivity = RemoteConnectivity.CHECKING
            val hubUrl = remoteHubUrlField.text.trim()
            if (hubUrl.isNotBlank()) {
                val hubHealth = runCatching { RemoteHttpUtil.get("${hubUrl.removeSuffix("/")}/health") }.getOrElse {
                    remoteConnectivity = RemoteConnectivity.ERROR
                    return
                }
                if (hubHealth.statusCode !in 200..299 || selectedRemotePeerId().isBlank()) {
                    remoteConnectivity = RemoteConnectivity.ERROR
                    return
                }
                val relayHealth = runCatching {
                    RemoteHttpUtil.get(
                        "${hubUrl.removeSuffix("/")}/relay/health?token=${java.net.URLEncoder.encode(remoteTokenField.text.trim(), "UTF-8")}&targetNodeId=${java.net.URLEncoder.encode(selectedRemotePeerId(), "UTF-8")}"
                    )
                }.getOrElse {
                    remoteConnectivity = RemoteConnectivity.ERROR
                    return
                }
                remoteConnectivity = if (relayHealth.statusCode in 200..299) RemoteConnectivity.OK else RemoteConnectivity.ERROR
                return
            }

            val remoteUrl = remoteUrlField.text.trim()
            if (remoteUrl.isBlank()) {
                remoteConnectivity = RemoteConnectivity.ERROR
                return
            }
            val response = runCatching { RemoteHttpUtil.get(RemoteBridgeSupport.resolveHealthUrl(remoteUrl)) }.getOrElse {
                remoteConnectivity = RemoteConnectivity.ERROR
                return
            }
            remoteConnectivity = if (response.statusCode in 200..299) RemoteConnectivity.OK else RemoteConnectivity.ERROR
        }

        fun applyRemoteConfigSnippet(raw: String) {
            val values = RemoteBridgeSupport.parseSnippet(raw)
            if (values.isEmpty()) {
                ApplicationManager.getApplication().invokeLater {
                    remoteCopyStatusLabel.text = "没有识别到可用配置"
                    remoteShareStatusLabel.text = "没有识别到可用配置"
                }
                return
            }

            values["mode"]?.let { remoteModeSelect.selectedItem = RemoteMode.fromValue(it) }
            values["remoteUrl"]?.let { remoteUrlField.text = it }
            values["hubUrl"]?.let { remoteHubUrlField.text = it }
            values["peerId"]?.let {
                remotePeerIdField.text = it
                if (remotePeerOptions.none { option -> option.id == it }) {
                    remotePeerSelect.selectedIndex = 0
                }
            }
            values["token"]?.let { remoteTokenField.text = RemoteBridgeSupport.normalizeRemoteToken(it, stored.remoteToken) }
            values["targetTool"]?.let { remoteTargetToolSelect.selectedItem = BridgeCliTool.fromRemoteTarget(it) }
            values["targetProjectPath"]?.let { remoteTargetProjectField.text = it }
            values["targetSessionId"]?.let { remoteTargetSessionField.text = it }
            values["targetLabel"]?.let { remoteTargetLabelText = it }

            if (selectedTool("A") != BridgeCliTool.REMOTE && selectedTool("B") != BridgeCliTool.REMOTE) {
                val targetSide = pickRemoteImportSide()
                if (targetSide == "A") {
                    toolASelect.selectedItem = BridgeCliTool.REMOTE
                    sessionAField.text = ""
                } else {
                    toolBSelect.selectedItem = BridgeCliTool.REMOTE
                    sessionBField.text = ""
                }
            }
            updateSessionDropdowns()
            updateRemoteModeVisibility()
            updateRemoteShareMirror()
            saveSettings()
            scheduleRemoteRefresh(320)
            ApplicationManager.getApplication().invokeLater {
                remoteCopyStatusLabel.text = "配置已应用"
                remoteShareStatusLabel.text = "配置已应用"
                updateStatus()
            }
        }

        fun refreshRemoteBridge() {
            val mode = currentRemoteMode()
            if (mode != RemoteMode.CLIENT) {
                ApplicationManager.getApplication().invokeLater {
                    remoteAutoRelay.isSelected = false
                }
            }

            if (mode != RemoteMode.HOST) {
                unregisterFromHub()
                runCatching { remoteServer.stop() }

                if (mode == RemoteMode.CLIENT) {
                    if (remoteHubUrlField.text.trim().isNotBlank()) {
                        refreshHubPeers()
                        val selected = remotePeerOptions.firstOrNull { it.id == selectedRemotePeerId() }
                        remoteStatusText =
                            "客户端模式 -> Hub ${remoteHubUrlField.text.trim()} / ${selected?.label ?: selectedRemotePeerId().ifBlank { "未选择节点" }} / 节点数 ${remotePeerOptions.size} / ${RemoteBridgeSupport.describeRemoteToken(remoteTokenField.text.trim())}"
                    } else {
                        remotePeerOptions = emptyList()
                        remoteStatusText =
                            "客户端模式 -> ${remoteUrlField.text.trim().ifBlank { "未配置 URL" }} / ${RemoteBridgeSupport.describeRemoteToken(remoteTokenField.text.trim())}"
                    }
                    checkRemoteConnectivity()
                } else {
                    remotePeerOptions = emptyList()
                    remoteStatusText = "未启用"
                    remoteConnectivity = RemoteConnectivity.IDLE
                }

                ApplicationManager.getApplication().invokeLater {
                    updatePeerSelectModel()
                    updateStatus()
                }
                return
            }

            try {
                val port = remoteListenPortField.text.trim().toIntOrNull()?.takeIf { it in 1..65535 }
                    ?: RemoteBridgeSupport.DEFAULT_REMOTE_PORT
                val actualPort = remoteServer.start(port, RemoteBridgeSupport.normalizeRemoteToken(remoteTokenField.text.trim(), stored.remoteToken))
                val endpoints = RemoteBridgeSupport.formatHostEndpoints(actualPort)
                var status = "主机模式已启动: ${endpoints.joinToString(" , ")}"
                if (remoteHubUrlField.text.trim().isNotBlank()) {
                    val invokeBase = RemoteBridgeSupport.preferredHostEndpoint(endpoints, actualPort)
                    val registered = registerWithHub(invokeBase)
                    refreshHubPeers()
                    status += if (registered) " | Hub 已注册: ${remoteHubUrlField.text.trim()}" else " | Hub 注册失败: ${remoteHubUrlField.text.trim()}"
                } else {
                    remotePeerOptions = emptyList()
                }
                if (selectedTool(selectedRemoteExportSide()) == BridgeCliTool.REMOTE) {
                    status += " | 导出侧 ${selectedRemoteExportSide()} 当前不能是 Remote"
                }
                status += " | ${RemoteBridgeSupport.describeRemoteToken(remoteTokenField.text.trim())}"
                remoteStatusText = status
                remoteConnectivity = RemoteConnectivity.OK
            } catch (error: Exception) {
                remoteStatusText = "主机启动失败: ${error.message}"
                remoteConnectivity = RemoteConnectivity.ERROR
            }

            ApplicationManager.getApplication().invokeLater {
                updatePeerSelectModel()
                updateStatus()
            }
        }

        var remoteRefreshTimer: Timer? = null

        scheduleRemoteRefresh = { delayMs: Int ->
            remoteRefreshTimer?.stop()
            val timer = Timer(delayMs) {
                remoteRefreshTimer?.stop()
                ApplicationManager.getApplication().executeOnPooledThread {
                    refreshRemoteBridge()
                }
            }
            timer.isRepeats = false
            remoteRefreshTimer = timer
            timer.start()
        }

        fun sendTo(
            side: String,
            rawText: String,
            initiatedByRelay: Boolean,
            channel: ChatChannel,
            userPeer: ChatPeer? = null,
            assistantPeer: ChatPeer? = null
        ) {
            val text = rawText.trim()
            if (text.isBlank()) return

            val tool = selectedTool(side)
            val projectPath = if (side == "A") selectedProjectAPath() else selectedProjectBPath()
            val sessionId = selectedSessionId(side)
            val worker = workers.getValue(side).getValue(tool)

            if (tool != BridgeCliTool.REMOTE && projectPath.isBlank()) {
                appendSystem("$side 发送失败：项目路径为空", side, channel)
                return
            }
            if ((side == "A" && isSendingA) || (side == "B" && isSendingB)) {
                appendSystem("$side 忙碌中，稍后再试", side, channel)
                return
            }

            if (!initiatedByRelay || channel == ChatChannel.REMOTE) {
                appendUser(side, text, channel, userPeer)
            } else {
                appendSystem("自动转发到 $side", side, channel)
            }

            setSending(side, true)
            val assistantHandle = appendAssistant(side, channel, assistantPeer)
            worker.send(
                composeMessage(text, channel),
                projectPath,
                sessionId.ifBlank { null },
                onDelta = { delta -> updateBubble(assistantHandle, delta) },
                onDone = { result ->
                    setSending(side, false)
                    result
                        .onSuccess { reply ->
                            updateBubble(assistantHandle, "", reply)
                            if (channel == ChatChannel.REMOTE) {
                                if (remoteAutoRelay.isSelected && stopOnDone.isSelected && stageDone(reply)) {
                                    ApplicationManager.getApplication().invokeLater {
                                        remoteAutoRelay.isSelected = false
                                        saveSettings()
                                        updateStatus()
                                    }
                                    appendSystem("检测到阶段完成，已停止跨设备自动接力", side, ChatChannel.REMOTE)
                                    return@onSuccess
                                }
                                if (remoteAutoRelay.isSelected) {
                                    val payload = relayPayload(reply)
                                    val relayTarget = nextRemoteRelayTarget(side)
                                    if (payload.isNotBlank() && relayTarget != null) {
                                        sendTo(
                                            relayTarget.side,
                                            payload,
                                            true,
                                            ChatChannel.REMOTE,
                                            relayTarget.userPeer,
                                            relayTarget.assistantPeer
                                        )
                                    }
                                }
                            } else {
                                if (autoRelay.isSelected && stopOnDone.isSelected && stageDone(reply)) {
                                    ApplicationManager.getApplication().invokeLater {
                                        autoRelay.isSelected = false
                                        saveSettings()
                                        updateStatus()
                                    }
                                    appendSystem("检测到阶段完成，已停止自动互发")
                                    return@onSuccess
                                }
                                if (autoRelay.isSelected) {
                                    val payload = relayPayload(reply)
                                    if (payload.isNotBlank()) {
                                        sendTo(if (side == "A") "B" else "A", payload, true, ChatChannel.BRIDGE)
                                    }
                                }
                            }
                        }
                        .onFailure { error ->
                            updateBubble(assistantHandle, "", error.message ?: "(空回复)")
                            appendSystem("$side 执行失败：${error.message}", side, channel)
                        }
                }
            )
        }

        fun handleBridgeInterrupt() {
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
                appendSystem("已打断 A/B，并停止自动互发")
                saveSettings()
                updateStatus()
            } else {
                appendSystem("当前无进行中的任务可打断")
            }
        }

        fun handleRemoteUiInterrupt() {
            val sides = remoteConversationSendSides()
            var interrupted = false
            sides.forEach { side ->
                val busy = if (side == "A") isSendingA else isSendingB
                if (busy) {
                    workers.getValue(side).values.forEach { it.interrupt() }
                    setSending(side, false)
                    interrupted = true
                }
            }
            if (interrupted || remoteAutoRelay.isSelected) {
                remoteAutoRelay.isSelected = false
                appendSystem("已停止跨设备对话流，并关闭自动接力", channel = ChatChannel.REMOTE)
                saveSettings()
                updateStatus()
            } else {
                appendSystem("当前没有进行中的跨设备会话", channel = ChatChannel.REMOTE)
            }
        }

        fun bindDocChange(field: JTextComponent, onChange: () -> Unit) {
            field.document.addDocumentListener(object : DocumentListener {
                override fun insertUpdate(e: DocumentEvent?) = onChange()
                override fun removeUpdate(e: DocumentEvent?) = onChange()
                override fun changedUpdate(e: DocumentEvent?) = onChange()
            })
        }

        saveSettings = {
            val state = settings.state
            state.projectAPath = selectedProjectAPath()
            state.projectBPath = selectedProjectBPath()
            state.toolA = selectedTool("A").value
            state.toolB = selectedTool("B").value
            state.sessionA = sessionAField.text.trim().ifBlank { (sessionASelect.selectedItem as? SessionComboItem)?.id.orEmpty() }
            state.sessionB = sessionBField.text.trim().ifBlank { (sessionBSelect.selectedItem as? SessionComboItem)?.id.orEmpty() }
            state.autoRelayEnabled = autoRelay.isSelected
            state.stopOnStageDone = stopOnDone.isSelected
            state.chatControlExpanded = stored.chatControlExpanded
            state.remoteControlExpanded = stored.remoteControlExpanded
            state.remoteMode = currentRemoteMode().value
            state.remoteUrl = remoteUrlField.text.trim()
            state.remoteToken = RemoteBridgeSupport.normalizeRemoteToken(remoteTokenField.text.trim(), stored.remoteToken)
            state.remoteListenPort = remoteListenPortField.text.trim().toIntOrNull()?.takeIf { it in 1..65535 }
                ?: RemoteBridgeSupport.DEFAULT_REMOTE_PORT
            state.remoteExportSide = selectedRemoteExportSide()
            state.remoteHubUrl = remoteHubUrlField.text.trim()
            state.remotePeerId = selectedRemotePeerId()
            state.remoteDeviceName = remoteDeviceNameField.text.trim().ifBlank { localDeviceName() }
            state.remoteTargetTool = selectedRemoteTargetTool().value
            state.remoteTargetProjectPath = remoteTargetProjectField.text.trim()
            state.remoteTargetSessionId = remoteTargetSessionField.text.trim()
            state.remoteTargetLabel = remoteTargetLabelText
            state.remoteAutoRelayEnabled = remoteAutoRelay.isSelected
        }

        val bridgeConfigContent = createVerticalContent()
        bridgeConfigContent.add(createSectionHeader("双侧工具", "A / B 可以分别切换 Codex、Claude Code 或 Remote。Remote 会把远端 AI 引入同一条对话流。"))
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createMiniCard("A 侧工具", toolASelect, "保留当前工作区主线任务，或切到 Remote 作为跨设备远端侧"),
                createMiniCard("B 侧工具", toolBSelect, "适合并行验证、补充分析，或作为跨设备本地协作侧")
            )
        )
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(createSectionHeader("项目与路径", "下拉走最近项目，手动输入会覆盖下拉选择。Remote 工具本身不使用本地项目路径。"))
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createMiniCard("A 项目", projectASelect, "从历史项目中选择"),
                createMiniCard("B 项目", projectBSelect, "可切到另一仓库")
            )
        )
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createMiniCard("A 项目路径覆盖", projectAField, "手动输入优先"),
                createMiniCard("B 项目路径覆盖", projectBField, "手动输入优先")
            )
        )
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(createSectionHeader("最近会话", "最近会话会按工具与项目路径过滤。Remote 不使用本地线程，Codex / Claude 仍支持手动 thread id 覆盖。"))
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createMiniCard("A 最近会话", sessionASelect, "留空时续用当前或创建新会话"),
                createMiniCard("B 最近会话", sessionBSelect, "适合指定已有上下文")
            )
        )
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createMiniCard("A 会话 ID 覆盖", sessionAField, "手动输入优先"),
                createMiniCard("B 会话 ID 覆盖", sessionBField, "手动输入优先")
            )
        )
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(createSectionHeader("执行策略", "本地桥接适合单机 A/B 协作；跨设备 Remote 的自动接力单独放在远程对接页。"))
        addSectionGap(bridgeConfigContent)
        bridgeConfigContent.add(
            row(
                createToggleCard(autoRelay, "开启后，本地 A / B 回复会自动接力继续讨论。"),
                createToggleCard(stopOnDone, "检测到 bridge_stage=done 时自动停下。")
            )
        )
        addSectionGap(bridgeConfigContent)
        val bridgeStatusCard = JPanel(BorderLayout(0, 8))
        bridgeStatusCard.background = panelStrongAlt
        bridgeStatusCard.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(cardBorder, 1, true),
            JBUI.Borders.empty(10)
        )
        val bridgeChipRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        bridgeChipRow.isOpaque = false
        bridgeChipRow.add(bridgeInlineStatusA)
        bridgeChipRow.add(bridgeInlineStatusB)
        val bridgeHint = JBLabel("发送快捷键：Enter 发给 A，Shift+Enter 换行。需要发给 B 或同时发送时，使用下方操作按钮。")
        bridgeHint.foreground = muted
        bridgeHint.font = bridgeHint.font.deriveFont(bridgeHint.font.size2D - 1f)
        bridgeStatusCard.add(bridgeChipRow, BorderLayout.NORTH)
        bridgeStatusCard.add(bridgeHint, BorderLayout.CENTER)
        bridgeConfigContent.add(bridgeStatusCard)

        val bridgeConfigCard = createCollapsibleCard(
            "桥接设置",
            "工具、项目、最近会话和执行策略都折叠在这里，主区域优先保留对话流。",
            bridgeConfigContent,
            "A/B 点击展开",
            stored.chatControlExpanded
        ) { expanded ->
            stored.chatControlExpanded = expanded
            saveSettings()
        }

        val bridgeHeroCard = createPageHero(
            "CONVERSATION FLOW",
            "桥接对话流",
            "统一管理 A / B 两个 AI 的项目、会话与回复节奏，让 IDEA 端的桥接体验和 VSCode 侧边栏使用方式保持一致。",
            createPillLabel("A / B Bridge", userBubble, foreground, accent),
            createPillLabel("Codex / Claude / Remote", panelStrong, muted, cardBorder),
            createPillLabel("中文输入法友好", panelStrong, muted, cardBorder)
        )

        val bridgeConversationCard = createCard("桥接对话", "统一查看 A、B 与系统消息，让主界面只保留真正的对话上下文。")
        val bridgeConversationTop = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        bridgeConversationTop.isOpaque = false
        bridgeConversationTop.add(createPillLabel("Bridge Chat", userBubble, foreground, accent))
        bridgeConversationTop.add(bridgeStatusLabel)
        bridgeConversationTop.add(bridgeLoadingLabel)
        val bridgeConversationContent = JPanel(BorderLayout(0, 10))
        bridgeConversationContent.isOpaque = false
        bridgeConversationContent.add(bridgeConversationTop, BorderLayout.NORTH)
        bridgeConversationContent.add(bridgeSurface.container, BorderLayout.CENTER)
        bridgeConversationCard.add(bridgeConversationContent, BorderLayout.CENTER)

        val bridgeComposerCard = createCard("输入", "主输入框只负责当前轮次，主要控制都集中在上方桥接设置。")
        val bridgeButtons = JPanel(GridLayout(1, 4, 6, 6))
        bridgeButtons.isOpaque = false
        bridgeButtons.add(sendAButton)
        bridgeButtons.add(sendBButton)
        bridgeButtons.add(sendBothButton)
        bridgeButtons.add(interruptBridgeButton)
        val bridgeFooter = JPanel(BorderLayout(8, 0))
        bridgeFooter.isOpaque = false
        bridgeFooter.add(bridgeButtons, BorderLayout.WEST)
        val bridgeComposerHints = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        bridgeComposerHints.isOpaque = false
        bridgeComposerHints.add(createPillLabel("回车发送给 A", panelStrong, muted, cardBorder))
        bridgeComposerHints.add(createPillLabel("Shift+回车换行", panelStrong, muted, cardBorder))
        bridgeComposerHints.add(createPillLabel("输入法候选未确认时不发送", panelStrong, muted, cardBorder))
        val bridgeComposerContent = createVerticalContent()
        bridgeComposerContent.add(bridgeMessageScroll)
        addSectionGap(bridgeComposerContent)
        bridgeComposerContent.add(bridgeComposerHints)
        addSectionGap(bridgeComposerContent)
        bridgeComposerContent.add(bridgeFooter)
        bridgeComposerCard.add(bridgeComposerContent, BorderLayout.CENTER)

        val remoteHeroCard = createPageHero(
            "REMOTE CONVERSATION",
            "远程对接",
            "把本机 AI 与其他设备上的 AI 拉进同一条对话流。支持直连、Hub 注册发现、配置片段复制粘贴和远端 AI 自动接力。",
            createPillLabel("Remote / Hub", userBubble, foreground, accent),
            createPillLabel("复制配置一键接入", panelStrong, muted, cardBorder),
            createPillLabel("Token Streaming", panelStrong, muted, cardBorder)
        )

        val remoteConfigContent = createVerticalContent()

        val remoteStatusCard = JPanel(BorderLayout(0, 8))
        remoteStatusCard.background = panelStrongAlt
        remoteStatusCard.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(cardBorder, 1, true),
            JBUI.Borders.empty(10)
        )
        val remoteStatusTop = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteStatusTop.isOpaque = false
        remoteStatusTop.add(remoteConnectivityDot)
        remoteStatusTop.add(remoteConnectivityLabel)
        remoteStatusCard.add(remoteStatusTop, BorderLayout.NORTH)
        val remoteStatusTextWrap = createVerticalContent()
        remoteStatusTextWrap.add(remoteStatusTextLabel)
        remoteStatusTextWrap.add(Box.createRigidArea(Dimension(0, 4)))
        remoteStatusTextWrap.add(remoteTokenHintLabel)
        remoteStatusTextWrap.add(Box.createRigidArea(Dimension(0, 4)))
        remoteStatusTextWrap.add(remoteTargetLabelValue)
        remoteStatusTextWrap.add(Box.createRigidArea(Dimension(0, 4)))
        remoteStatusTextWrap.add(remoteCopyStatusLabel)
        remoteStatusCard.add(remoteStatusTextWrap, BorderLayout.CENTER)
        remoteConfigContent.add(remoteStatusCard)
        addSectionGap(remoteConfigContent)

        val snippetScroll = JBScrollPane(remoteSnippetArea)
        snippetScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        snippetScroll.viewport.background = panelStrongAlt
        val pasteScroll = JBScrollPane(remotePasteArea)
        pasteScroll.border = BorderFactory.createLineBorder(cardBorder, 1, true)
        pasteScroll.viewport.background = panelStrong

        val remoteModeSectionContent = createVerticalContent()
        remoteModeSectionContent.add(JBLabel("<html><body style='width:100%'>远程对接的目标不是单向操作，而是把“本机 AI”和“其他设备 AI”拉进同一条对话流里，所以配置区默认折叠。</body></html>").apply {
            this.foreground = muted
            this.font = this.font.deriveFont(this.font.size2D - 1f)
            alignmentX = Component.LEFT_ALIGNMENT
        })
        addSectionGap(remoteModeSectionContent)
        remoteModeSectionContent.add(createMiniCard("远程模式", remoteModeSelect, "切换关闭 / 主机 / 客户端"))
        addSectionGap(remoteModeSectionContent)
        val remoteHostMappingRow = row(
            createMiniCard("主机导出映射", remoteExportSideSelect, "收到远端请求后映射到本机 A 或 B")
        )
        hostOnlySections += remoteHostMappingRow
        remoteModeSectionContent.add(remoteHostMappingRow)
        val remoteModeSectionCard = createCollapsibleCard(
            "跨设备桥接设置",
            "定义当前设备是主机还是客户端，以及远端会话映射。",
            remoteModeSectionContent,
            "Mode",
            true
        )
        remoteConfigContent.add(remoteModeSectionCard)
        addSectionGap(remoteConfigContent)

        val remoteLinkSectionContent = createVerticalContent()
        remoteLinkSectionContent.add(remoteStatusCard)
        addSectionGap(remoteLinkSectionContent)
        remoteLinkSectionContent.add(createMiniCard("认证 Token", remoteTokenField, "直连和 Hub 都使用同一个 Token"))
        addSectionGap(remoteLinkSectionContent)
        val remoteLinkActionRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteLinkActionRow.isOpaque = false
        remoteLinkActionRow.add(refreshRemotePeersButton)
        remoteLinkSectionContent.add(remoteLinkActionRow)
        addSectionGap(remoteLinkSectionContent)

        val remoteTargetSectionContent = createVerticalContent()
        remoteTargetSectionContent.add(
            row(
                createMiniCard("远端 CLI", remoteTargetToolSelect, "消息转发到远端时使用 Codex 或 Claude Code"),
                createMiniCard("远端线程 ID", remoteTargetSessionField, "留空表示远端新会话")
            )
        )
        addSectionGap(remoteTargetSectionContent)
        remoteTargetSectionContent.add(createMiniCard("远端项目路径", remoteTargetProjectField, "透传给对方主机的项目路径"))
        val remoteTargetSectionCard = createCollapsibleCard(
            "远端目标",
            "控制远端使用的 CLI、工作目录和线程。留空线程时会新开会话。",
            remoteTargetSectionContent,
            "Client",
            false
        )
        clientOnlySections += remoteTargetSectionCard
        remoteLinkSectionContent.add(remoteTargetSectionCard)
        addSectionGap(remoteLinkSectionContent)

        val remoteAdvancedSectionContent = createVerticalContent()
        remoteAdvancedSectionContent.add(createMiniCard("Hub URL", remoteHubUrlField, "可空。填写后会走节点发现和中转转发"))
        addSectionGap(remoteAdvancedSectionContent)
        val remoteHostAdvancedRow = row(
            createMiniCard("监听端口", remoteListenPortField, "主机模式下，本机对外暴露的 HTTP 端口"),
            createMiniCard("当前设备名", remoteDeviceNameField, "主机注册到 Hub 时展示")
        )
        hostOnlySections += remoteHostAdvancedRow
        remoteAdvancedSectionContent.add(remoteHostAdvancedRow)
        addSectionGap(remoteAdvancedSectionContent)
        val remoteClientAdvancedRow = row(
            createMiniCard("直连 URL", remoteUrlField, "客户端直连地址，例如 http://192.168.3.110:9238"),
            createMiniCard("Hub 节点", remotePeerSelect, "当使用 Hub 时，从这里选目标节点")
        )
        clientOnlySections += remoteClientAdvancedRow
        remoteAdvancedSectionContent.add(remoteClientAdvancedRow)
        addSectionGap(remoteAdvancedSectionContent)
        val remoteClientPeerRow = row(
            createMiniCard("目标节点 ID", remotePeerIdField, "手动输入优先，适合直接粘贴配置后修正节点")
        )
        clientOnlySections += remoteClientPeerRow
        remoteAdvancedSectionContent.add(remoteClientPeerRow)
        val remoteAdvancedSectionCard = createCollapsibleCard(
            "高级手动配置",
            "仅在不使用“粘贴连接配置”时需要。",
            remoteAdvancedSectionContent,
            "Manual",
            false
        )
        remoteLinkSectionContent.add(remoteAdvancedSectionCard)
        val remoteLinkSectionCard = createCollapsibleCard(
            "远端链路",
            "认证、节点发现、直连地址和 Hub 信息。",
            remoteLinkSectionContent,
            "Link",
            true
        )
        remoteConfigContent.add(remoteLinkSectionCard)
        addSectionGap(remoteConfigContent)

        val remoteShareSectionContent = createVerticalContent()
        remoteShareSectionContent.add(
            row(
                createMiniCard("导出线程", remoteShareSessionSelect, "复制配置时带上当前导出线程"),
                createMiniCard("导出线程 ID 覆盖", remoteShareSessionField, "留空时使用左侧选择；都留空则 new-session")
            )
        )
        addSectionGap(remoteShareSectionContent)
        remoteShareSectionContent.add(remoteShareSummaryLabel)
        addSectionGap(remoteShareSectionContent)
        val remoteShareActionRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteShareActionRow.isOpaque = false
        remoteShareActionRow.add(copyRemoteConfigButton)
        remoteShareActionRow.add(remoteShareStatusLabel)
        remoteShareSectionContent.add(remoteShareActionRow)
        addSectionGap(remoteShareSectionContent)
        remoteShareSectionContent.add(createMiniCard("可直接复制给对方的连接配置", snippetScroll, "会带上导出的 CLI、项目路径和线程 ID，供对方一键接入"))
        val remoteShareSectionCard = createCollapsibleCard(
            "复制远端连接配置",
            "带上导出的 CLI、项目路径和线程 ID，供对方一键接入。",
            remoteShareSectionContent,
            "Host",
            false
        )
        hostOnlySections += remoteShareSectionCard
        remoteConfigContent.add(remoteShareSectionCard)
        addSectionGap(remoteConfigContent)

        val remoteImportSectionContent = createVerticalContent()
        val remoteImportActionRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteImportActionRow.isOpaque = false
        remoteImportActionRow.add(applyRemoteConfigButton)
        remoteImportSectionContent.add(remoteImportActionRow)
        addSectionGap(remoteImportSectionContent)
        remoteImportSectionContent.add(createMiniCard("粘贴配置", pasteScroll, "把别人发给你的连接配置粘贴到这里，然后点“应用配置”"))
        val remoteImportSectionCard = createCollapsibleCard(
            "粘贴连接配置",
            "推荐优先使用。粘贴后会自动补全远端地址、Token 和目标线程。",
            remoteImportSectionContent,
            "Client",
            false
        )
        clientOnlySections += remoteImportSectionCard
        remoteConfigContent.add(remoteImportSectionCard)
        addSectionGap(remoteConfigContent)

        val remoteRelayToggleCard = createToggleCard(remoteAutoRelay, "跨设备对话中，本机 AI 和远端 AI 会根据回复自动接力。")
        clientOnlySections += remoteRelayToggleCard
        remoteConfigContent.add(remoteRelayToggleCard)

        val remoteConfigCard = createCollapsibleCard(
            "跨设备桥接设置",
            "远端对接不是单向控制，而是把本机 AI 和其他设备 AI 放进同一条对话流，所以设置区默认折叠。",
            remoteConfigContent,
            "Remote 点击展开",
            stored.remoteControlExpanded
        ) { expanded ->
            stored.remoteControlExpanded = expanded
            saveSettings()
        }

        val remoteConversationCard = createCard("远端对话流", "统一查看 Local / Remote / System 消息，专门用于跨设备 AI 协作。")
        val remoteConversationTop = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteConversationTop.isOpaque = false
        remoteConversationTop.add(createPillLabel("Remote Chat", userBubble, foreground, accent))
        remoteConversationTop.add(remoteConversationStatusLabel)
        remoteConversationTop.add(remoteConversationLoadingLabel)
        val remoteConversationContent = JPanel(BorderLayout(0, 10))
        remoteConversationContent.isOpaque = false
        remoteConversationContent.add(remoteConversationTop, BorderLayout.NORTH)
        remoteConversationContent.add(remoteSurface.container, BorderLayout.CENTER)
        remoteConversationCard.add(remoteConversationContent, BorderLayout.CENTER)

        val remoteComposerCard = createCard("远端输入", "用于把消息注入远端链路。Enter 会发到默认目标，Shift+Enter 换行。")
        val remoteButtons = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        remoteButtons.isOpaque = false
        remoteButtons.add(remoteSendAButton)
        remoteButtons.add(remoteSendBButton)
        remoteButtons.add(remoteSendBothButton)
        remoteButtons.add(interruptRemoteButton)
        val remoteComposerContent = createVerticalContent()
        remoteComposerContent.add(remoteMessageScroll)
        addSectionGap(remoteComposerContent)
        remoteComposerContent.add(remoteSendHintLabel)
        addSectionGap(remoteComposerContent)
        remoteComposerContent.add(remoteButtons)
        remoteComposerCard.add(remoteComposerContent, BorderLayout.CENTER)

        fun createPage(vararg components: JComponent): JBScrollPane {
            val topPanel = createVerticalContent()
            components.forEachIndexed { index, component ->
                if (index > 0) topPanel.add(Box.createRigidArea(Dimension(0, 12)))
                topPanel.add(component)
            }
            val page = JPanel(BorderLayout(0, 12))
            page.isOpaque = false
            page.add(topPanel, BorderLayout.NORTH)
            val scroll = JBScrollPane(page)
            scroll.border = BorderFactory.createEmptyBorder()
            scroll.viewport.background = panelBackground
            scroll.horizontalScrollBarPolicy = ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
            scroll.verticalScrollBar.unitIncrement = 16
            return scroll
        }

        val bridgePage = createPage(bridgeHeroCard, bridgeConfigCard, bridgeConversationCard, bridgeComposerCard)
        val remotePage = createPage(remoteHeroCard, remoteConfigCard, remoteConversationCard, remoteComposerCard)

        val pages = JPanel(CardLayout())
        pages.isOpaque = false
        pages.add(bridgePage, "bridge")
        pages.add(remotePage, "remote")

        var activePage = "bridge"

        fun setActivePage(pageId: String) {
            activePage = pageId
            (pages.layout as CardLayout).show(pages, pageId)
            if (pageId == "bridge") {
                styleButton(bridgeChatTabButton, accent, Color.WHITE)
                styleButton(remoteTabButton, buttonSecondary, buttonSecondaryFg)
            } else {
                styleButton(bridgeChatTabButton, buttonSecondary, buttonSecondaryFg)
                styleButton(remoteTabButton, accent, Color.WHITE)
            }
            pages.revalidate()
            pages.repaint()
        }

        bridgeChatTabButton.addActionListener { setActivePage("bridge") }
        remoteTabButton.addActionListener { setActivePage("remote") }

        val root = JPanel(BorderLayout(0, 12))
        root.background = panelBackground
        root.isOpaque = true
        root.border = JBUI.Borders.empty(12)
        root.add(createNavRail(), BorderLayout.WEST)
        root.add(pages, BorderLayout.CENTER)

        projectASelect.addActionListener {
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        projectBSelect.addActionListener {
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        toolASelect.addActionListener {
            sessionAField.text = ""
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        toolBSelect.addActionListener {
            sessionBField.text = ""
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        sessionASelect.addActionListener {
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        sessionBSelect.addActionListener {
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        remotePeerSelect.addActionListener {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        remoteModeSelect.addActionListener {
            updateRemoteModeVisibility()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
            scheduleRemoteRefresh(320)
        }
        remoteExportSideSelect.addActionListener {
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
            scheduleRemoteRefresh(320)
        }
        remoteTargetToolSelect.addActionListener {
            remoteTargetLabelText = ""
            saveSettings()
            updateStatus()
        }
        autoRelay.addActionListener {
            saveSettings()
            updateStatus()
        }
        stopOnDone.addActionListener {
            saveSettings()
            updateStatus()
        }
        remoteAutoRelay.addActionListener {
            saveSettings()
            updateStatus()
        }

        bindDocChange(projectAField) {
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        bindDocChange(projectBField) {
            updateSessionDropdowns()
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        bindDocChange(sessionAField) {
            if (!syncingRemoteShareMirror) updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        bindDocChange(sessionBField) {
            if (!syncingRemoteShareMirror) updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        bindDocChange(remoteUrlField) {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remoteHubUrlField) {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remotePeerIdField) {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remoteDeviceNameField) {
            remoteTargetLabelText = ""
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remoteTokenField) {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remoteListenPortField) {
            saveSettings()
            scheduleRemoteRefresh(320)
        }
        bindDocChange(remoteTargetProjectField) {
            remoteTargetLabelText = ""
            saveSettings()
            updateStatus()
        }
        bindDocChange(remoteTargetSessionField) {
            remoteTargetLabelText = ""
            saveSettings()
            updateStatus()
        }
        remoteShareSessionSelect.addActionListener {
            if (syncingRemoteShareMirror) return@addActionListener
            val side = selectedRemoteExportSide()
            val sourceSelect = if (side == "A") sessionASelect else sessionBSelect
            val sourceField = if (side == "A") sessionAField else sessionBField
            syncingRemoteShareMirror = true
            sourceField.text = ""
            sourceSelect.selectedIndex = remoteShareSessionSelect.selectedIndex.coerceAtLeast(0)
            syncingRemoteShareMirror = false
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }
        bindDocChange(remoteShareSessionField) {
            if (syncingRemoteShareMirror) return@bindDocChange
            val side = selectedRemoteExportSide()
            val sourceSelect = if (side == "A") sessionASelect else sessionBSelect
            val sourceField = if (side == "A") sessionAField else sessionBField
            syncingRemoteShareMirror = true
            sourceField.text = remoteShareSessionField.text.trim()
            if (remoteShareSessionField.text.trim().isNotBlank()) {
                sourceSelect.selectedIndex = 0
            }
            syncingRemoteShareMirror = false
            updateRemoteShareMirror()
            saveSettings()
            updateStatus()
        }

        sendAButton.addActionListener {
            val text = bridgeMessageArea.text
            bridgeMessageArea.text = ""
            sendTo("A", text, false, if (selectedTool("A") == BridgeCliTool.REMOTE) ChatChannel.REMOTE else ChatChannel.BRIDGE, ChatPeer.LOCAL)
            saveSettings()
        }
        sendBButton.addActionListener {
            val text = bridgeMessageArea.text
            bridgeMessageArea.text = ""
            sendTo("B", text, false, if (selectedTool("B") == BridgeCliTool.REMOTE) ChatChannel.REMOTE else ChatChannel.BRIDGE, ChatPeer.LOCAL)
            saveSettings()
        }
        sendBothButton.addActionListener {
            val text = bridgeMessageArea.text
            bridgeMessageArea.text = ""
            sendTo("A", text, false, if (selectedTool("A") == BridgeCliTool.REMOTE) ChatChannel.REMOTE else ChatChannel.BRIDGE, ChatPeer.LOCAL)
            sendTo("B", text, false, if (selectedTool("B") == BridgeCliTool.REMOTE) ChatChannel.REMOTE else ChatChannel.BRIDGE, ChatPeer.LOCAL)
            saveSettings()
        }
        interruptBridgeButton.addActionListener { handleBridgeInterrupt() }

        fun sendRemote(target: String) {
            if (target.isBlank() && target != "BOTH") return
            val text = remoteMessageArea.text
            remoteMessageArea.text = ""
            when (target) {
                "A", "B" -> sendTo(
                    target,
                    text,
                    false,
                    ChatChannel.REMOTE,
                    ChatPeer.LOCAL,
                    if (selectedTool(target) == BridgeCliTool.REMOTE) ChatPeer.REMOTE else ChatPeer.LOCAL
                )
                "BOTH" -> remoteSendTargets().map { it.side }.distinct().forEach { side ->
                    sendTo(side, text, false, ChatChannel.REMOTE, ChatPeer.LOCAL, if (selectedTool(side) == BridgeCliTool.REMOTE) ChatPeer.REMOTE else ChatPeer.LOCAL)
                }
            }
            saveSettings()
        }

        remoteSendAButton.addActionListener {
            sendRemote(remoteSendAButton.getClientProperty("remoteTargetSide")?.toString().orEmpty())
        }
        remoteSendBButton.addActionListener {
            sendRemote(remoteSendBButton.getClientProperty("remoteTargetSide")?.toString().orEmpty())
        }
        remoteSendBothButton.addActionListener { sendRemote("BOTH") }
        interruptRemoteButton.addActionListener { handleRemoteUiInterrupt() }

        copyRemoteConfigButton.addActionListener {
            val snippet = buildRemoteConnectionSnippet()
            Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(snippet), null)
            remoteCopyStatusLabel.text = "连接配置已复制到剪贴板"
            remoteShareStatusLabel.text = "连接配置已复制到剪贴板"
            remoteSnippetArea.text = snippet
            saveSettings()
        }
        applyRemoteConfigButton.addActionListener {
            applyRemoteConfigSnippet(remotePasteArea.text)
            remotePasteArea.text = ""
            setActivePage("remote")
        }
        refreshRemotePeersButton.addActionListener {
            remoteCopyStatusLabel.text = "正在刷新远端链路..."
            remoteShareStatusLabel.text = "正在刷新远端链路..."
            scheduleRemoteRefresh(50)
        }

        fun installImeAwareSend(textArea: JBTextArea, onSend: () -> Unit) {
            textArea.addKeyListener(object : KeyAdapter() {
                override fun keyPressed(e: KeyEvent) {
                    if (e.keyCode == KeyEvent.VK_ENTER && !e.isShiftDown) {
                        if (imeComposing) return
                        if (System.currentTimeMillis() - compositionJustEndedAt < 80) return
                        e.consume()
                        onSend()
                    }
                }
            })
        }

        bridgeMessageArea.addInputMethodListener(object : InputMethodListener {
            override fun inputMethodTextChanged(event: InputMethodEvent) {
                val iterator = event.text
                var total = 0
                var current = iterator?.first()
                while (iterator != null && current != java.text.AttributedCharacterIterator.DONE) {
                    total += 1
                    current = iterator.next()
                }
                imeComposing = total > event.committedCharacterCount
                if (!imeComposing) {
                    compositionJustEndedAt = System.currentTimeMillis()
                }
            }

            override fun caretPositionChanged(event: InputMethodEvent) = Unit
        })
        remoteMessageArea.addInputMethodListener(object : InputMethodListener {
            override fun inputMethodTextChanged(event: InputMethodEvent) {
                val iterator = event.text
                var total = 0
                var current = iterator?.first()
                while (iterator != null && current != java.text.AttributedCharacterIterator.DONE) {
                    total += 1
                    current = iterator.next()
                }
                imeComposing = total > event.committedCharacterCount
                if (!imeComposing) {
                    compositionJustEndedAt = System.currentTimeMillis()
                }
            }

            override fun caretPositionChanged(event: InputMethodEvent) = Unit
        })
        installImeAwareSend(bridgeMessageArea) { sendAButton.doClick() }
        installImeAwareSend(remoteMessageArea) {
            when (defaultRemoteSendTarget()) {
                "A" -> remoteSendAButton.doClick()
                "B" -> remoteSendBButton.doClick()
                "BOTH" -> remoteSendBothButton.doClick()
            }
        }

        val animationTimer = Timer(350) {
            animFrame += 1
            if (isSendingA || isSendingB) {
                updateButtonsAndLoading()
            }
        }
        animationTimer.start()

        val periodicRemoteTimer = Timer(15_000) {
            if (currentRemoteMode() == RemoteMode.OFF) return@Timer
            ApplicationManager.getApplication().executeOnPooledThread { refreshRemoteBridge() }
        }
        periodicRemoteTimer.start()

        updateSessionDropdowns()
        setActivePage(activePage)
        updateRemoteModeVisibility()
        updateSurfaceEmptyState(bridgeSurface)
        updateSurfaceEmptyState(remoteSurface)
        updateRemoteShareMirror()
        updateStatus()
        loadOptions()
        saveSettings()
        ApplicationManager.getApplication().executeOnPooledThread { refreshRemoteBridge() }

        val content = ContentFactory.getInstance().createContent(root, "", false)
        content.setDisposer(Disposable {
            animationTimer.stop()
            periodicRemoteTimer.stop()
            remoteRefreshTimer?.stop()
            runCatching { unregisterFromHub() }
            runCatching { remoteServer.stop() }
            workers.values.flatMap { it.values }.distinct().forEach { worker -> runCatching { worker.shutdown() } }
        })
        toolWindow.contentManager.addContent(content)
        SwingUtilities.invokeLater { bridgeMessageArea.requestFocusInWindow() }
    }

    private fun localDeviceName(): String {
        return runCatching { InetAddress.getLocalHost().hostName }.getOrElse {
            System.getProperty("user.name").orEmpty().ifBlank { "local-device" }
        }
    }
}
