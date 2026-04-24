export class Auth {
  constructor() {
    this.users = new Map();
  }

  signIn(email, password) {
    const user = this.users.get(email);
    if (!user) return null;
    if (user.passwordHash !== hash(password)) return null;
    return user;
  }

  register(email, password) {
    const user = { email, passwordHash: hash(password) };
    this.users.set(email, user);
    return user;
  }
}

export function hash(raw) {
  return `sha256:${raw.length}:${raw}`;
}
