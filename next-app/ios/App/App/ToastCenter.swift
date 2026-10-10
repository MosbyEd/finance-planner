import UIKit

/// Уведомления приложения: стеклянная капсула над панелью вкладок («Кофе · 320 ₽ — добавлено · Отменить»).
/// Сюда же приходят уведомления интерфейса — одинаково на нативных и веб-вкладках.
@MainActor
final class ToastCenter {
    static let shared = ToastCenter()

    enum Kind { case info, error }

    struct Action {
        var label: String
        var handler: () -> Void
    }

    /// Где показывать: корневой экран сообщает свой view и нижнюю границу свободного места.
    weak var host: UIView?
    var bottomInset: () -> CGFloat = { 0 }
    /// Справа может стоять кнопка «+» — уведомление её не закрывает.
    var trailingInset: () -> CGFloat = { 12 }

    private var current: ToastView?
    private var hideTask: Task<Void, Never>?

    private init() {}

    func show(_ message: String, kind: Kind = .info, action: Action? = nil) {
        guard let host else { return }
        hideTask?.cancel()
        current.map(dismiss)

        let toast = ToastView(message: message, kind: kind, action: action) { [weak self] view in self?.dismiss(view) }
        toast.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(toast)
        let bottom = toast.bottomAnchor.constraint(equalTo: host.bottomAnchor, constant: -bottomInset())
        NSLayoutConstraint.activate([
            toast.leadingAnchor.constraint(equalTo: host.leadingAnchor, constant: 12),
            toast.trailingAnchor.constraint(equalTo: host.trailingAnchor, constant: -trailingInset()),
            bottom,
        ])
        current = toast
        UIAccessibility.post(notification: .announcement, argument: message)

        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        toast.alpha = 0
        toast.transform = reduceMotion ? .identity : CGAffineTransform(translationX: 0, y: 16).scaledBy(x: 0.96, y: 0.96)
        UIView.animate(withDuration: reduceMotion ? 0.15 : 0.45, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.3) {
            toast.alpha = 1
            toast.transform = .identity
        }

        let seconds: Double = action != nil || kind == .error ? 6 : 3.5
        hideTask = Task { [weak self, weak toast] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled, let toast else { return }
            self?.dismiss(toast)
        }
    }

    private func dismiss(_ toast: ToastView) {
        if current === toast { current = nil }
        UIView.animate(withDuration: 0.25, animations: {
            toast.alpha = 0
            toast.transform = CGAffineTransform(translationX: 0, y: 12)
        }, completion: { _ in toast.removeFromSuperview() })
    }
}

private final class ToastView: UIView {
    init(message: String, kind: ToastCenter.Kind, action: ToastCenter.Action?, onClose: @escaping (ToastView) -> Void) {
        super.init(frame: .zero)

        let background: UIVisualEffectView
        if kind == .error {
            let glass = UIGlassEffect(style: .regular)
            glass.tintColor = Theme.negativeStrongUI
            background = UIVisualEffectView(effect: glass)
        } else {
            background = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
        }
        background.cornerConfiguration = .capsule()
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)

        let label = UILabel()
        label.text = message
        label.numberOfLines = 3
        label.font = UIFont.preferredFont(forTextStyle: .subheadline).withWeight(.medium)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = kind == .error ? .white : .label

        let stack = UIStackView(arrangedSubviews: [label])
        stack.axis = .horizontal
        stack.alignment = .center
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.contentView.addSubview(stack)

        if let action {
            var config = UIButton.Configuration.plain()
            var title = AttributedString(action.label)
            title.font = UIFont.preferredFont(forTextStyle: .subheadline).withWeight(.semibold)
            config.attributedTitle = title
            config.baseForegroundColor = kind == .error ? .white : Theme.accentUI
            config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 6, bottom: 8, trailing: 6)
            let button = UIButton(configuration: config)
            button.setContentHuggingPriority(.required, for: .horizontal)
            button.setContentCompressionResistancePriority(.required, for: .horizontal)
            button.addAction(UIAction { [weak self] _ in
                action.handler()
                if let self { onClose(self) }
            }, for: .primaryActionTriggered)
            stack.addArrangedSubview(button)
        }

        NSLayoutConstraint.activate([
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.topAnchor.constraint(equalTo: topAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: background.contentView.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: background.contentView.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: background.contentView.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: background.contentView.bottomAnchor, constant: -8),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])

        let swipe = UISwipeGestureRecognizer(target: self, action: #selector(swiped))
        swipe.direction = .down
        addGestureRecognizer(swipe)
        self.onClose = onClose
        accessibilityElements = [label] + stack.arrangedSubviews.dropFirst()
    }

    private var onClose: ((ToastView) -> Void)?

    @objc private func swiped() {
        onClose?(self)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) не используется")
    }
}

private extension UIFont {
    func withWeight(_ weight: UIFont.Weight) -> UIFont {
        let descriptor = fontDescriptor.addingAttributes([.traits: [UIFontDescriptor.TraitKey.weight: weight]])
        return UIFont(descriptor: descriptor, size: 0)
    }
}
