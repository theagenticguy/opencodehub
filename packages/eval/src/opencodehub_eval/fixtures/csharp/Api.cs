namespace Fixture;

public class Api
{
    private readonly Auth auth;

    public Api()
    {
        this.auth = new Auth();
    }

    public bool Login(string email, string password)
    {
        return auth.SignIn(email, password) != null;
    }

    public string Register(string email, string password)
    {
        return auth.Register(email, password);
    }
}
