import LocalAuthentication

/// Проверка владельца телефона: Face ID, а если он не сработал — код телефона. Без кода на телефоне
/// защитить нечем — тогда показываем.
enum Biometric {
    @MainActor
    static func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Отмена"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return true }
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            return false
        }
    }
}
