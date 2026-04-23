package main

import "fmt"

// AuthService is a minimal in-memory user store.
type AuthService struct {
	users map[string]string
}

// NewAuthService constructs an empty AuthService.
func NewAuthService() *AuthService {
	return &AuthService{users: map[string]string{}}
}

// SignIn verifies an email/password pair.
func (a *AuthService) SignIn(email, password string) (string, bool) {
	hash, ok := a.users[email]
	if !ok {
		return "", false
	}
	if hash != hashPassword(password) {
		return "", false
	}
	return email, true
}

// Register records a new user.
func (a *AuthService) Register(email, password string) string {
	a.users[email] = hashPassword(password)
	return email
}

func hashPassword(raw string) string {
	return fmt.Sprintf("sha256:%d:%s", len(raw), raw)
}
