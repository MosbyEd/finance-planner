import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = RootViewController()
        window?.makeKeyAndVisible()
        // Открыли из виджета (budget://add, budget://home).
        if let url = connectionOptions.urlContexts.first?.url { openBudgetURL(url) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Приложение снова на экране — отправляем СМС, которые ждали в очереди без сети.
    func sceneDidBecomeActive(_ scene: UIScene) {
        Task { await SmsQueue.shared.flush() }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        if let url = URLContexts.first?.url, url.scheme == "budget" {
            openBudgetURL(url)
            return
        }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    private func openBudgetURL(_ url: URL) {
        guard url.scheme == "budget", let root = window?.rootViewController as? RootViewController else { return }
        root.open(link: url.host() ?? "")
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
