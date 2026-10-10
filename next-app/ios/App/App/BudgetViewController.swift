import Capacitor
import UIKit

/// Экран приложения: тот же мост Capacitor плюс собственный плагин BudgetNative.
class BudgetViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BudgetNativePlugin())
    }
}
