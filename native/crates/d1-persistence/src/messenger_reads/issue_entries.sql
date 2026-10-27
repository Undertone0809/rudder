SELECT (to_jsonb(messenger_issue_entry)||jsonb_build_object('_activityCursorRaw',messenger_issue_entry."latestActivityAt",'_attentionRaw',messenger_issue_entry."attentionActivityAt"))::text FROM (
      with tracked_issue_ids as (
        select issues.id as id
        from issues
        where issues.org_id = $1::uuid
          and issues.hidden_at is null
          and issues.assignee_user_id = $2::text
        union
        select issues.id as id
        from issues
        where issues.org_id = $1::uuid
          and issues.hidden_at is null
          and issues.created_by_user_id = $2::text
        union
        select issues.id as id
        from issues
        where issues.org_id = $1::uuid
          and issues.hidden_at is null
          and issues.reviewer_user_id = $2::text
        union
        select issue_follows.issue_id as id
        from issue_follows
        inner join issues followed_issue
          on followed_issue.id = issue_follows.issue_id
          and followed_issue.org_id = issue_follows.org_id
        where issue_follows.org_id = $1::uuid
          and issue_follows.user_id = $2::text
          and followed_issue.hidden_at is null
        union
        select notification_issue.id as id
        from activity_log automation_notification_activity
        inner join issues notification_issue
          on automation_notification_activity.entity_id = notification_issue.id::text
          and notification_issue.org_id = automation_notification_activity.org_id
        where automation_notification_activity.org_id = $1::uuid
          and automation_notification_activity.entity_type = 'issue'
          and automation_notification_activity.action in ('automation.issue_created_notification', 'agent.issue_created_notification')
          and automation_notification_activity.details->>'userId' = $2::text
          and notification_issue.hidden_at is null
      ),
      issue_entries as (
        select
          issue_row.id as id,
          issue_row.title as title,
          issue_row.description as description,
          issue_row.status as status,
          issue_row.priority as priority,
          issue_row.project_id as "projectId",
          project_row.name as "projectName",
          project_row.color as "projectColor",
          issue_row.assignee_agent_id as "assigneeAgentId",
          issue_row.assignee_user_id as "assigneeUserId",
          issue_row.reviewer_user_id as "reviewerUserId",
          issue_row.created_by_user_id as "createdByUserId",
          issue_row.identifier as identifier,
          issue_row.execution_run_id as "executionRunId",
          exists (
            select 1
            from heartbeat_runs active_execution_run
            where active_execution_run.id = issue_row.execution_run_id
              and active_execution_run.org_id = issue_row.org_id
              and active_execution_run.status in ('queued', 'running') AND /* VISIBLE_EXECUTION */
          ) as "hasActiveExecutionRun",
          issue_row.updated_at as "updatedAt",
          exists (
            select 1
            from issue_follows follow_row
            where follow_row.org_id = $1::uuid
              and follow_row.user_id = $2::text
              and follow_row.issue_id = issue_row.id
          ) as followed,
          (issue_row.assignee_user_id = $2::text) as assigned,
          greatest(
            issue_row.created_at,
            coalesce(latest_external_comment.created_at, issue_row.created_at),
            coalesce(latest_activity.created_at, issue_row.created_at)
          ) as "latestActivityAt",
          latest_activity.id as "latestActivityId",
          latest_activity.action as "latestActivityAction",
          latest_activity.actor_type as "latestActivityActorType",
          latest_activity.actor_id as "latestActivityActorId",
          latest_activity.details as "latestActivityDetails",
          latest_activity.created_at as "latestActivityCreatedAt",
          latest_activity.run_id as "latestActivityRunId",
          case
            when latest_external_comment.created_at is not null
              and (latest_external_activity.created_at is null or latest_external_comment.created_at >= latest_external_activity.created_at)
              then latest_external_comment.created_at
            when latest_external_activity.created_at is not null
              then latest_external_activity.created_at
            when latest_activity.id is null
              and (
                latest_suppressed_activity.created_at is null
                or latest_suppressed_activity.created_at < issue_row.updated_at - interval '5 seconds'
              )
              and (
                latest_own_comment.created_at is null
                or latest_own_comment.created_at < issue_row.updated_at - interval '5 seconds'
              )
              and (
                issue_row.assignee_user_id = $2::text
                or (issue_row.reviewer_user_id = $2::text and issue_row.status = 'in_review')
                or exists (
                  select 1
                  from issue_follows attention_follow_row
                  where attention_follow_row.org_id = $1::uuid
                    and attention_follow_row.user_id = $2::text
                    and attention_follow_row.issue_id = issue_row.id
                )
              )
              then issue_row.created_at
            else null
          end as "attentionActivityAt",
          latest_external_comment.body as "latestExternalCommentBody",
          latest_external_comment.created_at as "latestExternalCommentCreatedAt",
          latest_external_activity.id as "latestExternalActivityId",
          latest_external_activity.action as "latestExternalActivityAction",
          latest_external_activity.actor_type as "latestExternalActivityActorType",
          latest_external_activity.actor_id as "latestExternalActivityActorId",
          latest_external_activity.details as "latestExternalActivityDetails",
          latest_external_activity.created_at as "latestExternalActivityCreatedAt",
          latest_external_activity.run_id as "latestExternalActivityRunId"
        from tracked_issue_ids
        inner join issues issue_row
          on issue_row.id = tracked_issue_ids.id
          and (
            issue_row.origin_kind <> 'automation_execution'
            or exists (
              select 1
              from issue_follows automation_follow_row
              where automation_follow_row.org_id = $1::uuid
                and automation_follow_row.user_id = $2::text
                and automation_follow_row.issue_id = issue_row.id
            )
            or exists (
              select 1
              from activity_log automation_notification_visibility
              where automation_notification_visibility.org_id = $1::uuid
                and automation_notification_visibility.entity_type = 'issue'
                and automation_notification_visibility.entity_id = issue_row.id::text
                and automation_notification_visibility.action in ('automation.issue_created_notification', 'agent.issue_created_notification')
                and automation_notification_visibility.details->>'userId' = $2::text
            )
          )
        left join lateral (
          select
            comment_row.body,
            comment_row.created_at
          from issue_comments comment_row
          where comment_row.org_id = $1::uuid
            and comment_row.issue_id = issue_row.id
            and comment_row.deleted_at is null
            and (comment_row.author_user_id is null or comment_row.author_user_id <> $2::text)
          order by comment_row.created_at desc, comment_row.id desc
          limit 1
        ) latest_external_comment on true
        left join lateral (
          select
            comment_row.created_at
          from issue_comments comment_row
          where comment_row.org_id = $1::uuid
            and comment_row.issue_id = issue_row.id
            and comment_row.deleted_at is null
            and comment_row.author_user_id = $2::text
          order by comment_row.created_at desc, comment_row.id desc
          limit 1
        ) latest_own_comment on true
        left join lateral (
          select
            activity_row.id,
            activity_row.action,
            activity_row.actor_type,
            activity_row.actor_id,
            activity_row.details,
            activity_row.created_at,
            activity_row.run_id
          from activity_log activity_row
          where activity_row.org_id = $1::uuid
            and activity_row.entity_type = 'issue'
            and activity_row.entity_id = issue_row.id::text
            and activity_row.action in ('issue.updated','issue.followed','automation.issue_created_notification','agent.issue_created_notification','issue.approval_linked','issue.work_product_created','issue.work_product_updated','issue.work_product_deleted','issue.document_deleted','issue.attachment_added','issue.attachment_removed','heartbeat.cancelled','heartbeat.retried')
            and not (activity_row.action='issue.updated' AND jsonb_typeof(activity_row.details)='object' AND (activity_row.details ? 'title' OR activity_row.details ? 'description') AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(activity_row.details) k(key) WHERE k.key NOT IN ('identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason','title','description')))
            and (
              activity_row.action not in ('automation.issue_created_notification', 'agent.issue_created_notification')
              or activity_row.details->>'userId' = $2::text
            )
          order by activity_row.created_at desc, activity_row.id desc
          limit 1
        ) latest_activity on true
        left join lateral (
          select
            external_activity_row.id,
            external_activity_row.action,
            external_activity_row.actor_type,
            external_activity_row.actor_id,
            external_activity_row.details,
            external_activity_row.created_at,
            external_activity_row.run_id
          from activity_log external_activity_row
          where external_activity_row.org_id = $1::uuid
            and external_activity_row.entity_type = 'issue'
            and external_activity_row.entity_id = issue_row.id::text
            and external_activity_row.action in ('issue.updated','issue.followed','automation.issue_created_notification','agent.issue_created_notification','issue.approval_linked','issue.work_product_created','issue.work_product_updated','issue.work_product_deleted','issue.document_deleted','issue.attachment_added','issue.attachment_removed','heartbeat.cancelled','heartbeat.retried')
            and not (external_activity_row.action='issue.updated' AND jsonb_typeof(external_activity_row.details)='object' AND (external_activity_row.details ? 'title' OR external_activity_row.details ? 'description') AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(external_activity_row.details) k(key) WHERE k.key NOT IN ('identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason','title','description')))
            and (external_activity_row.actor_type <> 'user' or external_activity_row.actor_id <> $2::text)
            and (
              external_activity_row.action not in ('automation.issue_created_notification', 'agent.issue_created_notification')
              or external_activity_row.details->>'userId' = $2::text
            )
          order by external_activity_row.created_at desc, external_activity_row.id desc
          limit 1
        ) latest_external_activity on true
        left join lateral (
          select suppressed_activity_row.created_at
          from activity_log suppressed_activity_row
          where suppressed_activity_row.org_id = $1::uuid
            and suppressed_activity_row.entity_type = 'issue'
            and suppressed_activity_row.entity_id = issue_row.id::text
            and suppressed_activity_row.action in ('issue.updated','issue.followed','automation.issue_created_notification','agent.issue_created_notification','issue.approval_linked','issue.work_product_created','issue.work_product_updated','issue.work_product_deleted','issue.document_deleted','issue.attachment_added','issue.attachment_removed','heartbeat.cancelled','heartbeat.retried')
            and (suppressed_activity_row.action='issue.updated' AND jsonb_typeof(suppressed_activity_row.details)='object' AND (suppressed_activity_row.details ? 'title' OR suppressed_activity_row.details ? 'description') AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(suppressed_activity_row.details) k(key) WHERE k.key NOT IN ('identifier','issueIdentifier','_previous','_references','source','reopened','reopenedFrom','normalizedFromStatus','normalizedReason','title','description')))
          order by suppressed_activity_row.created_at desc, suppressed_activity_row.id desc
          limit 1
        ) latest_suppressed_activity on true
        left join projects project_row
          on project_row.id = issue_row.project_id
          and project_row.org_id = issue_row.org_id
      )
      select *
      from issue_entries

) messenger_issue_entry ORDER BY messenger_issue_entry."latestActivityAt" DESC,messenger_issue_entry.id ASC
