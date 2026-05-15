// Minimal TypeScript fixture for the install-matrix smoke test.
// Keep small — the smoke gate only needs `codehub analyze` + `codehub query`
// to find at least one `export default` hit somewhere in the fixture.

export interface Greeting {
  language: string;
  text: string;
}

export default function greet(name: string): Greeting {
  return { language: "en", text: `Hello, ${name}!` };
}
