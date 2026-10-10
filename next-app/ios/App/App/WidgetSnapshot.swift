import Foundation
import WidgetKit

/// Лимит на сегодня для виджета «Бюджет»: приложение пишет его в общую с виджетом папку (App Group)
/// при каждом изменении данных, виджет только читает. Файл входит в оба таргета.
struct WidgetSnapshot: Codable, Equatable {
    /// День, на который посчитан лимит (YYYY-MM-DD): вчерашняя цифра сегодня уже неверна.
    var date: String
    var label: String
    var amount: String
    var status: String
    /// accent, positive, warning, negative, muted.
    var statusTone: String
    var detail: String
    var over: Bool

    static let appGroup = "group.ru.ekinosian.budget"
    private static let key = "widget.snapshot"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    static func load() -> WidgetSnapshot? {
        defaults?.data(forKey: key).flatMap { try? JSONDecoder().decode(WidgetSnapshot.self, from: $0) }
    }

    /// Сохраняет и просит систему перерисовать виджеты — только если цифры изменились.
    static func save(_ snapshot: WidgetSnapshot?) {
        guard snapshot != load() else { return }
        if let snapshot, let data = try? JSONEncoder().encode(snapshot) {
            defaults?.set(data, forKey: key)
        } else {
            defaults?.removeObject(forKey: key)
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func clear() {
        save(nil)
    }

    /// Сегодняшняя дата в часовом поясе телефона — как в интерфейсе.
    static func today(_ now: Date = .now) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }
}
