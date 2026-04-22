<?php
namespace AuthFx;

class Hasher
{
    public function hash(string $raw): string
    {
        return "sha256:" . strlen($raw) . ":" . $raw;
    }
}

class Auth
{
    private Hasher $hasher;
    private array $users = [];

    public function __construct()
    {
        $this->hasher = new Hasher();
    }

    public function register(string $email, string $password): array
    {
        $this->users[$email] = $this->hasher->hash($password);
        return ["email" => $email];
    }

    public function login(string $email, string $password): ?array
    {
        if (!isset($this->users[$email])) {
            return null;
        }
        if ($this->users[$email] !== $this->hasher->hash($password)) {
            return null;
        }
        return ["email" => $email];
    }

    public function logout(string $email): void
    {
        // no-op at MVP
    }
}
