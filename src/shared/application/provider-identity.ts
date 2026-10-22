/** Credenciais cruas que a borda HTTP entrega à porta. Nunca logadas. */
export interface ProviderCredentials {
  /** Valor do header `Authorization` como chegou, ou `undefined` se ausente. */
  readonly authorization: string | undefined;
}

/** Quem fez a requisição. `anonymous` é o que o adapter no-op devolve; `provider` é o que um IdP real devolveria. */
export type ProviderIdentity =
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'provider'; readonly providerId: string };

/** Porta de autenticação (§2). `null` = credenciais ausentes ou inválidas → 401. */
export abstract class ProviderIdentityPort {
  abstract authenticate(credentials: ProviderCredentials): Promise<ProviderIdentity | null>;
}
