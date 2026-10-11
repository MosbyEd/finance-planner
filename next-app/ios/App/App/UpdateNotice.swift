import Foundation
import UserNotifications

/// Пуш «Бюджет обновлён». После установки новой сборки её запускают в фоне, не открывая
/// (`devicectl device process launch --no-activate … -BudgetUpdateNotice "<что нового>"`): приложение
/// показывает уведомление, нажатие открывает его, а интерфейс — окно «Что нового».
enum UpdateNotice {
    static func postIfRequested() {
        guard let text = UserDefaults.standard.string(forKey: "BudgetUpdateNotice"), !text.isEmpty else { return }
        let content = UNMutableNotificationContent()
        content.title = "Бюджет обновлён"
        content.body = text
        content.sound = .default
        content.userInfo = ["cap_extra": ["kind": "whatsNew"]]
        let id = String(Int.random(in: 1_000_000_000..<2_000_000_000))
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}
