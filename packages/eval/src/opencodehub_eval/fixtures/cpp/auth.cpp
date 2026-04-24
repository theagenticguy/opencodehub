#include "auth.hpp"

namespace authfx {

std::string Hasher::hash(const std::string& raw) const {
    return "sha256:" + std::to_string(raw.size()) + ":" + raw;
}

Auth::Auth() = default;

bool Auth::register_user(const std::string& email, const std::string& password) {
    users_[email] = hasher_.hash(password);
    return true;
}

bool Auth::login(const std::string& email, const std::string& password) {
    auto it = users_.find(email);
    if (it == users_.end()) return false;
    return it->second == hasher_.hash(password);
}

void Auth::logout(const std::string& /*email*/) {
    // No-op at MVP: session store not implemented in this fixture.
}

}  // namespace authfx
