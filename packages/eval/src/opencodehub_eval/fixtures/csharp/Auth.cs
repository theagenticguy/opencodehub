namespace Fixture;

using System.Collections.Generic;

public class Auth
{
    private readonly Dictionary<string, string> users = new();

    public string? SignIn(string email, string password)
    {
        if (!users.TryGetValue(email, out var stored))
        {
            return null;
        }
        if (stored != Hash(password))
        {
            return null;
        }
        return email;
    }

    public string Register(string email, string password)
    {
        users[email] = Hash(password);
        return email;
    }

    private string Hash(string raw)
    {
        return $"sha256:{raw.Length}:{raw}";
    }
}
