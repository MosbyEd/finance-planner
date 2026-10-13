import Foundation
import JavaScriptCore

/// Разбор СМС на телефоне: код из src/domain (тот же, что на сервере), собранный в public/sms-engine.js
/// и выполняемый во встроенном JavaScriptCore. Работает без сети и без открытого интерфейса.
final class SmsEngine: @unchecked Sendable {
    static let shared = SmsEngine()

    /// Изменение из СМС: номер (сервер не применит его дважды) и действие.
    struct Op: Codable, Equatable, Sendable {
        var opId: String
        var action: JSONValue
    }

    struct Plan: Decodable, Sendable {
        /// added, duplicate, ignored, unparsed (формат банка не разобран), failed.
        var status: String
        var message: String
        var ops: [Op]
        /// Данные после этих изменений (JSON) — новая копия для следующих СМС.
        var stateJson: String?
    }

    private let queue = DispatchQueue(label: "budget.sms-engine")
    private var context: JSContext?
    private var broken = false

    private init() {}

    /// JSContext не потокобезопасен — все вызовы идут по очереди.
    private func withContext<T>(_ body: (JSContext) -> T?) -> T? {
        queue.sync {
            if context == nil, !broken {
                guard let url = Bundle.main.url(forResource: "sms-engine", withExtension: "js", subdirectory: "public"),
                      let source = try? String(contentsOf: url, encoding: .utf8),
                      let created = JSContext()
                else {
                    broken = true
                    return nil
                }
                created.exceptionHandler = { _, exception in
                    NSLog("Бюджет: ошибка разбора СМС: %@", exception?.toString() ?? "")
                }
                created.evaluateScript(source)
                if created.objectForKeyedSubscript("BudgetEngine")?.isUndefined ?? true {
                    broken = true
                    return nil
                }
                context = created
            }
            guard let context else { return nil }
            return body(context)
        }
    }

    private func call(_ function: String, _ input: String) -> String? {
        withContext { context in
            let engine = context.objectForKeyedSubscript("BudgetEngine")
            guard let result = engine?.invokeMethod(function, withArguments: [input]), result.isString else { return nil }
            return result.toString()
        }
    }

    /// СМС на копии данных. received — когда СМС пришла (день и время — в часовом поясе телефона, как в интерфейсе);
    /// sender — отправитель из «Команд», по нему определяется банк.
    func plan(stateJson: String, text: String, sender: String?, received: Date) -> Plan? {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: received)
        let day = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let from = sender.map { ",\"sender\":\(Self.quote($0))" } ?? ""
        let input = "{\"state\":\(stateJson),\"text\":\(Self.quote(text))\(from),\"day\":\"\(day)\",\"time\":\"\(time)\"}"
        guard let output = call("planJson", input), let data = output.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Plan.self, from: data)
    }

    /// Свежая копия данных из интерфейса плюс группы изменений, которые интерфейс ещё не принял.
    func apply(stateJson: String, groups: [[Op]]) -> String? {
        guard let groupsData = try? JSONEncoder().encode(groups), let groupsJson = String(data: groupsData, encoding: .utf8) else {
            return nil
        }
        guard let output = call("applyJson", "{\"state\":\(stateJson),\"groups\":\(groupsJson)}"),
              let data = output.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = object["state"],
              let stateData = try? JSONSerialization.data(withJSONObject: state)
        else { return nil }
        return String(data: stateData, encoding: .utf8)
    }

    private static func quote(_ text: String) -> String {
        guard let data = try? JSONEncoder().encode(text), let quoted = String(data: data, encoding: .utf8) else { return "\"\"" }
        return quoted
    }
}
