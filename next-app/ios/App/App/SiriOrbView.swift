import UIKit

/// «Шар» в духе Siri из iOS 27: стекло Liquid Glass с лёгким тёмным оттенком и мягким серебристым
/// переливом внутри. Пока помощник думает, выплывает сверху из-под «острова» и «дышит».
final class SiriOrbView: UIView {
    private let glass = UIVisualEffectView()
    private let core = UIView()
    private let shimmer = CAGradientLayer()
    private let diffuser = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterial))
    private static let size: CGFloat = 60

    override init(frame: CGRect) {
        super.init(frame: CGRect(x: 0, y: 0, width: Self.size, height: Self.size))
        isUserInteractionEnabled = false
        alpha = 0

        let effect = UIGlassEffect(style: .regular)
        effect.tintColor = UIColor(white: 0.1, alpha: 0.32)
        glass.effect = effect
        glass.cornerConfiguration = .capsule()
        glass.frame = bounds
        glass.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(glass)

        // Ядро: вращающийся серебристый конический градиент, размытый сверху — получается перелив, а не «вертушка».
        core.frame = bounds.insetBy(dx: 11, dy: 11)
        core.layer.cornerRadius = core.bounds.width / 2
        core.clipsToBounds = true
        shimmer.type = .conic
        shimmer.startPoint = CGPoint(x: 0.5, y: 0.5)
        shimmer.endPoint = CGPoint(x: 0.5, y: 0)
        shimmer.colors = [0.96, 0.68, 0.9, 0.55, 0.82, 0.62, 0.96].map { UIColor(white: $0, alpha: 1).cgColor }
        shimmer.frame = core.bounds.insetBy(dx: -6, dy: -6)
        core.layer.addSublayer(shimmer)
        diffuser.frame = core.bounds
        core.addSubview(diffuser)
        glass.contentView.addSubview(core)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) не используется")
    }

    /// Показать (выплывает из-под «острова») или спрятать (уходит обратно). topInset — отступ безопасной зоны сверху.
    func setActive(_ active: Bool, topInset: CGFloat, in container: UIView) {
        let restCenter = CGPoint(x: container.bounds.midX, y: topInset + 10 + Self.size / 2)
        let islandCenter = CGPoint(x: container.bounds.midX, y: max(18, topInset / 2))
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        if active {
            startShimmer()
            center = reduceMotion ? restCenter : islandCenter
            transform = reduceMotion ? .identity : CGAffineTransform(scaleX: 0.3, y: 0.3)
            UIView.animate(withDuration: reduceMotion ? 0.2 : 0.7, delay: 0, usingSpringWithDamping: 0.62, initialSpringVelocity: 0.4, options: [.beginFromCurrentState]) {
                self.alpha = 1
                self.center = restCenter
                self.transform = .identity
            }
        } else {
            UIView.animate(withDuration: reduceMotion ? 0.2 : 0.45, delay: 0, options: [.beginFromCurrentState, .curveEaseIn]) {
                self.alpha = 0
                if !reduceMotion {
                    self.center = islandCenter
                    self.transform = CGAffineTransform(scaleX: 0.3, y: 0.3)
                }
            } completion: { finished in
                if finished, self.alpha == 0 { self.stopShimmer() }
            }
        }
    }

    private func startShimmer() {
        guard !UIAccessibility.isReduceMotionEnabled, shimmer.animation(forKey: "spin") == nil else { return }
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0
        spin.toValue = Double.pi * 2
        spin.duration = 2.6
        spin.repeatCount = .infinity
        shimmer.add(spin, forKey: "spin")
        let breathe = CABasicAnimation(keyPath: "transform.scale")
        breathe.fromValue = 1
        breathe.toValue = 0.88
        breathe.duration = 1
        breathe.autoreverses = true
        breathe.repeatCount = .infinity
        breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        glass.layer.add(breathe, forKey: "breathe")
    }

    private func stopShimmer() {
        shimmer.removeAllAnimations()
        glass.layer.removeAnimation(forKey: "breathe")
    }
}
