/**
 * Phase 4 — space_memory_get + space_memory_set.
 *
 * Space-scoped key/value bag used by employees to remember per-channel facts.
 * No approval gating: writes are inherently bounded to a single space.
 *
 * Schema is `space_memory` with a uniqueIndex on (space_id, key).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { spaceMemory } from '@deft/db/schema';
import type { ToolContext, ToolResult } from './types.js';
import { errorResult, textResult } from './types.js';
import { employeeCanAccessSpace } from './employee-space-access.js';

// ─── space_memory_get ─────────────────────────────────────────────────────

export type SpaceMemoryGetArgs = {
  caller_employee_slug: string;
  space_id: string;
  key: string;
};

export async function spaceMemoryGet(
  args: SpaceMemoryGetArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.space_id) return errorResult('space_memory_get requires space_id');
  if (!args.key) return errorResult('space_memory_get requires key');

  try {
    if (!(await employeeCanAccessSpace(ctx.employee_id, ctx.org_id, args.space_id))) {
      return errorResult(
        `space_memory_get: space ${args.space_id} is not accessible to this employee`,
      );
    }

    const [row] = await db
      .select({
        key: spaceMemory.key,
        value: spaceMemory.value,
        updated_at: spaceMemory.updated_at,
      })
      .from(spaceMemory)
      .where(
        and(
          eq(spaceMemory.org_id, ctx.org_id),
          eq(spaceMemory.space_id, args.space_id),
          eq(spaceMemory.key, args.key),
        ),
      )
      .limit(1);

    if (!row) return textResult({ key: args.key, value: null, found: false });
    return textResult({
      key: row.key,
      value: row.value,
      updated_at: row.updated_at,
      found: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`space_memory_get failed: ${msg}`);
  }
}

// ─── space_memory_set ─────────────────────────────────────────────────────

export type SpaceMemorySetArgs = {
  caller_employee_slug: string;
  space_id: string;
  key: string;
  value: unknown;
};

export async function spaceMemorySet(
  args: SpaceMemorySetArgs,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (!args.space_id) return errorResult('space_memory_set requires space_id');
  if (!args.key) return errorResult('space_memory_set requires key');
  if (args.value === undefined) {
    return errorResult('space_memory_set requires a defined value');
  }

  try {
    if (!(await employeeCanAccessSpace(ctx.employee_id, ctx.org_id, args.space_id))) {
      return errorResult(
        `space_memory_set: space ${args.space_id} is not accessible to this employee`,
      );
    }

    // Upsert on (space_id, key). Drizzle's onConflictDoUpdate handles this.
    const [row] = await db
      .insert(spaceMemory)
      .values({
        org_id: ctx.org_id,
        space_id: args.space_id,
        key: args.key,
        value: args.value as object,
        updated_by_employee_id: ctx.employee_id,
      })
      .onConflictDoUpdate({
        target: [spaceMemory.space_id, spaceMemory.key],
        set: {
          value: args.value as object,
          updated_by_employee_id: ctx.employee_id,
          updated_at: new Date(),
        },
      })
      .returning({
        id: spaceMemory.id,
        key: spaceMemory.key,
        updated_at: spaceMemory.updated_at,
      });

    return textResult({
      id: row!.id,
      key: row!.key,
      updated_at: row!.updated_at,
      stored: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(`space_memory_set failed: ${msg}`);
  }
}
