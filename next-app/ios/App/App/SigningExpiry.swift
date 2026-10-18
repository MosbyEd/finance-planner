import Foundation
import UserNotifications

/// Срок подписи. «Бюджет» подписан бесплатным личным Apple ID: профиль живёт 7 дней, потом iOS не запускает
/// ни приложение, ни его действие в «Командах» — СМС перестают записываться (так пропали операции 18.10).
/// Поэтому заранее напоминаем переустановить приложение с Mac. Дата — из встроенного профиля
/// (embedded.mobileprovision); у сборки из App Store и на симуляторе его нет, и тогда ничего не делаем.
enum SigningExpiry {
    /// Когда закончится подпись; nil — профиля нет.
    static let date: Date? = readExpirationDate()

    /// Напоминание — за 32 часа: есть время добраться до Mac. Ночью не будим (см. reminderDate).
    static let lead: TimeInterval = 32 * 3600

    // Идентификаторы постоянные — новое уведомление заменяет прежнее — и нечисловые: интерфейс при каждом
    // перепланировании снимает все отложенные (src/client/notifications.ts), но Capacitor отдаёт ему
    // нечисловой идентификатор как -1, и наши уведомления остаются.
    private static let reminderId = "signing-expiry-reminder"
    private static let expiredId = "signing-expired"

    /// Профиль — подписанный CMS plist: сам plist лежит в нём открытым текстом.
    private static func readExpirationDate() -> Date? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data[start.lowerBound..<end.upperBound], format: nil),
              let expiration = (plist as? [String: Any])?["ExpirationDate"] as? Date
        else { return nil }
        return expiration
    }

    /// За `lead` до конца срока, но не ночью: выпало до 9:00 — в 9:00 того же утра, после 22:00 — в 21:00.
    static func reminderDate(for expiry: Date, calendar: Calendar = .current) -> Date {
        let target = expiry.addingTimeInterval(-lead)
        let hour = calendar.component(.hour, from: target)
        if hour < 9 { return calendar.date(bySettingHour: 9, minute: 0, second: 0, of: target) ?? target }
        if hour >= 22 { return calendar.date(bySettingHour: 21, minute: 0, second: 0, of: target) ?? target }
        return target
    }

    /// Ставит напоминание и уведомление в момент окончания — при запуске и при уходе в фон. После
    /// переустановки с новым профилем они заменяют прежние, а уже показанные о старом сроке убираются.
    static func schedule(now: Date = Date()) {
        guard let expiry = date else { return }
        let center = UNUserNotificationCenter.current()
        let reminder = reminderDate(for: expiry)
        if reminder > now {
            center.removeDeliveredNotifications(withIdentifiers: [reminderId, expiredId])
            add(reminderId, at: reminder, now: now,
                title: "Подпись «Бюджета» заканчивается",
                body: "\(describe(expiry, from: reminder).capitalizedFirst) — переустановите приложение с Mac, иначе СМС перестанут записываться.")
        }
        if expiry > now {
            add(expiredId, at: expiry, now: now,
                title: "Подпись «Бюджета» закончилась",
                body: "СМС больше не записываются. Переустановите приложение с Mac, а пропущенные СМС добавьте через «+» → «Из СМС».")
        }
        if UserDefaults.standard.bool(forKey: "BudgetDebugSigning") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { logPending(expiry: expiry) }
        }
    }

    private static func add(_ id: String, at date: Date, now: Date, title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        // По интервалу, а не по часам: сработает в тот же момент и после смены часового пояса.
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: date.timeIntervalSince(now), repeats: false)
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    /// Строка «Требует внимания» на Главной, когда до конца подписи меньше двух суток.
    static func attention(now: Date = Date()) -> HomeModel.Attention? {
        guard let expiry = date, expiry > now, expiry.timeIntervalSince(now) < 2 * 86400 else { return nil }
        return HomeModel.Attention(
            id: "signing-expiry",
            symbol: "clock.badge.exclamationmark",
            tone: .warning,
            title: "Подпись заканчивается \(describe(expiry, from: now))",
            text: "Переустановите «Бюджет» с Mac — иначе СМС перестанут записываться.",
            command: nil,
            actions: [],
            dismiss: nil
        )
    }

    /// «сегодня в 21:03», «завтра в 21:03» или «26 октября в 00:03» — относительно `from`.
    static func describe(_ date: Date, from: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ru_RU")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "HH:mm"
        let time = formatter.string(from: date)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: from), to: calendar.startOfDay(for: date)).day
        switch days {
        case 0: return "сегодня в \(time)"
        case 1: return "завтра в \(time)"
        default:
            formatter.dateFormat = "d MMMM"
            return "\(formatter.string(from: date)) в \(time)"
        }
    }

    /// Для проверки на телефоне: `devicectl device process launch … -- -BudgetDebugSigning YES`.
    private static func logPending(expiry: Date) {
        UNUserNotificationCenter.current().getPendingNotificationRequests { requests in
            let iso = ISO8601DateFormatter()
            let ours = requests.filter { $0.identifier == reminderId || $0.identifier == expiredId }.map { request in
                let fire = (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
                return "\(request.identifier) at \(fire.map(iso.string) ?? "?"): \(request.content.body)"
            }
            NSLog("DBG-SIGNING expiry %@, lead %.0f h, reminder %@; pending: %@",
                  iso.string(from: expiry), lead / 3600, iso.string(from: reminderDate(for: expiry)),
                  ours.isEmpty ? "none" : ours.joined(separator: " | "))
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
