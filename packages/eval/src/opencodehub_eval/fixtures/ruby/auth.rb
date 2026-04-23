# A tiny auth module used as an eval fixture.

module AuthFx
  class Hasher
    def hash(raw)
      "sha256:#{raw.length}:#{raw}"
    end
  end

  class Auth
    def initialize
      @hasher = Hasher.new
      @users = {}
    end

    def register(email, password)
      @users[email] = @hasher.hash(password)
      { email: email }
    end

    def login(email, password)
      hash = @users[email]
      return nil if hash.nil?
      return nil unless hash == @hasher.hash(password)
      { email: email }
    end

    def logout(_email)
      # no-op at MVP
    end
  end
end
