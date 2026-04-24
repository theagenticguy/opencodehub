use std::collections::HashMap;

pub struct AuthService {
    users: HashMap<String, String>,
}

impl AuthService {
    pub fn new() -> Self {
        AuthService { users: HashMap::new() }
    }

    pub fn sign_in(&self, email: &str, password: &str) -> Option<String> {
        let stored = self.users.get(email)?;
        if *stored != hash_password(password) {
            return None;
        }
        Some(email.to_string())
    }

    pub fn register(&mut self, email: &str, password: &str) -> String {
        self.users.insert(email.to_string(), hash_password(password));
        email.to_string()
    }
}

fn hash_password(raw: &str) -> String {
    format!("sha256:{}:{}", raw.len(), raw)
}
