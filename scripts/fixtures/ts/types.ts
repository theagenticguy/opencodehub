export interface User {
  readonly email: string;
  readonly passwordHash: string;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}
