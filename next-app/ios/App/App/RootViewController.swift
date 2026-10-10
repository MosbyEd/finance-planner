import SwiftUI
import UIKit

/// Корень приложения: системная панель вкладок iOS 26 (Liquid Glass) и «+» — отдельный стеклянный круг над ней
/// (на Главной и в Истории). На iPhone панель вмещает пять пунктов — «+» вкладкой стать не может.
/// Главная — нативная (SwiftUI); остальные вкладки и все окна пока рисует интерфейс в WebView.
/// WebView один: он переезжает на выбранную вкладку, а на Главной лежит под нативным экраном и выходит
/// наверх, когда открыто окно интерфейса (страница там прозрачная — под затемнением видна Главная).
final class RootViewController: UITabBarController, UITabBarControllerDelegate {
    struct Item {
        let id: String
        let title: String
        let symbol: String
    }

    static let items: [Item] = [
        Item(id: "home", title: "Главная", symbol: "house"),
        Item(id: "history", title: "История", symbol: "list.bullet"),
        Item(id: "plans", title: "Регулярные", symbol: "repeat"),
        Item(id: "goals", title: "Цели", symbol: "target"),
        Item(id: "settings", title: "Настройки", symbol: "gearshape"),
    ]

    let web = BudgetViewController()
    private let home = HomeHostViewController()
    private var hosts: [String: UIViewController] = [:]
    private let addButton = UIButton(type: .system)

    /// Вкладка, которую показывает интерфейс (может быть «analytics» — её нет на панели, она открывается из шапки).
    private var webTab = "home"
    /// Открыто окно интерфейса (или вот-вот откроется после команды «open»).
    private var webOverlay = false
    private var expectedOverlay: Task<Void, Never>?

    override func viewDidLoad() {
        super.viewDidLoad()
        delegate = self
        view.backgroundColor = Theme.bgUI
        tabBar.tintColor = Theme.accentUI
        tabBarMinimizeBehavior = .never

        hosts["home"] = home
        tabs = Self.items.map { item in
            UITab(title: item.title, image: UIImage(systemName: item.symbol), identifier: item.id) { [unowned self] _ in
                self.host(for: item.id)
            }
        }

        var add = UIButton.Configuration.prominentGlass()
        add.image = UIImage(systemName: "plus", withConfiguration: UIImage.SymbolConfiguration(pointSize: 22, weight: .semibold))
        add.baseBackgroundColor = Theme.actionUI
        add.cornerStyle = .capsule
        addButton.configuration = add
        addButton.accessibilityLabel = "Добавить операцию"
        addButton.translatesAutoresizingMaskIntoConstraints = false
        addButton.addAction(UIAction { [weak self] _ in
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            self?.presentAdd()
        }, for: .primaryActionTriggered)
        view.addSubview(addButton)
        NSLayoutConstraint.activate([
            addButton.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -16),
            addButton.bottomAnchor.constraint(equalTo: tabBar.topAnchor, constant: -12),
            addButton.widthAnchor.constraint(equalToConstant: 58),
            addButton.heightAnchor.constraint(equalToConstant: 58),
        ])

        attachWeb(to: home)
        AppShell.shared.root = self
        ToastCenter.shared.host = view
        ToastCenter.shared.bottomInset = { [weak self] in
            guard let self else { return 24 }
            let bar = self.isTabBarHidden ? 0 : self.tabBar.frame.height
            return self.view.safeAreaInsets.bottom + bar + 12
        }
        ToastCenter.shared.trailingInset = { [weak self] in
            guard let self, self.addButtonVisible else { return 12 }
            return 16 + 58 + 10
        }
        updateAddButton(animated: false)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        runDebugLaunchArguments()
    }

    // MARK: - Кнопка «+»

    /// «+» — там, где добавляют операции: Главная и История, пока не открыто окно интерфейса.
    private var addButtonVisible: Bool {
        let id = selectedTab?.identifier
        return (id == "home" || id == "history") && webTab != "analytics" && !webOverlay
    }

    private func updateAddButton(animated: Bool) {
        let visible = addButtonVisible
        guard visible == addButton.isHidden || addButton.alpha != (visible ? 1 : 0) else { return }
        addButton.isHidden = false
        addButton.isUserInteractionEnabled = visible
        let changes = {
            self.addButton.alpha = visible ? 1 : 0
            self.addButton.transform = visible ? .identity : CGAffineTransform(scaleX: 0.6, y: 0.6)
        }
        if animated, !UIAccessibility.isReduceMotionEnabled {
            UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.8, initialSpringVelocity: 0.2, options: [.beginFromCurrentState], animations: changes) { _ in
                self.addButton.isHidden = !self.addButtonVisible
            }
        } else {
            changes()
            addButton.isHidden = !visible
        }
    }

    // MARK: - Ссылки виджета

    /// budget://add — окно «Новый расход», budget://home — Главная. При холодном запуске ждём интерфейс.
    func open(link: String) {
        Task { @MainActor in
            for _ in 0..<40 where !HomeStore.shared.live {
                try? await Task.sleep(for: .milliseconds(250))
            }
            switch link {
            case "add":
                if presentedViewController == nil { presentAdd() }
            default:
                if webTab != "home" || selectedTab?.identifier != "home" { AppShell.shared.setTab("home") }
            }
        }
    }

    // MARK: - Проверка сборки

    /// Параметры запуска для проверки сборки на телефоне (`devicectl device process launch … -BudgetDebugTab history`):
    /// открыть вкладку, окно интерфейса или окно добавления. При обычном запуске их нет.
    private var debugArgumentsDone = false

    private func runDebugLaunchArguments() {
        guard !debugArgumentsDone else { return }
        debugArgumentsDone = true
        let defaults = UserDefaults.standard
        let tab = defaults.string(forKey: "BudgetDebugTab")
        let overlay = defaults.string(forKey: "BudgetDebugOverlay")
        let addSheet = defaults.bool(forKey: "BudgetDebugAdd")
        if let sms = defaults.string(forKey: "BudgetDebugSmsDryRun") {
            Task.detached {
                let result = await LocalSms.shared.dryRun(text: sms)
                NSLog("DBG-SMS %@", result)
            }
        }
        guard tab != nil || overlay != nil || addSheet else { return }
        Task { @MainActor in
            // Ждём, пока интерфейс загрузится и пришлёт модель Главной.
            for _ in 0..<40 where !HomeStore.shared.live {
                try? await Task.sleep(for: .milliseconds(250))
            }
            if let tab {
                AppShell.shared.setTab(tab)
                try? await Task.sleep(for: .seconds(1))
            }
            if let overlay { AppShell.shared.open(["kind": .string(overlay)]) }
            if addSheet { presentAdd() }
        }
    }

    private func host(for id: String) -> UIViewController {
        if let existing = hosts[id] { return existing }
        let host = UIViewController()
        host.view.backgroundColor = Theme.bgUI
        hosts[id] = host
        return host
    }

    // MARK: - Выбор вкладки

    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        if tab.identifier != selectedTab?.identifier { UISelectionFeedbackGenerator().selectionChanged() }
        // Повторное касание Главной возвращает с «Аналитики» и прокручивает наверх.
        if tab.identifier == "home", selectedTab?.identifier == "home" { home.scrollToTop() }
        plugin?.notifyTabSelected(tab.identifier)
        return true
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        attachWeb(to: host(for: selectedTab.identifier))
        updateAddButton(animated: true)
    }

    private var plugin: BudgetNativePlugin? { AppShell.shared.plugin }

    // MARK: - Состояние интерфейса

    /// Интерфейс сообщил свою вкладку и открыто ли окно.
    func applyWebState(selected: String?, overlay: Bool?) {
        if let selected {
            webTab = selected
            if Self.items.contains(where: { $0.id == selected }), selectedTab?.identifier != selected,
               let tab = tabs.first(where: { $0.identifier == selected }) {
                selectedTab = tab
                attachWeb(to: host(for: selected))
            }
        }
        if let overlay {
            expectedOverlay?.cancel()
            expectedOverlay = nil
            webOverlay = overlay
            setTabBarHidden(overlay, animated: true)
        }
        updateLayers()
    }

    /// Команда открыть окно отправлена: поднимаем WebView сразу, не дожидаясь, пока интерфейс сообщит об окне.
    /// Если окно так и не открылось, через секунду возвращаем Главную.
    func expectWebOverlay() {
        guard !webOverlay else { return }
        webOverlay = true
        updateLayers()
        expectedOverlay?.cancel()
        expectedOverlay = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self else { return }
            self.webOverlay = false
            self.updateLayers()
        }
    }

    private func attachWeb(to host: UIViewController) {
        guard web.parent !== host else { return }
        if web.parent != nil {
            web.willMove(toParent: nil)
            web.view.removeFromSuperview()
            web.removeFromParent()
        }
        host.addChild(web)
        web.view.frame = host.view.bounds
        web.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.view.insertSubview(web.view, at: 0)
        web.didMove(toParent: host)
        updateLayers()
    }

    private func updateLayers() {
        let webOnTop = webTab != "home" || webOverlay
        home.setWebOnTop(webOnTop, web: web.view)
        updateAddButton(animated: true)
    }

    // MARK: - Добавление операции

    func presentAdd(kind: AddTransactionView.Kind = .expense) {
        guard presentedViewController == nil else { return }
        guard let model = HomeStore.shared.model, HomeStore.shared.live else {
            ToastCenter.shared.show("Загружаем данные — попробуйте через секунду.")
            return
        }
        let sheet = UIHostingController(rootView: AddTransactionView(add: model.add, initialKind: kind))
        sheet.modalPresentationStyle = .pageSheet
        if let controller = sheet.sheetPresentationController {
            controller.detents = [.large()]
            controller.prefersGrabberVisible = true
        }
        present(sheet, animated: true)
    }
}

/// Хозяин Главной: нативный экран сверху, WebView под ним (или над ним, когда открыто окно интерфейса).
final class HomeHostViewController: UIViewController {
    private let hosting = UIHostingController(rootView: HomeScreen())

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Theme.bgUI
        addChild(hosting)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        hosting.view.backgroundColor = .clear
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)
    }

    func setWebOnTop(_ onTop: Bool, web: UIView) {
        guard web.superview === view else { return }
        if onTop {
            view.bringSubviewToFront(web)
        } else {
            view.bringSubviewToFront(hosting.view)
        }
        // Пока сверху WebView, нативный экран не должен ловить фокус VoiceOver.
        hosting.view.accessibilityElementsHidden = onTop
        web.accessibilityElementsHidden = !onTop
    }

    func scrollToTop() {
        NotificationCenter.default.post(name: .homeScrollToTop, object: nil)
    }
}

extension Notification.Name {
    static let homeScrollToTop = Notification.Name("budget.homeScrollToTop")
}
