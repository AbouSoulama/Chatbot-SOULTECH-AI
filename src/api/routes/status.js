function mountStatusRoute(app, deps) {
  const { dbGet, getRuntimeStatus } = deps;
  app.get("/api/status", async (req, res) => {
    const orgId = Number(req?.session?.organizationId || 1);
    const count = await dbGet("SELECT COUNT(*) AS count FROM documents WHERE organization_id = ?", [
      orgId,
    ]);
    const runtime = getRuntimeStatus();
    return res.json({
      ok: true,
      documents: Number(count?.count || 0),
      organizationId: orgId,
      ...runtime,
    });
  });
}

module.exports = { mountStatusRoute };
