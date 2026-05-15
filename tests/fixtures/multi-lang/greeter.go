// Minimal Go fixture for the install-matrix smoke test.
package multilang

// Greeting is a localized greeting.
type Greeting struct {
	Language string
	Text     string
}

// Greet returns a greeting for the supplied name.
func Greet(name string) Greeting {
	return Greeting{Language: "en", Text: "Hello, " + name + "!"}
}
