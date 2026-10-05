import type { PolicyDraft } from './rule-builder';

/**
 * The unsigned draft from Guard rules, kept in this browser tab only (sessionStorage), so the simulator
 * can run it before the user signs. It is tied to the signed version it was edited from and ignored
 * once that version changes.
 */
const KEY = (account: string) => `bw-draft.${account.toLowerCase()}`;

export function saveDraft(account: string, signedHash: string | null, draft: PolicyDraft | null) {
  try {
    if (draft) sessionStorage.setItem(KEY(account), JSON.stringify({ signedHash, draft }));
    else sessionStorage.removeItem(KEY(account));
  } catch {
    // storage blocked: the simulator just won't offer the draft
  }
}

export function loadDraft(account: string, signedHash: string | null): PolicyDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY(account));
    if (!raw) return null;
    const v = JSON.parse(raw) as { signedHash: string | null; draft: PolicyDraft };
    return v.signedHash === signedHash ? v.draft : null;
  } catch {
    return null;
  }
}
