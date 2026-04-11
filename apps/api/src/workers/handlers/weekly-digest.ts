// Handler: Weekly Digest — generates and delivers weekly digests for all managers
import { db } from '../../lib/db.js';
import {
  orgMembers,
  users,
  orgs,
  managerSettings,
  notifications,
} from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { generateWeeklyDigest } from '../../services/weekly-digest.js';
import { getIO } from '../../socket.js';
import type { JobData } from '../types.js';

export async function handleWeeklyDigest(job: JobData): Promise<void> {
  console.log('[weekly-digest] Starting weekly digest generation');

  // Get all orgs
  const allOrgs = await db.select({ id: orgs.id, name: orgs.name }).from(orgs);

  for (const org of allOrgs) {
    try {
      // Find managers (owners + admins) in this org
      const managers = await db
        .select({
          userId: orgMembers.user_id,
          role: orgMembers.role,
        })
        .from(orgMembers)
        .where(
          and(
            eq(orgMembers.org_id, org.id),
            eq(orgMembers.is_active, true),
          ),
        );

      const managerMembers = managers.filter(
        (m) => m.role === 'owner' || m.role === 'admin',
      );

      for (const manager of managerMembers) {
        try {
          // Check if weekly digest is enabled for this manager
          const [settings] = await db
            .select({ weekly_digest_enabled: managerSettings.weekly_digest_enabled })
            .from(managerSettings)
            .where(
              and(
                eq(managerSettings.user_id, manager.userId),
                eq(managerSettings.org_id, org.id),
              ),
            )
            .limit(1);

          // Default to enabled if no settings exist
          if (settings && !settings.weekly_digest_enabled) {
            continue;
          }

          // Generate digest
          const digest = await generateWeeklyDigest(manager.userId, org.id);

          // Create notification
          const [notification] = await db
            .insert(notifications)
            .values({
              org_id: org.id,
              user_id: manager.userId,
              type: 'system',
              title: 'Weekly Team Digest',
              body: digest.slice(0, 500),
              link: '/dashboard',
              metadata: { digest_full: digest },
            })
            .returning();

          // Emit via socket
          const io = getIO();
          if (io && notification) {
            io.to(`user:${manager.userId}`).emit('notification:new', notification);
          }

          console.log(
            `[weekly-digest] Generated digest for manager ${manager.userId} in org ${org.id}`,
          );
        } catch (err) {
          console.error(
            `[weekly-digest] Failed for manager ${manager.userId}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error(`[weekly-digest] Failed for org ${org.id}:`, err);
    }
  }

  console.log('[weekly-digest] Weekly digest generation complete');
}
