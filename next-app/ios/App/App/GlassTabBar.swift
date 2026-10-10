import UIKit

/// Нижняя панель в системном стиле Liquid Glass (iOS 26+): капсула с вкладками и отдельная круглая кнопка «+»
/// в одном стеклянном контейнере — стекло двух элементов сливается, как у системных панелей.
/// Интерфейс (WebView) сообщает вкладки и выбранную, панель возвращает нажатия.
final class GlassTabBar: UIView {
    struct Item {
        let id: String
        let title: String
        let symbol: String
        let selectedSymbol: String
    }

    var onSelect: ((String) -> Void)?
    var onAction: (() -> Void)?

    private let container = UIVisualEffectView(effect: UIGlassContainerEffect())
    private let bar = UIVisualEffectView()
    private let lens = UIView()
    private let stack = UIStackView()
    private let actionButton = UIButton(type: .system)
    private var buttons: [(id: String, button: UIButton, item: Item)] = []
    private var selectedId: String?
    private var lensConstraints: [NSLayoutConstraint] = []
    private var barTrailingToAction: NSLayoutConstraint!
    private var barTrailingToEdge: NSLayoutConstraint!
    private var actionVisible: Bool?
    private var hiddenByKeyboard = false
    private var hiddenByApp = false

    /// Фирменный цвет приложения: тот же, что --accent в интерфейсе (светлая и тёмная темы).
    static let accent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x87 / 255, green: 0x96 / 255, blue: 0xFF / 255, alpha: 1)
            : UIColor(red: 0x3F / 255, green: 0x51 / 255, blue: 0xD9 / 255, alpha: 1)
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        build()
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) не используется")
    }

    /// Пропускаем касания мимо панели к WebView.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        return view === self || view === container || view === container.contentView ? nil : view
    }

    private func build() {
        backgroundColor = .clear
        (container.effect as? UIGlassContainerEffect)?.spacing = 12
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)

        let glass = UIGlassEffect(style: .regular)
        glass.isInteractive = true
        bar.effect = glass
        bar.cornerConfiguration = .capsule()
        bar.translatesAutoresizingMaskIntoConstraints = false
        container.contentView.addSubview(bar)

        lens.backgroundColor = UIColor.label.withAlphaComponent(0.09)
        lens.layer.cornerCurve = .continuous
        lens.isUserInteractionEnabled = false
        lens.translatesAutoresizingMaskIntoConstraints = false
        bar.contentView.addSubview(lens)

        stack.axis = .horizontal
        stack.distribution = .fillEqually
        stack.translatesAutoresizingMaskIntoConstraints = false
        bar.contentView.addSubview(stack)

        var action = UIButton.Configuration.prominentGlass()
        action.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold))
        action.baseBackgroundColor = Self.accent
        action.cornerStyle = .capsule
        actionButton.configuration = action
        actionButton.accessibilityLabel = "Добавить операцию"
        actionButton.translatesAutoresizingMaskIntoConstraints = false
        actionButton.addAction(UIAction { [weak self] _ in
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            self?.onAction?()
        }, for: .primaryActionTriggered)
        container.contentView.addSubview(actionButton)

        barTrailingToAction = bar.trailingAnchor.constraint(equalTo: actionButton.leadingAnchor, constant: -10)
        barTrailingToEdge = bar.trailingAnchor.constraint(equalTo: container.contentView.trailingAnchor)
        NSLayoutConstraint.activate([
            container.leadingAnchor.constraint(equalTo: leadingAnchor),
            container.trailingAnchor.constraint(equalTo: trailingAnchor),
            container.topAnchor.constraint(equalTo: topAnchor),
            container.bottomAnchor.constraint(equalTo: bottomAnchor),

            bar.leadingAnchor.constraint(equalTo: container.contentView.leadingAnchor),
            bar.topAnchor.constraint(equalTo: container.contentView.topAnchor),
            bar.bottomAnchor.constraint(equalTo: container.contentView.bottomAnchor),
            barTrailingToAction,

            actionButton.trailingAnchor.constraint(equalTo: container.contentView.trailingAnchor),
            actionButton.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
            actionButton.widthAnchor.constraint(equalToConstant: 60),
            actionButton.heightAnchor.constraint(equalToConstant: 60),

            stack.leadingAnchor.constraint(equalTo: bar.contentView.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: bar.contentView.trailingAnchor, constant: -4),
            stack.topAnchor.constraint(equalTo: bar.contentView.topAnchor, constant: 4),
            stack.bottomAnchor.constraint(equalTo: bar.contentView.bottomAnchor, constant: -4),
        ])

        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide), name: UIResponder.keyboardWillHideNotification, object: nil)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        lens.layer.cornerRadius = lens.bounds.height / 2
    }

    // MARK: - Вкладки

    func setItems(_ items: [Item]) {
        buttons.forEach { $0.button.removeFromSuperview() }
        buttons = items.map { item in
            let button = UIButton(type: .system)
            button.addAction(UIAction { [weak self] _ in self?.tap(item.id) }, for: .primaryActionTriggered)
            stack.addArrangedSubview(button)
            return (item.id, button, item)
        }
        render(animated: false)
    }

    func select(_ id: String?, animated: Bool) {
        guard id != selectedId else { return }
        selectedId = id
        render(animated: animated)
    }

    private func tap(_ id: String) {
        if id != selectedId { UISelectionFeedbackGenerator().selectionChanged() }
        onSelect?(id)
    }

    private func render(animated: Bool) {
        for entry in buttons {
            let selected = entry.id == selectedId
            var config = UIButton.Configuration.plain()
            config.image = UIImage(
                systemName: selected ? entry.item.selectedSymbol : entry.item.symbol,
                withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)
            )
            config.imagePlacement = .top
            config.imagePadding = 3
            config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0)
            var title = AttributedString(entry.item.title)
            title.font = UIFont.systemFont(ofSize: 10, weight: .semibold)
            config.attributedTitle = title
            config.titleLineBreakMode = .byTruncatingTail
            config.baseForegroundColor = selected ? Self.accent : .label
            entry.button.configuration = config
            entry.button.accessibilityLabel = entry.item.title
            entry.button.accessibilityTraits = selected ? [.button, .selected] : .button
        }
        NSLayoutConstraint.deactivate(lensConstraints)
        if let target = buttons.first(where: { $0.id == selectedId })?.button {
            lensConstraints = [
                lens.leadingAnchor.constraint(equalTo: target.leadingAnchor),
                lens.trailingAnchor.constraint(equalTo: target.trailingAnchor),
                lens.topAnchor.constraint(equalTo: target.topAnchor),
                lens.bottomAnchor.constraint(equalTo: target.bottomAnchor),
            ]
            NSLayoutConstraint.activate(lensConstraints)
        }
        let showLens = selectedId != nil && buttons.contains { $0.id == selectedId }
        let changes = {
            self.lens.alpha = showLens ? 1 : 0
            self.bar.contentView.layoutIfNeeded()
        }
        if animated, !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.72, initialSpringVelocity: 0.3, options: [.allowUserInteraction], animations: changes)
        } else {
            changes()
        }
    }

    // MARK: - Кнопка «+» и видимость

    func setActionVisible(_ visible: Bool, animated: Bool) {
        guard visible != actionVisible else { return }
        let first = actionVisible == nil
        actionVisible = visible
        let changes = {
            self.barTrailingToAction.isActive = visible
            self.barTrailingToEdge.isActive = !visible
            self.actionButton.alpha = visible ? 1 : 0
            self.actionButton.transform = visible ? .identity : CGAffineTransform(scaleX: 0.5, y: 0.5)
            self.layoutIfNeeded()
        }
        actionButton.isHidden = false
        if animated, !first, !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.2, options: [], animations: changes) { _ in
                self.actionButton.isHidden = !visible
            }
        } else {
            changes()
            actionButton.isHidden = !visible
        }
    }

    /// Панель прячется, пока открыто окно интерфейса (оно снизу и иначе оказалось бы под панелью).
    func setHiddenByApp(_ hidden: Bool, animated: Bool) {
        hiddenByApp = hidden
        updateVisibility(animated: animated)
    }

    @objc private func keyboardWillShow() {
        hiddenByKeyboard = true
        updateVisibility(animated: true)
    }

    @objc private func keyboardWillHide() {
        hiddenByKeyboard = false
        updateVisibility(animated: true)
    }

    private func updateVisibility(animated: Bool) {
        let hidden = hiddenByApp || hiddenByKeyboard
        isUserInteractionEnabled = !hidden
        let changes = {
            self.alpha = hidden ? 0 : 1
            self.transform = hidden ? CGAffineTransform(translationX: 0, y: 24) : .identity
        }
        if animated, !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState, .curveEaseOut], animations: changes)
        } else {
            changes()
        }
    }
}
