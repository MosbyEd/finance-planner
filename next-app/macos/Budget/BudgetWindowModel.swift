import AppKit
import LocalAuthentication
import Observation
import SwiftUI
import WebKit

/**
 * Сайт бюджета в окне. Сайт сообщает текущий раздел, заголовок и статус сохранения (сообщение budgetDesktop),
 * окно присылает ему команды событием «budget-desktop» (см. src/client/desktop.ts). Touch ID для спрятанных сумм —
 * сообщение budgetDesktopAuth с ответом.
 */
@MainActor
@Observable
final class BudgetWindowModel: NSObject {
    var section: BudgetSection = .home
    var title = "Бюджет"
    var status = ""
    var aiAvailable = false
    var loadError: String?

    @ObservationIgnored let webView: WKWebView
    @ObservationIgnored private let serverURL: URL
    @ObservationIgnored private var downloads: [ObjectIdentifier: URL] = [:]

    override init() {
        let address = ProcessInfo.processInfo.environment["BUDGET_SERVER_URL"]
            ?? Bundle.main.object(forInfoDictionaryKey: "BudgetServerURL") as? String
            ?? "https://45-132-178-214.sslip.io"
        serverURL = URL(string: address)!

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "BudgetMac/1.0"
        let content = WKUserContentController()
        // Ещё до загрузки: сайт сразу рисуется без своей шапки и нижней панели.
        content.addUserScript(WKUserScript(
            source: "document.documentElement.classList.add('desktop-app')",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        configuration.userContentController = content
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()

        content.add(self, name: "budgetDesktop")
        content.addScriptMessageHandler(self, contentWorld: .page, name: "budgetDesktopAuth")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = false
        webView.load(URLRequest(url: serverURL))
    }

    /** Команда сайту: { type: "tab", tab } / { type: "add" } / { type: "ai" }. */
    func send(_ command: [String: String]) {
        guard let data = try? JSONSerialization.data(withJSONObject: command),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('budget-desktop', { detail: \(json) }))")
    }

    func select(_ next: BudgetSection) {
        section = next
        send(["type": "tab", "tab": next.rawValue])
    }

    func reload() {
        loadError = nil
        if webView.url == nil {
            webView.load(URLRequest(url: serverURL))
        } else {
            webView.reload()
        }
    }

    /** 0 — обычный размер. */
    func zoom(by step: CGFloat) {
        webView.pageZoom = step == 0 ? 1 : min(2, max(0.6, webView.pageZoom + step))
    }

    private func isOwnSite(_ url: URL) -> Bool {
        url.host == serverURL.host || url.scheme == "blob" || url.scheme == "data" || url.scheme == "about"
    }
}

// MARK: - Сообщения сайта

extension BudgetWindowModel: WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["type"] as? String == "state" else { return }
        if let tab = body["tab"] as? String, let next = BudgetSection(rawValue: tab), next != section { section = next }
        if let text = body["title"] as? String { title = text }
        if let text = body["status"] as? String { status = text }
        if let ai = body["ai"] as? Bool { aiAvailable = ai }
    }

    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        let reason = (message.body as? [String: Any])?["reason"] as? String ?? "показать суммы на счетах"
        let context = LAContext()
        var error: NSError?
        // Ни Touch ID, ни пароля проверить нельзя — как в браузере, без проверки.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            replyHandler(true, nil)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
            Task { @MainActor in replyHandler(ok, nil) }
        }
    }
}

// MARK: - Переходы, загрузки, окна

extension BudgetWindowModel: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        if action.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        // Чужие ссылки — в браузере по умолчанию.
        if let url = action.request.url, !isOwnSite(url) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loadError = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        loadError = error.localizedDescription
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /** target="_blank" и window.open — в браузере по умолчанию. */
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for action: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = action.request.url, !isOwnSite(url) { NSWorkspace.shared.open(url) }
        return nil
    }

    /** «Загрузить из файла». */
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.begin { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Отмена")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    /** Резервная копия и CSV — в «Загрузки», без вопросов; по окончании файл показывается в Finder. */
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
    ) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let name = suggestedFilename as NSString
        var url = folder.appendingPathComponent(suggestedFilename)
        var copy = 2
        while FileManager.default.fileExists(atPath: url.path) {
            let base = "\(name.deletingPathExtension) \(copy)"
            url = folder.appendingPathComponent(name.pathExtension.isEmpty ? base : "\(base).\(name.pathExtension)")
            copy += 1
        }
        downloads[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
    }
}

/** Готовый WKWebView модели — в иерархию SwiftUI. */
struct WebContainer: NSViewRepresentable {
    let webView: WKWebView

    func makeNSView(context: Context) -> WKWebView { webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
