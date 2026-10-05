import { createSealedAgentKey, resealAgentKey, type MasterKeys } from '@bulwarkxyz/signer';
import type { AuditInput, GuardStore, KeyVault } from '@bulwarkxyz/store';

/**
 * Encrypted-at-rest agent keys on the signing service: creates them on request, promotes a rotated
 * key once the user has approved it on Hyperliquid, reseals after a master-key rotation, and wipes.
 * Only addresses and blobs move through here; private keys exist only inside the signer, per signature.
 */
export interface KeyServiceDeps {
  vault: KeyVault;
  store: Pick<GuardStore, 'user' | 'audit'>;
  /** Null when SIGNER_MASTER_KEYS is not set on this service: requests are answered with an error. */
  master: MasterKeys | null;
  network: string;
  /** Addresses the user has approved as agents on Hyperliquid. */
  approvedAgents(account: string): Promise<string[]>;
  /** Called after an account's signing key changes, so cached signers are dropped. */
  onKeyChanged(account: string): void;
  now(): number;
}

export const SEALED_PREFIX = 'sealed:';

export class KeyService {
  constructor(private readonly d: KeyServiceDeps) {}

  private audit(e: Omit<AuditInput, 'at'>) {
    return this.d.store.audit.append({ ...e, at: this.d.now() });
  }

  /** Handles the API's pending key requests. */
  async processRequests(): Promise<number> {
    const reqs = await this.d.vault.pendingKeyRequests(this.d.network);
    for (const r of reqs) {
      const now = this.d.now();
      if (!this.d.master) {
        await this.d.vault.finishKeyRequest(r.id, { error: 'sealed keys are not enabled on the signing service' }, now);
        continue;
      }
      const user = await this.d.store.user(r.account);
      if (!user) {
        await this.d.vault.finishKeyRequest(r.id, { error: 'unknown user' }, now);
        continue;
      }
      if (r.kind === 'create' && user.agentKeyRef.startsWith(SEALED_PREFIX)) {
        await this.d.vault.finishKeyRequest(r.id, { address: user.agentAddress, existing: true }, now);
        continue;
      }
      const k = createSealedAgentKey(this.d.master, r.account, this.d.network);
      const status = r.kind === 'create' ? 'active' : 'pending';
      await this.d.vault.putSealedKey({ account: r.account, network: this.d.network, address: k.address, sealed: k.sealed, masterKeyId: k.masterKeyId, status, createdAt: now, updatedAt: now });
      if (r.kind === 'create') {
        await this.d.vault.setUserAgent(r.account, `${SEALED_PREFIX}${k.address}`, k.address);
        this.d.onKeyChanged(r.account);
      }
      await this.audit({
        account: r.account,
        kind: 'key',
        why: r.kind === 'create' ? 'You asked for a guard key' : 'You asked to replace your guard key',
        what: r.kind === 'create' ? `Guard key created, stored encrypted (address ${k.address})` : `Replacement guard key created (address ${k.address}); it takes over once you approve it on Hyperliquid`,
        proof: { address: k.address, masterKeyId: k.masterKeyId },
      });
      await this.d.vault.finishKeyRequest(r.id, { address: k.address, status }, now);
    }
    return reqs.length;
  }

  /**
   * A replacement key takes over only after the user approves it on Hyperliquid; the key it replaces
   * is then wiped. Until then the guard keeps signing with the approved key.
   */
  async promoteRotations(accounts: readonly string[]): Promise<number> {
    let promoted = 0;
    for (const account of accounts) {
      const user = await this.d.store.user(account);
      if (!user) continue;
      const keys = await this.d.vault.agentKeys(account, this.d.network);
      const pending = keys.filter((k) => k.status === 'pending');
      if (!pending.length) continue;
      const approved = new Set((await this.d.approvedAgents(account)).map((a) => a.toLowerCase()));
      const next = pending.find((k) => approved.has(k.address.toLowerCase()));
      if (!next) continue;
      const now = this.d.now();
      const previous = user.agentAddress;
      await this.d.vault.setAgentKeyStatus(account, this.d.network, next.address, 'active', now);
      await this.d.vault.setUserAgent(account, `${SEALED_PREFIX}${next.address}`, next.address);
      if (previous && previous.toLowerCase() !== next.address.toLowerCase()) {
        await this.d.vault.setAgentKeyStatus(account, this.d.network, previous, 'retired', now);
        await this.d.vault.wipeAgentKeys(account, this.d.network, now, previous);
      }
      this.d.onKeyChanged(account);
      await this.audit({ account, kind: 'key', why: 'You approved your replacement guard key on Hyperliquid', what: `Guard key replaced; the old key (${previous ?? 'none'}) was wiped`, proof: { address: next.address, previous } });
      promoted++;
    }
    return promoted;
  }

  /** Re-encrypts every live blob under the active master key (after SIGNER_MASTER_KEYS rotation). */
  async resealAll(): Promise<number> {
    if (!this.d.master) return 0;
    const stale = await this.d.vault.sealedKeysNotUnder(this.d.master.activeId, this.d.network);
    for (const k of stale) {
      const blob = resealAgentKey(this.d.master, k.account, this.d.network, k.sealed);
      if (blob) await this.d.vault.replaceSealed(k.account, this.d.network, k.address, blob, this.d.master.activeId, this.d.now());
    }
    return stale.length;
  }

  /** Destroys every sealed key for the account. The guard cannot sign for it afterwards. */
  async wipe(account: string, why: string): Promise<number> {
    const now = this.d.now();
    const n = await this.d.vault.wipeAgentKeys(account, this.d.network, now);
    await this.d.vault.setUserAgent(account, 'wiped', null);
    this.d.onKeyChanged(account);
    await this.audit({ account, kind: 'key', why, what: n ? `Guard key wiped (${n} encrypted key${n > 1 ? 's' : ''} destroyed)` : 'No stored guard key to wipe' });
    return n;
  }
}
