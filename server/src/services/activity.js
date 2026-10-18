// Activity timeline entries shown on contacts, opportunities and leads (F2.7).
export async function addActivity(db, { workspaceId, contactId, opportunityId, leadId, type, actorId, body, data }) {
  await db.query(
    `INSERT INTO activities (workspace_id, contact_id, opportunity_id, lead_id, type, actor_user_id, body, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [workspaceId, contactId || null, opportunityId || null, leadId || null, type, actorId || null, body || null,
      JSON.stringify(data || {})],
  );
}

