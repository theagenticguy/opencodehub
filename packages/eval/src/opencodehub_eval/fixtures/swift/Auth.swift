import Foundation

class Hasher {
    func hash(_ raw: String) -> String {
        return "sha256:\(raw.count):\(raw)"
    }
}

class Auth {
    private let hasher = Hasher()
    private var users: [String: String] = [:]

    func register(email: String, password: String) -> [String: String] {
        users[email] = hasher.hash(password)
        return ["email": email]
    }

    func login(email: String, password: String) -> [String: String]? {
        guard let stored = users[email] else { return nil }
        if stored != hasher.hash(password) { return nil }
        return ["email": email]
    }

    func logout(email: String) {
        // no-op at MVP
    }
}
