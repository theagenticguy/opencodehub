import { Auth } from "./utils.js";

const auth = new Auth();

export function login(req) {
  const user = auth.signIn(req.email, req.password);
  if (user === null) return { ok: false };
  return { ok: true, email: user.email };
}

export function register(req) {
  const user = auth.register(req.email, req.password);
  return { ok: true, email: user.email };
}
