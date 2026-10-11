import ActivityKit
import Foundation
import UIKit
import UserNotifications

/// Вопросы помощнику из приложения. Запрос идёт фоновой сессией URLSession: свернули приложение — система
/// сама доведёт его до конца и разбудит приложение с ответом. Пока помощник думает — Live Activity
/// (Dynamic Island и экран блокировки); ответ готов, а чат не открыт — уведомление. Ответ хранится здесь,
/// пока интерфейс его не заберёт (aiInbox/aiAck): так он не теряется, даже если приложение выгрузили.
final class AiRequests: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let shared = AiRequests()
    static let sessionId = "ru.ekinosian.budget.ai"

    struct Meta: Codable {
        var requestId: String
        var threadId: String
        var account: String
        var startedAt: Date
    }

    struct Done: Codable {
        var requestId: String
        var threadId: String
        var account: String
        /// HTTP-статус; 0 — нет связи или запрос потерялся.
        var status: Int
        var body: String
    }

    private let lock = NSLock()
    private var buffers: [Int: Data] = [:]
    /// Обработчик системы для фоновой сессии: вызвать, когда все её события разобраны.
    var backgroundCompletion: (() -> Void)?
    /// Открыт ли чат помощника (сообщает интерфейс): ответ в открытый чат приходит без уведомления.
    var chatVisible = false

    lazy var session: URLSession = {
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        config.sessionSendsLaunchEvents = true
        config.isDiscretionary = false
        config.timeoutIntervalForRequest = 210
        config.timeoutIntervalForResource = 600
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    // MARK: - Хранение

    private let directory: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent("budget", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private var runningURL: URL { directory.appendingPathComponent("ai-running.json") }
    private var doneURL: URL { directory.appendingPathComponent("ai-done.json") }

    private func read<T: Decodable>(_ url: URL) -> [T] {
        (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode([T].self, from: $0) } ?? []
    }

    private func write<T: Encodable>(_ items: [T], to url: URL) {
        try? JSONEncoder().encode(items).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func modify<T: Codable>(_ url: URL, _ change: (inout [T]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var items: [T] = read(url)
        change(&items)
        write(Array(items.suffix(50)), to: url)
    }

    // MARK: - Запрос

    enum StartError: Error {
        case notSignedIn
    }

    /// Задать вопрос: body — тело запроса /api/ai/chat (сообщения, режим, дата) в JSON.
    func start(requestId: String, threadId: String, question: String, engine: String, expectedSeconds: Int, body: Data) throws {
        guard let token = BudgetStore.token, let base = BudgetStore.apiBase, let account = BudgetStore.account,
              let url = URL(string: base + "/api/ai/chat")
        else { throw StartError.notSignedIn }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("native", forHTTPHeaderField: "X-Client")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let file = directory.appendingPathComponent("ai-\(requestId).json")
        try body.write(to: file, options: .atomic)

        let meta = Meta(requestId: requestId, threadId: threadId, account: account, startedAt: Date())
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = (try? JSONEncoder().encode(meta)).flatMap { String(data: $0, encoding: .utf8) }
        modify(runningURL) { (items: inout [Meta]) in items.append(meta) }
        task.resume()
        askNotificationPermission()
        startActivity(meta, question: question, engine: engine, expectedSeconds: expectedSeconds)
    }

    /// Готовые ответы и вопросы в пути — для интерфейса этого аккаунта. Вопрос, чей запрос система
    /// потеряла (например, после перезагрузки телефона), становится ответом-ошибкой.
    func inbox(account: String) async -> (done: [Done], running: [Meta]) {
        let tasks = await session.allTasks
        let live = Set(tasks.compactMap { task in
            task.taskDescription.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(Meta.self, from: $0) }?.requestId
        })
        let lost: [Meta] = (read(runningURL) as [Meta]).filter { !live.contains($0.requestId) }
        if !lost.isEmpty {
            modify(runningURL) { (items: inout [Meta]) in items.removeAll { m in lost.contains { $0.requestId == m.requestId } } }
            modify(doneURL) { (items: inout [Done]) in
                items += lost.map { Done(requestId: $0.requestId, threadId: $0.threadId, account: $0.account, status: 0, body: "") }
            }
        }
        let done: [Done] = read(doneURL)
        let running: [Meta] = read(runningURL)
        return (done.filter { $0.account == account }, running.filter { $0.account == account })
    }

    func acknowledge(_ ids: [String]) {
        let set = Set(ids)
        modify(doneURL) { (items: inout [Done]) in items.removeAll { set.contains($0.requestId) } }
    }

    /// Чат открыли или закрыли. Открыли — готовый ответ уже виден, Live Activity больше не нужна.
    func setChatVisible(_ visible: Bool) {
        chatVisible = visible
        guard visible else { return }
        for activity in Activity<AiActivityAttributes>.activities where activity.content.state.phase != .thinking {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    // MARK: - URLSession

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffers[dataTask.taskIdentifier, default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let data = buffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        lock.unlock()
        guard let meta = task.taskDescription.flatMap({ $0.data(using: .utf8) }).flatMap({ try? JSONDecoder().decode(Meta.self, from: $0) })
        else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent("ai-\(meta.requestId).json"))
        let status = error == nil ? ((task.response as? HTTPURLResponse)?.statusCode ?? 0) : 0
        finish(meta, status: status, body: String(data: data, encoding: .utf8) ?? "")
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async {
            self.backgroundCompletion?()
            self.backgroundCompletion = nil
        }
    }

    // MARK: - Ответ

    private struct Reply {
        var text: String
        var hasProposal: Bool
        var failed: Bool
    }

    private func reply(status: Int, body: String) -> Reply {
        let object = body.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        if (200..<300).contains(status), let text = object["text"] as? String {
            return Reply(text: text, hasProposal: !(object["proposal"] is NSNull) && object["proposal"] != nil, failed: false)
        }
        let message = (object["error"] as? String) ?? (object["message"] as? String)
        return Reply(text: message ?? (status == 0 ? "Нет связи с сервером." : "Не удалось получить ответ."), hasProposal: false, failed: true)
    }

    private func finish(_ meta: Meta, status: Int, body: String) {
        modify(runningURL) { (items: inout [Meta]) in items.removeAll { $0.requestId == meta.requestId } }
        modify(doneURL) { (items: inout [Done]) in
            items.append(Done(requestId: meta.requestId, threadId: meta.threadId, account: meta.account, status: status, body: body))
        }
        let result = reply(status: status, body: body)
        let background = UIApplication.shared.beginBackgroundTask(withName: "ai-reply")
        Task {
            await finishActivity(meta, result)
            DispatchQueue.main.async {
                if background != .invalid { UIApplication.shared.endBackgroundTask(background) }
            }
        }
        DispatchQueue.main.async {
            let active = UIApplication.shared.applicationState == .active
            if !(active && self.chatVisible) { self.notify(meta, result) }
            AppShell.shared.plugin?.notifyListeners(
                "aiReply",
                data: ["requestId": meta.requestId, "threadId": meta.threadId, "status": status, "body": body],
                retainUntilConsumed: true
            )
        }
    }

    // MARK: - Уведомление

    private func askNotificationPermission() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .notDetermined else { return }
            center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
    }

    private func notify(_ meta: Meta, _ reply: Reply) {
        let content = UNMutableNotificationContent()
        content.title = reply.failed ? "Помощник не ответил" : "Ответ помощника готов"
        let text = Self.clip(reply.text, 180)
        content.body = reply.hasProposal ? "\(Self.clip(reply.text, 110)) Откройте, чтобы подтвердить изменения." : text
        content.sound = .default
        content.threadIdentifier = "ai"
        // cap_extra — как у уведомлений интерфейса: нажатие придёт в него и откроет этот чат.
        content.userInfo = ["cap_extra": ["kind": "ai", "threadId": meta.threadId]]
        let id = String(Int.random(in: 1_000_000_000..<2_000_000_000))
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    static func clip(_ text: String, _ limit: Int) -> String {
        let line = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return line.count > limit ? String(line.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…" : line
    }

    // MARK: - Live Activity

    private func startActivity(_ meta: Meta, question: String, engine: String, expectedSeconds: Int) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        // Прошлый ответ ещё висит — убираем: показываем только текущий вопрос.
        for activity in Activity<AiActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        let attributes = AiActivityAttributes(threadId: meta.threadId, engine: engine)
        let state = AiActivityAttributes.ContentState(
            phase: .thinking,
            startedAt: meta.startedAt,
            expectedSeconds: expectedSeconds,
            detail: Self.clip(question, 120)
        )
        _ = try? Activity.request(attributes: attributes, content: .init(state: state, staleDate: Date().addingTimeInterval(600)))
    }

    private func finishActivity(_ meta: Meta, _ reply: Reply) async {
        guard let activity = Activity<AiActivityAttributes>.activities.first(where: { $0.attributes.threadId == meta.threadId }) else { return }
        var state = activity.content.state
        state.phase = reply.failed ? .failed : .ready
        state.detail = Self.clip(reply.text, 140)
        state.hasProposal = reply.hasProposal
        await activity.update(.init(state: state, staleDate: nil))
        // «Готово» видно в Dynamic Island несколько секунд, на экране блокировки — до 10 минут.
        try? await Task.sleep(for: .seconds(8))
        await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(600)))
    }
}
