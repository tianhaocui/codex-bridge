import SwiftUI
import AppKit

struct EnterSendTextEditor: NSViewRepresentable {
    @Binding var text: String
    var minHeight: CGFloat = 72
    var onSubmit: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(text: $text, onSubmit: onSubmit)
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.autohidesScrollers = true

        let textView = SubmitTextView()
        textView.minSize = NSSize(width: 0, height: minHeight)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.isEditable = true
        textView.isSelectable = true
        textView.isFieldEditor = false
        textView.isRichText = false
        textView.importsGraphics = false
        textView.allowsUndo = true
        textView.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        textView.backgroundColor = .clear
        textView.textColor = .labelColor
        textView.insertionPointColor = .controlAccentColor
        textView.selectedTextAttributes = [
            .backgroundColor: NSColor.selectedTextBackgroundColor,
            .foregroundColor: NSColor.selectedTextColor
        ]
        textView.textContainerInset = NSSize(width: 6, height: 6)
        textView.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.delegate = context.coordinator
        textView.onSubmit = context.coordinator.handleSubmit

        scroll.documentView = textView
        scroll.contentView.postsBoundsChangedNotifications = true
        return scroll
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? SubmitTextView else { return }
        textView.minSize.height = minHeight
        if textView.string != text {
            textView.string = text
        }
        textView.onSubmit = context.coordinator.handleSubmit
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        let onSubmit: () -> Void

        init(text: Binding<String>, onSubmit: @escaping () -> Void) {
            _text = text
            self.onSubmit = onSubmit
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            text = tv.string
        }

        func handleSubmit() {
            onSubmit()
        }
    }
}

final class SubmitTextView: NSTextView {
    var onSubmit: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let isReturn = event.keyCode == 36 || event.keyCode == 76
        if isReturn {
            if hasMarkedText() {
                super.keyDown(with: event)
                return
            }

            let shiftPressed = event.modifierFlags.contains(.shift)
            if shiftPressed {
                insertNewline(nil)
            } else {
                onSubmit?()
            }
            return
        }
        super.keyDown(with: event)
    }

    override var acceptsFirstResponder: Bool { true }
}
