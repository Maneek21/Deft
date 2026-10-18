import { db } from './db.js';
import { getAppRunRuntime } from './app-run-runtime.js';
import { getEmailMailboxAuthority } from './email-account-authority-router.js';
import { getEmailMailboxRuntime, getEmailNativeTriageService } from './email-mailbox-runtime.js';
import { EmailMailboxCrypto } from './email-mailbox-crypto.js';
import { EmailRuleStore } from './email-rule-store.js';
import { EmailRuleReceiptStore } from './email-rule-receipt-store.js';
import { EmailRuleService } from './email-rule-service.js';
import { EmailRuleExecutionService } from './email-rule-execution.js';
import type { EmailActor } from './email-mailbox-service.js';

/** Human-only rule runtime. There is deliberately no account event listener or
 * automatic dispatcher here; rule execution requires an explicit reviewed token. */
export async function getEmailRuleRuntime(actor: EmailActor) {
  const [{ keys }, mailbox, sqlAuthority] = await Promise.all([
    getAppRunRuntime(), getEmailMailboxRuntime(actor), getEmailMailboxAuthority(db),
  ]);
  const cipher = new EmailMailboxCrypto(keys), ruleStore = new EmailRuleStore(db, cipher);
  const listScoped = async (listActor: EmailActor, scope: Parameters<typeof mailbox.service.list>[1], request: Parameters<typeof mailbox.service.list>[2], signal?: AbortSignal) => {
    const page = await mailbox.service.list(listActor, scope, request, signal);
    return { ...page, items: page.items.map(item => ({ ...item, account_id: page.account_id })) };
  };
  const rules = new EmailRuleService(mailbox.authority, ruleStore, { list: listScoped });
  const receiptStore = new EmailRuleReceiptStore(db, cipher);
  const execution = new EmailRuleExecutionService(sqlAuthority, rules, {
    list: listScoped,
    readMessage: mailbox.store.readMessage.bind(mailbox.store),
  }, receiptStore, cipher, await getEmailNativeTriageService(actor));
  return { rules, execution };
}
