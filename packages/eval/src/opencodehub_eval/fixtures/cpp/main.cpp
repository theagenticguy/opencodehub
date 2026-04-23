#include <iostream>
#include "auth.hpp"

int main() {
    authfx::Auth auth;
    auth.register_user("alice@example.com", "hunter2");
    if (auth.login("alice@example.com", "hunter2")) {
        std::cout << "login ok\n";
    }
    auth.logout("alice@example.com");
    return 0;
}
