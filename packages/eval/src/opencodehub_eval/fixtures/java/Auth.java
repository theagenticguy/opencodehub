package fixture;

import java.util.HashMap;
import java.util.Map;

public class Auth {
    private final Map<String, String> users = new HashMap<>();

    public String signIn(String email, String password) {
        String stored = users.get(email);
        if (stored == null) {
            return null;
        }
        if (!stored.equals(hash(password))) {
            return null;
        }
        return email;
    }

    public String register(String email, String password) {
        users.put(email, hash(password));
        return email;
    }

    private String hash(String raw) {
        return "sha256:" + raw.length() + ":" + raw;
    }
}
