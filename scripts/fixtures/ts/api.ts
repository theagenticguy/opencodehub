import { AuthService } from "./auth.js";
import type { LoginRequest } from "./types.js";

const authService = new AuthService();

export function login(req: LoginRequest): { ok: boolean; email?: string } {
  const user = authService.signIn(req.email, req.password);
  if (user === null) return { ok: false };
  return { ok: true, email: user.email };
}

export function register(req: LoginRequest): { ok: boolean; email: string } {
  const user = authService.register(req.email, req.password);
  return { ok: true, email: user.email };
}
