package fixture;

public class Api {
    private final Auth auth;

    public Api() {
        this.auth = new Auth();
    }

    public boolean login(String email, String password) {
        return auth.signIn(email, password) != null;
    }

    public String register(String email, String password) {
        return auth.register(email, password);
    }
}
