// De qual ferramenta é cada coisa (Claude Code ou Codex) e os textos que mudam com ela. Puro (sem DOM): testado em
// ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual do Codex (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda e letra na
// cor da conta, cantos em degrau) e, onde há espaço, um selo de texto "Codex" ao lado do nome.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isAntigravity(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'antigravity';
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

export function looksLikeAntigravityId(id: string): boolean {
  return /(?:^|[:/\\])\.?(?:antigravity|gemini)(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  if (hint) return hint;
  if (looksLikeAntigravityId(fallbackId)) return 'antigravity';
  return looksLikeCodexId(fallbackId) ? 'codex' : 'claude';
}

/**
 * Letra do chip de uma conta que não está no snapshot.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|antigravity|gemini)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  if (provider === 'codex') return 'X';
  if (provider === 'antigravity') return 'G';
  return '?';
}

/** O selo ao lado do nome da conta (não repete quando o nome já diz a ferramenta). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  if (provider === 'codex') return !/codex/i.test(accountName);
  if (provider === 'antigravity') return !/antigravity/i.test(accountName);
  return false;
}

/** Rótulo do chip da conta (dica e leitores de tela). */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider !== 'claude' ? ` · ${PROVIDER_NAME[provider]}` : ''}` : 'Conta desconhecida';
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? ` · plano ${account.plan}` : ''}`;
}

/**
 * Texto do escritório vazio.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a) && !isAntigravity(a)));
  const hasCodex = accounts.some(isCodex);
  const hasAntigravity = accounts.some(isAntigravity);

  if (!hasCodex && !hasAntigravity) {
    return `Abra o Claude Code em qualquer projeto${keys ? ` (${keys})` : ''} e veja seu agente chegar.`;
  }
  const others: string[] = [];
  if (hasCodex) others.push('o Codex');
  if (hasAntigravity) others.push('o Antigravity');
  return `Abra o Claude Code${keys ? ` (${keys})` : ''} ou ${others.join(' ou ')} em qualquer projeto e veja seu agente chegar.`;
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = 'Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.';

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: 'Pergunta antes de quase tudo',
  'on-request': 'Pergunta quando precisa',
  'on-failure': 'Pergunta quando um comando falha',
  never: 'Nunca pergunta',
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
