import Foundation

let auth = Auth()
_ = auth.register(email: "alice@example.com", password: "hunter2")
if let _ = auth.login(email: "alice@example.com", password: "hunter2") {
    print("login ok")
}
auth.logout(email: "alice@example.com")
