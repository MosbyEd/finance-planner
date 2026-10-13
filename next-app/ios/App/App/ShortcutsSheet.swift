import AppIntents
import Capacitor
import SwiftUI
import UIKit

/// Подписанные команды в пакете приложения (папка Shortcuts): передают текст и отправителя СМС действию «Добавить
/// операцию из СМС» и показывают уведомление с результатом. «Бюджет СМС» — общая, без автоматизации; «Бюджет СМС
/// Т-Банк» и т. п. — с автоматизацией «Сообщение» от отправителей банка. Собирает scripts/sign-shortcuts.ts,
/// «Команды» импортируют их из окна «Поделиться».
enum SmsShortcut {
    static let generic = "Бюджет СМС"

    static func fileURL(named name: String = generic) -> URL? {
        guard !name.contains("/"), !name.hasPrefix(".") else { return nil }
        return Bundle.main.url(forResource: name, withExtension: "shortcut", subdirectory: "Shortcuts")
    }
}

/// Экран «Siri и Команды»: команда для СМС, системная кнопка, открывающая действия приложения в «Командах»,
/// подсказки Siri и шаги для автоматизации по СМС — её iOS разрешает создать только самому пользователю.
struct ShortcutsSheet: View {
    var onDone: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                if let url = SmsShortcut.fileURL() {
                    Section {
                        ShareLink(item: url, preview: SharePreview("Бюджет СМС", image: Image(systemName: "message.badge"))) {
                            Label("Добавить команду «Бюджет СМС»", systemImage: "plus.circle.fill")
                        }
                    } header: {
                        Text("Операции из СМС")
                    } footer: {
                        Text("В окне «Поделиться» выберите «Команды» → «Добавить быструю команду». Она передаёт СМС банка в приложение — без адреса сервера и ключа.")
                    }
                }

                Section {
                    ShortcutsLink()
                        .shortcutsLinkStyle(.automatic)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                } footer: {
                    Text("Откроет «Команды» на странице «Бюджета»: там все действия приложения — их можно добавить в свои команды и на экран «Домой».")
                }

                Section("Скажите Siri") {
                    SiriTipView(intent: TodayBudgetIntent())
                    SiriTipView(intent: AddOperationIntent())
                }

                Section {
                    Label("«Команды» → «Автоматизация» → «+» → «Сообщение»", systemImage: "1.circle")
                    Label("Отправители — номера и имена банков из Настроек → «Банки» (у Сбербанка — 900), включите «Запускать сразу»", systemImage: "2.circle")
                    Label("Действие «Запустить быструю команду» → «Бюджет СМС», ввод — «Ввод команды»", systemImage: "3.circle")
                    Button {
                        if let url = URL(string: "shortcuts://") { openURL(url) }
                    } label: {
                        Label("Открыть «Команды»", systemImage: "arrow.up.forward.app")
                    }
                } header: {
                    Text("Автоматизация по СМС")
                } footer: {
                    Text("Автоматизацию по сообщениям iOS разрешает создать только вам — ни одно приложение не может добавить её само.")
                }
            }
            .navigationTitle("Siri и Команды")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Готово", action: onDone)
                }
            }
        }
    }
}

extension BudgetNativePlugin {
    /// Окно «Поделиться» с командой: в нём «Команды» → «Добавить быструю команду». name — команда банка
    /// («Бюджет СМС Т-Банк», с его автоматизацией); нет — общая «Бюджет СМС».
    @objc func addSmsShortcut(_ call: CAPPluginCall) {
        let name = call.getString("name") ?? SmsShortcut.generic
        DispatchQueue.main.async {
            guard let url = SmsShortcut.fileURL(named: name), let presenter = self.bridge?.viewController else {
                call.reject("Команды нет в этой сборке")
                return
            }
            let activity = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            activity.popoverPresentationController?.sourceView = presenter.view
            presenter.present(activity, animated: true)
            call.resolve()
        }
    }

    /// Открывает приложение «Команды» — создать автоматизацию по СМС можно только там.
    @objc func openShortcutsApp(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: "shortcuts://") else { return }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("Не удалось открыть «Команды»") }
            }
        }
    }

    /// Показывает экран «Siri и Команды» поверх приложения.
    @objc func openShortcuts(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                call.reject("Нет экрана приложения")
                return
            }
            var host: UIHostingController<ShortcutsSheet>?
            host = UIHostingController(rootView: ShortcutsSheet(onDone: { host?.dismiss(animated: true) }))
            guard let controller = host else { return }
            if let sheet = controller.sheetPresentationController {
                sheet.detents = [.medium(), .large()]
                sheet.prefersGrabberVisible = true
            }
            presenter.present(controller, animated: true)
            call.resolve()
        }
    }
}
