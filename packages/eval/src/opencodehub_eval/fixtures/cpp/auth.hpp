#pragma once

#include <string>
#include <unordered_map>

namespace authfx {

class Hasher {
public:
    virtual std::string hash(const std::string& raw) const;
    virtual ~Hasher() = default;
};

class Auth {
public:
    Auth();
    bool register_user(const std::string& email, const std::string& password);
    bool login(const std::string& email, const std::string& password);
    void logout(const std::string& email);

private:
    Hasher hasher_;
    std::unordered_map<std::string, std::string> users_;
};

}  // namespace authfx
