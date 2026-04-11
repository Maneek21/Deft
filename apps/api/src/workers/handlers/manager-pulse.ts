// Handler: manager-pulse — generates daily team health pulse for managers
import type { JobData } from '../types.js';
import { db } from '../../lib/db.js';
import {
  orgs,
  orgMembers,
  managerSettings,
  notifications,
} from '@deft/db/schema';
import { eq, and, sql } from 'drizzle-orm';
import { generateManagerPulse } from '../../services/manager-pulse.js';
import { emitToUser } from '../../socket.js';

export async function handleManagerPulse(job: JobData): Promise<void> {
  console.log(`[manager-pulse] Running manager pulse generation (job ${job.id})`);

  // Query all orgs
  const allOrgs = await db.select().from(orgs);

  for (const org of allOrgs) {
    try {
      // Find managers (owners and admins) in this org
      const managers = await db
        .select({ userId: orgMembers.user_id, role: orgMembers.role })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.org_id, org.id),
            eq(orgMembers.is_active, true),
            sql`${orgMembers.role} IN ('owner', 'admin')`,
          ),
        );

      for (const manager of managers) {
        try {
          // Check manager settings — skip if pulse is off
          const [settings] = await db
            .select()
            .from(managerSettings)
            .where(
              and(
                eq(managerSettings.user_id, manager.userId),
                eq(managerSettings.org_id, org.id),
              ),
            )
            .limit(1);

          if (settings?.team_pulse_frequency === 'off') {
            console.log(`[manager-pulse] Skipping ${manager.userId} — pulse disabled`);
            continue;
          }

          // Generate the pulse
          const result = await generateManagerPulse(manager.userId, org.id);

          // Create notification for the manager
          const redCount = result.healthCards.filter((c) => c.status === 'red').length;
          const yellowCount = result.healthCards.filter((c) => c.status === 'yellow').length;

          let notifTitle = 'Your daily team pulse is ready';
          if (redCount > 0) {
            notifTitle = `Team pulse: ${redCount} member(s) need attention`;
          } else if (yellowCount > 0) {
            notifTitle = `Team pulse: ${yellowCount} member(s) to watch`;
          }

          await db.insert(notifications).values({
            org_id: org.id,
            user_id: manager.userId,
            type: 'system',
            title: notifTitle,
            body: result.summary,
            link: '/manager/pulse',
            metadata: {
              type: 'manager_pulse',
              healthCards: result.healthCards.length,
              redCount,
              yellowCount,
              actionItems: result.actionItems.length,
            },
          });

          // Emit via socket
          emitToUser(manager.userId, 'notification:new', {
            type: 'system',
            title: notifTitle,
            body: result.summary,
          });

          console.log(
            `[manager-pulse] Pulse generated for manager ${manager.userId} in org "${org.name}"`,
          );
        } catch (err) {
          console.error(
            `[manager-pulse] Error generating pulse for manager ${manager.userId}:`,
            (err as Error).message,
          );
        }
      }
    } catch (err) {
      console.error(
        `[manager-pulse] Error processing org ${org.id}:`,
        (err as Error).message,
      );
    }
  }
}
