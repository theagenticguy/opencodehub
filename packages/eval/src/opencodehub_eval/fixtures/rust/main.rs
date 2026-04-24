mod auth;

use auth::AuthService;

fn login(service: &AuthService, email: &str, password: &str) -> bool {
    service.sign_in(email, password).is_some()
}

fn main() {
    let mut service = AuthService::new();
    service.register("alice@example.com", "hunter2");
    let ok = login(&service, "alice@example.com", "hunter2");
    println!("login: {}", ok);
}
