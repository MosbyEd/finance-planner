import Capacitor
import UIKit

/// Интерфейс (WebView) с мостом Capacitor и собственным плагином BudgetNative. Живёт внутри RootViewController.
class BudgetViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BudgetNativePlugin())
    }

    override func viewDidLoad() {
        // Прозрачный WebView: на Главной окна интерфейса ложатся поверх нативного экрана. До super.viewDidLoad():
        // там начинается загрузка, и Capacitor после неё возвращает isOpaque, запомненный в этот момент.
        if let webView {
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
            webView.underPageBackgroundColor = .clear
            webView.isOpaque = false
        }
        super.viewDidLoad()
    }
}
