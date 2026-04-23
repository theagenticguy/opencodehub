class Hasher {
  String hash(String raw) => 'sha256:${raw.length}:$raw';
}

class Auth {
  final Hasher _hasher = Hasher();
  final Map<String, String> _users = {};

  Map<String, String> register(String email, String password) {
    _users[email] = _hasher.hash(password);
    return {'email': email};
  }

  Map<String, String>? login(String email, String password) {
    final stored = _users[email];
    if (stored == null) return null;
    if (stored != _hasher.hash(password)) return null;
    return {'email': email};
  }

  void logout(String email) {
    // no-op at MVP
  }
}
