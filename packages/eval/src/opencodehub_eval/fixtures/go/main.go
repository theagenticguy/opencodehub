package main

import "fmt"

func login(a *AuthService, email, password string) bool {
	_, ok := a.SignIn(email, password)
	return ok
}

func main() {
	auth := NewAuthService()
	auth.Register("alice@example.com", "hunter2")
	ok := login(auth, "alice@example.com", "hunter2")
	fmt.Println("login:", ok)
}
