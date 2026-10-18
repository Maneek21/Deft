import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** Current room authority, resolved from canonical rows rather than event payloads. */
export function currentEmployeeSpaceAuthoritySql(orgId: SQLWrapper, employeeId: SQLWrapper, spaceId: SQLWrapper): SQL {
  return sql`exists (
    select 1 from spaces authority_space
    join agent_employees authority_employee
      on authority_employee.id = ${employeeId}
      and authority_employee.org_id = ${orgId}
      and authority_employee.is_active = true and authority_employee.is_deleted = false
    where authority_space.id = ${spaceId} and authority_space.org_id = ${orgId}
      and authority_space.is_archived = false
      and (authority_space.type = 'public' or exists (
        select 1 from space_members authority_member
        where authority_member.space_id = authority_space.id
          and authority_member.user_id = authority_employee.user_id
      ))
  )`;
}

export function currentEmployeeMessageAuthoritySql(orgId: SQLWrapper, employeeId: SQLWrapper, messageId: SQLWrapper): SQL {
  return sql`exists (
    select 1 from messages authority_message
    where authority_message.id = ${messageId} and authority_message.org_id = ${orgId}
      and authority_message.is_deleted = false
      and ${currentEmployeeSpaceAuthoritySql(orgId, employeeId, sql`authority_message.space_id`)}
  )`;
}

/**
 * Approval continuations retain their canonical ancestry. A bounded recursive walk
 * keeps multi-step approvals working, while missing origins, cycles and excessive
 * depth fail closed. The generated durable key locates the action; JSON is never
 * an authorization source.
 */
export function currentUserSpaceAuthoritySql(orgId: SQLWrapper, userId: SQLWrapper, spaceId: SQLWrapper): SQL {
  return sql`exists (select 1 from spaces reader_space
    where reader_space.id = ${spaceId} and reader_space.org_id = ${orgId} and reader_space.is_archived = false
      and (reader_space.type = 'public' or exists (select 1 from space_members reader_member
        where reader_member.space_id = reader_space.id and reader_member.user_id = ${userId})))`;
}

function readerMessageAuthoritySql(orgId: SQLWrapper, userId: SQLWrapper | undefined, messageId: SQLWrapper): SQL {
  return userId ? sql`exists (select 1 from messages reader_message where reader_message.id = ${messageId}
    and reader_message.org_id = ${orgId} and reader_message.is_deleted = false
    and ${currentUserSpaceAuthoritySql(orgId, userId, sql`reader_message.space_id`)})` : sql`true`;
}

function taskVisibleToSql(userId: SQLWrapper): SQL {
  return sql`(coalesce(task.metadata->>'visibility', 'org') <> 'restricted'
    or task.assignee_id = ${userId} or task.created_by = ${userId} or project.lead_id = ${userId}
    or coalesce(task.metadata->'visible_user_ids', '[]'::jsonb) ? ${userId}
    or exists (select 1 from task_watchers watcher where watcher.task_id = task.id and watcher.user_id = ${userId})
    or exists (select 1 from task_assignees assignee where assignee.task_id = task.id and assignee.user_id = ${userId}))`;
}

export function currentAgentChannelEventAuthoritySql(eventId: SQLWrapper, readerUserId?: SQLWrapper): SQL {
  return sql`exists (
    with recursive authority_chain as (
      select root.*, 0 as authority_depth, array[root.id] as authority_path
      from agent_channel_events root where root.id = ${eventId}
      union all
      select origin.*, chain.authority_depth + 1, chain.authority_path || origin.id
      from authority_chain chain
      join agent_actions action on chain.kind = 'approval.resolved'
        and chain.idempotency_key = 'approval.resolved:' || action.id::text || ':' || action.approval_status
        and action.org_id = chain.org_id and action.agent_employee_id = chain.agent_employee_id
      join agent_channel_events origin on origin.id = action.channel_event_id
        and origin.org_id = chain.org_id and origin.agent_employee_id = chain.agent_employee_id
      where chain.authority_depth < 16 and not origin.id = any(chain.authority_path)
    )
    select 1 where exists (select 1 from authority_chain)
      and not exists (
        select 1 from authority_chain chain where (
          exists (select 1 from agent_employees employee
            where employee.id = chain.agent_employee_id and employee.org_id = chain.org_id
              and employee.is_active = true and employee.is_deleted = false)
          and (chain.space_id is null or ${currentEmployeeSpaceAuthoritySql(sql`chain.org_id`, sql`chain.agent_employee_id`, sql`chain.space_id`)})
          and (chain.space_id is null or ${readerUserId ? currentUserSpaceAuthoritySql(sql`chain.org_id`, readerUserId, sql`chain.space_id`) : sql`true`})
          and (case when chain.kind = 'message.created' or chain.source_kind = 'message' then
            chain.source_kind = 'message' and chain.source_id is not null and chain.space_id is not null
            and exists (select 1 from messages source_message
              where source_message.id = chain.source_id and source_message.org_id = chain.org_id
                and source_message.space_id = chain.space_id and source_message.is_deleted = false
                and ${currentEmployeeMessageAuthoritySql(sql`chain.org_id`, sql`chain.agent_employee_id`, sql`chain.source_id`)})
            else true end)
          and (chain.kind not in ('task.assigned', 'task.commented', 'task.status_changed')
            or (chain.source_kind = 'task' and chain.source_id is not null))
          and (case when chain.source_kind = 'task' then exists (
            select 1 from tasks task join projects project on project.id = task.project_id and project.org_id = task.org_id
            join agent_employees employee on employee.id = chain.agent_employee_id and employee.org_id = chain.org_id
            where task.id = chain.source_id and task.org_id = chain.org_id and task.is_deleted = false and project.is_deleted = false
              and (cardinality(coalesce(employee.project_ids, ARRAY[]::text[])) = 0 or task.project_id = any(employee.project_ids))
              and ${taskVisibleToSql(sql`employee.user_id`)}
              and ${readerUserId ? taskVisibleToSql(readerUserId) : sql`true`}
          ) else true end)
          and (case when chain.kind = 'approval.resolved' then exists (
            select 1 from agent_actions action
            where chain.idempotency_key = 'approval.resolved:' || action.id::text || ':' || action.approval_status
              and action.org_id = chain.org_id and action.agent_employee_id = chain.agent_employee_id
              and action.approval_status in ('approved', 'rejected')
              and (action.action <> 'chat_mention' or action.message_id is not null)
              and (action.action <> 'task_assigned' or action.channel_event_id is not null)
              and (action.message_id is null or ${currentEmployeeMessageAuthoritySql(sql`chain.org_id`, sql`chain.agent_employee_id`, sql`action.message_id`)})
              and (action.message_id is null or ${readerMessageAuthoritySql(sql`chain.org_id`, readerUserId, sql`action.message_id`)})
              and (action.channel_event_id is null or (chain.authority_depth < 16 and not action.channel_event_id = any(chain.authority_path)
                and exists (select 1 from agent_channel_events origin where origin.id = action.channel_event_id
                  and origin.org_id = chain.org_id and origin.agent_employee_id = chain.agent_employee_id)))
          ) else true end)
        ) is not true
      )
  )`;
}

export function currentAgentActionSourceAuthoritySql(actionAlias = 'agent_actions', readerUserId?: SQLWrapper): SQL {
  const field = (name: string) => sql`${sql.identifier(actionAlias)}.${sql.identifier(name)}`;
  return sql`(${field('action')} <> 'chat_mention' or ${field('message_id')} is not null)
    and (${field('action')} <> 'task_assigned' or ${field('channel_event_id')} is not null)
    and (${field('message_id')} is null or ${currentEmployeeMessageAuthoritySql(field('org_id'), field('agent_employee_id'), field('message_id'))})
    and (${field('message_id')} is null or ${readerMessageAuthoritySql(field('org_id'), readerUserId, field('message_id'))})
    and (${field('channel_event_id')} is null or exists (
      select 1 from agent_channel_events source_event where source_event.id = ${field('channel_event_id')}
        and source_event.org_id = ${field('org_id')} and source_event.agent_employee_id = ${field('agent_employee_id')}
        and (${field('action')} <> 'task_assigned' or (source_event.kind = 'task.assigned' and source_event.source_kind = 'task'))
        and ${currentAgentChannelEventAuthoritySql(sql`source_event.id`, readerUserId)}
    ))`;
}
