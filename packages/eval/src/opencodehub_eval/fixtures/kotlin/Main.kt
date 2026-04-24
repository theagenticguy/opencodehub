package authfx

fun main() {
    val auth = Auth()
    auth.register("alice@example.com", "hunter2")
    val result = auth.login("alice@example.com", "hunter2")
    if (result != null) {
        println("login ok")
    }
    auth.logout("alice@example.com")
}
