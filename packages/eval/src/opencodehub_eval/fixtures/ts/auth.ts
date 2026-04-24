import type { User } from "./types.js";

export class AuthService {
  private readonly users: Map<string, User>;

  constructor() {
    this.users = new Map();
  }

  signIn(email: string, password: string): User | null {
    const user = this.users.get(email);
    if (!user) return null;
    if (user.passwordHash !== hash(password)) return null;
    return user;
  }

  register(email: string, password: string): User {
    const user: User = { email, passwordHash: hash(password) };
    this.users.set(email, user);
    return user;
  }
}

function hash(raw: string): string {
  return `sha256:${raw.length}:${raw}`;
}
