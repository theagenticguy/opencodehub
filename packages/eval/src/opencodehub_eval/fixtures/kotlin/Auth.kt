package authfx

class Hasher {
    fun hash(raw: String): String = "sha256:${raw.length}:$raw"
}

class Auth {
    private val hasher = Hasher()
    private val users = mutableMapOf<String, String>()

    fun register(email: String, password: String): Map<String, String> {
        users[email] = hasher.hash(password)
        return mapOf("email" to email)
    }

    fun login(email: String, password: String): Map<String, String>? {
        val hashed = users[email] ?: return null
        if (hashed != hasher.hash(password)) return null
        return mapOf("email" to email)
    }

    fun logout(email: String) {
        // no-op at MVP
    }
}
