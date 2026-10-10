import AppIntents
import Capacitor
import SwiftUI
import UIKit

/// Экран «Siri и Команды»: системная кнопка, открывающая действия приложения в «Командах», подсказки Siri
/// и шаги для автоматизации по СМС — её iOS разрешает создать только самому пользователю.
struct ShortcutsSheet: View {
    var onDone: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
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
                    Label("Отправитель — 900, включите «Запускать сразу»", systemImage: "2.circle")
                    Label("Действие «Добавить операцию из СМС», в поле «Текст СМС» — «Ввод команды»", systemImage: "3.circle")
                    Button {
                        if let url = URL(string: "shortcuts://") { openURL(url) }
                    } label: {
                        Label("Открыть «Команды»", systemImage: "arrow.up.forward.app")
                    }
                } header: {
                    Text("Операции из СМС")
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
