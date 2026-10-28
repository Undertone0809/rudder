use super::*;

pub(in crate::approval_writes) async fn decide_goal(
    tx: &mut Tx<'_>,
    context: &ApprovalWriteContext<'_>,
    approval: &LockedApproval,
    approve: bool,
    input: &Value,
) -> Result<Value> {
    let org = approval.organization_id();
    let proposal = uuid(
        approval.value()["payload"]["proposalId"]
            .as_str()
            .ok_or_else(|| http(422, "Goal change proposal is required"))?,
    )?;
    let row=sqlx::query("SELECT goal_id::text,expected_contract_revision,before_contract,after_contract,rationale,evidence_refs,status,proposed_by_agent_id::text,applied_revision FROM goal_change_proposals WHERE org_id=$1::uuid AND id=$2::uuid AND approval_id=$3::uuid FOR UPDATE")
        .bind(org).bind(&proposal).bind(approval.id()).fetch_optional(&mut **tx).await?.ok_or_else(||http(404,"Goal change proposal not found"))?;
    let goal_id: String = row.try_get("goal_id")?;
    let status: String = row.try_get("status")?;
    let next = if approve { "applied" } else { "rejected" };
    let decision = if approve { "approve" } else { "reject" };
    if status != "pending" && status != next {
        return Err(http(
            409,
            "Only pending Goal change proposals can be decided",
        ));
    }
    let current = crate::goal_writes::lock_goal(tx, org, &goal_id).await?;
    if current.try_get::<String, _>("lifecycle")? != "active" {
        return Err(http(409, "Goal is not active"));
    }
    let expected: i32 = row.try_get("expected_contract_revision")?;
    let current_revision: i32 = current.try_get("contract_revision")?;
    let mut applied: Option<i32> = row.try_get("applied_revision")?;
    if status == "pending" {
        if approve && current_revision != expected {
            let note = input["decisionNote"]
                .as_str()
                .map(|note| {
                    format!("{note}\n\nNot applied because the Goal changed before this decision.")
                })
                .unwrap_or_else(|| {
                    "Not applied because the Goal changed before this decision.".into()
                });
            sqlx::query("UPDATE approvals SET status='cancelled',decision_note=$3,decided_by_user_id=$4,decided_at=now(),updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(approval.id()).bind(note).bind(context.user_id()).execute(&mut **tx).await?;
            sqlx::query("UPDATE goal_change_proposals SET status='superseded',updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(&proposal).execute(&mut **tx).await?;
            return Err(ApprovalWriteError::StaleGoal(
                json!({"expectedContractRevision":expected,"currentContractRevision":current_revision}),
            ));
        }
        if approval.value()["status"] != "pending" {
            return Err(http(409, "Goal change approval is no longer pending"));
        }
        if approve {
            let before: Value = row.try_get("before_contract")?;
            let after: Value = row.try_get("after_contract")?;
            let mut contract = before
                .as_object()
                .cloned()
                .ok_or_else(|| http(422, "Invalid Goal contract"))?;
            contract.extend(
                after
                    .as_object()
                    .cloned()
                    .ok_or_else(|| http(422, "Invalid Goal contract"))?,
            );
            applied = Some(
                crate::goal_writes::apply_approved_goal_contract(
                    tx,
                    approval,
                    &goal_id,
                    expected,
                    &Value::Object(contract),
                )
                .await?,
            );
        }
        sqlx::query("UPDATE approvals SET status=$3,decision_note=$4,decided_by_user_id=$5,decided_at=now(),updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(approval.id()).bind(if approve {"approved"} else {"rejected"}).bind(input["decisionNote"].as_str()).bind(context.user_id()).execute(&mut **tx).await?;
        sqlx::query("UPDATE goal_change_proposals SET status=$3,applied_revision=$4,applied_at=CASE WHEN $3='applied' THEN now() ELSE NULL END,updated_at=now() WHERE org_id=$1::uuid AND id=$2::uuid").bind(org).bind(&proposal).bind(next).bind(applied).execute(&mut **tx).await?;
        let summary = if approve {
            format!(
                "Goal updated after approval: {}",
                row.try_get::<String, _>("rationale")?
            )
        } else {
            format!(
                "Goal change proposal rejected{}",
                input["decisionNote"]
                    .as_str()
                    .map(|note| format!(": {note}"))
                    .unwrap_or_default()
            )
        };
        sqlx::query("INSERT INTO goal_activities (org_id,goal_id,contract_revision,submitted_by_agent_id,agent_owner_ref_at_time,activity_kind,summary,evidence_refs,idempotency_key) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,'decision_requested',$6,$7::jsonb,$8) ON CONFLICT DO NOTHING")
            .bind(org).bind(&goal_id).bind(applied.unwrap_or(current_revision)).bind(row.try_get::<String,_>("proposed_by_agent_id")?).bind(current.try_get::<Option<String>,_>("owner_agent_id_text")?).bind(summary).bind(row.try_get::<Value,_>("evidence_refs")?.to_string()).bind(format!("goal-change:{proposal}:{next}")).execute(&mut **tx).await?;
    }
    let goal = crate::goal_writes::public_goal(tx, org, &goal_id, true).await?;
    let owner = goal["ownerAgentId"]
        .as_str()
        .ok_or_else(|| http(409, "Goal has no Owner Agent to wake"))?;
    let task = format!("goal:{goal_id}:goal_change_decided:{proposal}");
    let mut snapshot = json!({"goalId":goal_id,"taskKey":task,"goal":goal,"goalContinuation":{"kind":goal["continuationKind"],"summary":goal["continuationSummary"],"wakeCondition":goal["wakeCondition"]},"goalDecision":{"proposalId":proposal,"decision":decision,"note":input["decisionNote"],"status":next}});
    let plan:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('revision',revision,'summary',summary,'hypotheses',hypotheses,'selectedPaths',selected_paths,'rejectedPaths',rejected_paths,'sequencing',sequencing,'budgetAllocations',budget_allocations,'invalidationConditions',invalidation_conditions) FROM goal_plans WHERE org_id=$1::uuid AND goal_id=$2::uuid AND revision=$3").bind(org).bind(&goal_id).bind(goal["planRevision"].as_i64().unwrap_or(0) as i32).fetch_optional(&mut **tx).await?;
    snapshot["goalPlan"] = plan.unwrap_or(Value::Null);
    let checkpoint:Option<Value>=sqlx::query_scalar("SELECT jsonb_build_object('id',id,'summary',summary,'evidenceRefs',evidence_refs,'planRevisionBefore',plan_revision_before,'planRevisionAfter',plan_revision_after,'continuationWakeupRequestId',continuation_wakeup_request_id,'continuation',jsonb_build_object('kind',continuation_kind,'summary',continuation_summary,'wakeCondition',wake_condition)) FROM goal_checkpoints WHERE org_id=$1::uuid AND goal_id=$2::uuid ORDER BY created_at DESC LIMIT 1").bind(org).bind(&goal_id).fetch_optional(&mut **tx).await?;
    if let Some(checkpoint) = checkpoint {
        snapshot["goalCheckpoint"] = checkpoint;
    }
    wake(tx,context,approval,owner,"on_demand","goal_change_decided",json!({"event":"goal_change_decided","goalId":goal_id,"taskKey":task,"goalChangeProposalId":proposal,"decision":decision}),snapshot,Some(format!("goal-change-decision:{proposal}:{decision}"))).await?;
    audit(tx,context,org,if approve {"goal.change_approved"} else {"goal.change_rejected"},"goal",&goal_id,json!({"approvalId":approval.id(),"proposalId":proposal,"status":next,"appliedRevision":applied}),Some(&format!("goal-change-decision:{proposal}:{decision}"))).await?;
    audit(
        tx,
        context,
        org,
        if approve {
            "approval.approved"
        } else {
            "approval.rejected"
        },
        "approval",
        approval.id(),
        json!({"type":"goal_change","proposalId":proposal,"status":next,"appliedRevision":applied}),
        Some(&format!("goal-change-approval:{proposal}:{decision}")),
    )
    .await?;
    public_approval(tx, org, approval.id()).await
}
